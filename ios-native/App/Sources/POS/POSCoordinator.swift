import Foundation
import Observation
#if canImport(ProximityReader)
import ProximityReader
#endif
import LashKirjaCore

/// What this install can do for Tap to Pay.
enum POSDevice {
    static var capability: POSDeviceCapability {
        POSDeviceCapability(supportsTapToPay: supportsTapToPay, hasEntitlement: hasEntitlement)
    }

    /// The simulator runs Stripe's simulated Tap to Pay reader (test mode), so it counts as supported.
    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    /// iPhone XS or newer (Apple's own check; it does not look at the iOS version).
    static var supportsTapToPay: Bool {
        #if canImport(ProximityReader) && !targetEnvironment(simulator)
        return PaymentCardReader.isSupported
        #else
        return isSimulator
        #endif
    }

    /// Set at build time: only the signed Release-Signed build carries the entitlement
    /// (`LK_TAP_TO_PAY_ENTITLEMENT` → Info.plist `LKTapToPayEntitlement`).
    static var hasEntitlement: Bool {
        if isSimulator { return true }
        return (Bundle.main.object(forInfoDictionaryKey: "LKTapToPayEntitlement") as? String) == "YES"
    }
}

/// Takes one card payment at a time for an invoice: server PaymentIntent → Tap to Pay reader →
/// `processPaymentIntent` → server finalize. Shared, because Stripe Terminal is a process-wide
/// singleton and an unfinished payment must outlive its sheet (reopening the sheet continues the
/// same PaymentIntent instead of making a second one).
@MainActor
@Observable
final class POSCoordinator {
    static let shared = POSCoordinator()

    private(set) var status: POSStatus?
    private(set) var machine = POSPaymentMachine(idempotencyKey: UUID().uuidString)
    private(set) var invoiceId: String?
    /// The reader's own prompt, in Finnish ("Kokeile toista korttia").
    private(set) var readerMessage: String?
    /// 0…1 while the reader installs a software update.
    private(set) var updateProgress: Double?
    /// Said once on the idle screen after the payment was dropped ("Maksu peruttiin…").
    private(set) var notice: String?
    /// The invoice as the server returned it after recording the payment.
    private(set) var recordedInvoice: Invoice?
    /// The reader kind this flow drives; only Tap to Pay in v1.
    let readerKind: POSReaderKind = .tapToPay
    /// The owner's Testitila switch on this device (stored per owner). It counts only while the
    /// server says its Stripe key is a test key; see `simulationActive`.
    private(set) var testModeChosen = false
    /// The simulated reader in use (or last connected) while Testitila is on.
    private(set) var simulatedReader: POSSimulatedReader?
    /// The card Stripe's simulator presents on the next test payment.
    var testCard: POSTestCard = .defaultCard

    /// Simulated reader and test cards: only with a server test key and the owner's switch on.
    /// A live key ignores the stored switch.
    var simulationActive: Bool { POSTestMode.isActive(status: status, ownerEnabled: testModeChosen) }

    /// The simulated reader the next connect starts with.
    var expectedSimulatedReader: POSSimulatedReader { simulatedReader ?? (tapToPaySimulatorRefused ? .bluetooth : .tapToPay) }

    var phase: POSPaymentPhase { machine.phase }

    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var userId: String?
    @ObservationIgnored private let tokenClient = StripeConnectionTokenProvider()
    /// A Stripe PaymentIntent, opaque here: the SDK is loaded on demand (StripeTerminalLoader).
    @ObservationIgnored private var sdkIntent: NSObject?
    @ObservationIgnored private var finalizeAttempts = 0
    /// Bumped when a payment session is dropped: a step still running for the old one (a late
    /// finalize answer) must not move the new one.
    @ObservationIgnored private var generation = 0
    /// Stripe refused the simulated Tap to Pay reader on this install (no entitlement): later test
    /// payments in this app run go straight to the simulated Bluetooth reader.
    @ObservationIgnored private var tapToPaySimulatorRefused = false

    private init() {}

    /// The SDK once a card payment has loaded and started it; nil before.
    private var loadedTerminal: StripeTerminalDriving? {
        guard let driver = StripeTerminalLoader.loaded, driver.isInitialized else { return nil }
        return driver
    }

    // MARK: Session and status

    /// Binds the coordinator to the signed-in owner. Another owner's reader session and cached
    /// credentials are dropped first, so a token for one Stripe account never serves another.
    func bind(_ app: AppModel) {
        guard case .signedIn(let user) = app.phase else { return }
        api = app.api
        tokenClient.api = app.api
        guard userId != user.userId else { return }
        let switching = userId != nil
        userId = user.userId
        status = nil
        testModeChosen = UserDefaults.standard.bool(forKey: POSTestMode.key(userId: user.userId))
        simulatedReader = nil
        testCard = .defaultCard
        resetPayment()
        if switching { loadedTerminal?.disconnectAndClearCredentials() }
    }

    /// `GET /api/pos/status`; a server without Stripe (503) reads as not enabled.
    @discardableResult
    func refreshStatus() async -> POSStatus {
        guard let api else { return status ?? .unavailable }
        do {
            let fresh: POSStatusEnvelope = try await api.get("/api/pos/status")
            update(status: fresh.status)
        } catch let error as LKError where error.status == 503 || error.status == 404 {
            update(status: .unavailable)
        } catch {
            // Offline: keep what was known.
        }
        return status ?? .unavailable
    }

    /// Asetukset → Maksut: turns Testitila on or off for the signed-in owner. The connected reader
    /// (simulated or real) is let go so the next payment connects the right kind.
    func setTestMode(_ on: Bool) {
        guard let userId, !phase.isBusy else { return }
        UserDefaults.standard.set(on, forKey: POSTestMode.key(userId: userId))
        guard on != testModeChosen else { return }
        testModeChosen = on
        simulatedReader = nil
        testCard = .defaultCard
        if loadedTerminal != nil { Task { await disconnectIfConnected() } }
    }

    func update(status new: POSStatus) {
        status = new
        // Lazily: with the payment sheet open, and only for an account that can ask for connection
        // tokens. Opening an invoice (its status check) does not load the SDK.
        if invoiceId != nil && new.enabled && new.account.connected { _ = startedTerminal() }
    }

    /// The SDK, loaded and started on first use; nil when this install cannot load it.
    private func startedTerminal() -> StripeTerminalDriving? {
        guard let driver = StripeTerminalLoader.driver() else { return nil }
        let tokens = tokenClient
        driver.start(fetchToken: { completion in tokens.fetchConnectionToken(completion) }, events: { [weak self] kind, value, text in
            Task { @MainActor in self?.readerEvent(kind, value: value, text: text) }
        })
        return driver
    }

    // MARK: Payment session

    /// Opens the sheet for `invoice`: an unfinished payment for the same invoice continues (its
    /// PaymentIntent may already hold the customer's money); anything else starts fresh.
    func begin(invoiceId: String) {
        let resumable = self.invoiceId == invoiceId && !machine.amountEditable && !machine.isFinished
        if !resumable { resetPayment() }
        self.invoiceId = invoiceId
        if let status, status.enabled && status.account.connected { _ = startedTerminal() }
    }

    /// After a finished payment (Valmis) or a sheet closed with nothing in flight.
    func endIfSettled() {
        if machine.isFinished || machine.amountEditable { resetPayment() }
    }

    private func resetPayment() {
        generation += 1
        machine = POSPaymentMachine(idempotencyKey: UUID().uuidString)
        invoiceId = nil
        sdkIntent = nil
        StripeTerminalLoader.loaded?.forgetRunning()
        readerMessage = nil
        updateProgress = nil
        notice = nil
        recordedInvoice = nil
        finalizeAttempts = 0
    }

    func pay(amount: Decimal) {
        notice = nil
        feed(.start(amount: amount, newKey: machine.keySpent ? UUID().uuidString : nil))
    }

    func retry() {
        notice = nil
        finalizeAttempts = 0
        feed(.retry)
    }

    func cancel() { feed(.cancel) }

    /// The owner gives up after a card that was clearly not charged (declined, unreadable, offline
    /// PIN): the PaymentIntent is canceled so the next payment starts clean. A lost answer is never
    /// abandoned this way; it stays until the server has said what happened.
    func abandonIfUncharged() {
        guard case .failed(let failure) = machine.phase, machine.payment != nil, !failure.uncertain else { return }
        let uncharged: Set<POSFailure.Kind> = [.declined, .offlinePinRequired, .cardNotRead]
        guard uncharged.contains(failure.kind) else { return }
        feed(.failed(.make(.canceled)))
    }

    private func feed(_ event: POSPaymentMachine.Event, gen: Int? = nil) {
        if let gen, gen != generation { return }
        guard let command = machine.send(event) else { return }
        let current = generation
        Task { await execute(command, gen: current) }
    }

    private func execute(_ command: POSPaymentMachine.Command, gen: Int) async {
        switch command {
        case .createPayment(let key): await createPayment(key: key, gen: gen)
        case .connectReader: await connectReader(gen: gen)
        case .process: await process(gen: gen)
        case .finalize: await finalize(gen: gen)
        case .cancelCollection: cancelCollection(gen: gen)
        case .cancelIntent: await cancelIntent(gen: gen)
        }
    }

    // MARK: Steps

    private func createPayment(key: String, gen: Int) async {
        guard let api, let invoiceId, let amount = machine.amount else { return }
        do {
            let response: POSCreatedPaymentResponse = try await api.send(
                "POST", "/api/pos/payment-intents", body: POSPaymentIntentRequest(invoiceId: invoiceId, amount: amount), idempotencyKey: key)
            guard gen == generation else { return }
            sdkIntent = nil
            feed(.paymentCreated(response.payment), gen: gen)
        } catch {
            feed(.failed(Self.serverFailure(error)), gen: gen)
        }
    }

    private func connectReader(gen: Int) async {
        guard let payment = machine.payment else { return }
        guard let locationId = payment.locationId ?? status?.locationId else {
            feed(.failed(.make(.rejected, message: POSMissing.location.detail)), gen: gen)
            return
        }
        guard let terminal = startedTerminal() else {
            feed(.failed(.make(.other)), gen: gen)
            return
        }
        readerMessage = nil
        if simulationActive {
            await connectSimulated(terminal, locationId: locationId, gen: gen)
            return
        }
        if let kind = terminal.connectedReaderKind {
            // A reader left from Testitila is never used for a real payment.
            if kind == "tapToPay" && terminal.connectedReaderSimulated == POSDevice.isSimulator {
                feed(.readerConnected, gen: gen)
                return
            }
            await disconnectIfConnected()
        }
        do {
            try await connect(terminal, kind: "tapToPay", simulated: POSDevice.isSimulator, locationId: locationId)
            feed(.readerConnected, gen: gen)
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    /// Discovers and connects a reader of `kind` ("tapToPay" or "bluetooth").
    private func connect(_ terminal: StripeTerminalDriving, kind: String, simulated: Bool, locationId: String) async throws {
        let error: Error? = await withCheckedContinuation { continuation in
            terminal.connect(kind: kind, simulated: simulated, locationId: locationId) { continuation.resume(returning: $0) }
        }
        if let error { throw Self.flowError(error) }
    }

    /// The driver's own failures (no reader, no answer) as this flow names them.
    private static func flowError(_ error: Error) -> Error {
        let ns = error as NSError
        guard ns.domain == StripeDriverError.domain else { return error }
        return ns.code == StripeDriverError.noResult ? POSFlowError.noResult : POSFlowError.noReader
    }

    // MARK: Testitila (simulated readers)

    /// Stripe's simulated Tap to Pay reader first; when Stripe refuses it (an install without the
    /// Tap to Pay entitlement, an older iPhone), its simulated Bluetooth WisePad 3.
    private func connectSimulated(_ terminal: StripeTerminalDriving, locationId: String, gen: Int) async {
        if let kind = terminal.connectedReaderKind {
            let fits = terminal.connectedReaderSimulated
                && ((simulatedReader == .tapToPay && kind == "tapToPay")
                    || (simulatedReader == .bluetooth && kind != "tapToPay"))
            if fits {
                feed(.readerConnected, gen: gen)
                return
            }
            await disconnectIfConnected()
        }
        do {
            if !tapToPaySimulatorRefused {
                do {
                    try await connect(terminal, kind: "tapToPay", simulated: true, locationId: locationId)
                    guard gen == generation else { return }
                    simulatedReader = .tapToPay
                    feed(.readerConnected, gen: gen)
                    return
                } catch {
                    let ns = error as NSError
                    let refused = ns.domain != NSURLErrorDomain
                        && (error is POSFlowError || POSSimulatedReader.fallsBackToBluetooth(errorCode: ns.code))
                    guard refused else { throw error }
                    tapToPaySimulatorRefused = true
                    terminal.forgetRunning()
                    await disconnectIfConnected()
                }
            }
            // The driver picks the WisePad 3 (the one Stripe sells in Finland) among the simulated ones.
            try await connect(terminal, kind: "bluetooth", simulated: true, locationId: locationId)
            guard gen == generation else { return }
            simulatedReader = .bluetooth
            feed(.readerConnected, gen: gen)
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    private func disconnectIfConnected() async {
        guard let terminal = loadedTerminal, terminal.connectedReaderKind != nil else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            terminal.disconnect { continuation.resume() }
        }
    }

    /// The card Stripe's simulator presents next; set before every test payment (Stripe resets it
    /// after a payment).
    private func applyTestCard(_ terminal: StripeTerminalDriving) {
        let reader = simulatedReader ?? .tapToPay
        if !testCard.isSupported(on: reader) { testCard = .defaultCard }
        terminal.setSimulatedCard(testCard.rawValue)
    }

    private func process(gen: Int) async {
        guard let payment = machine.payment else { return }
        guard let terminal = startedTerminal() else {
            feed(.failed(.make(.other)), gen: gen)
            return
        }
        do {
            let intent: NSObject
            if let held = sdkIntent, terminal.intentId(held) == payment.paymentIntentId {
                intent = held
            } else {
                intent = try await retrieve(clientSecret: payment.clientSecret)
            }
            // Canceled (or a new session) while the intent loaded: do not open the card reader.
            guard gen == generation, machine.phase == .readyForCard || machine.phase == .waitingForCard else { return }
            sdkIntent = intent
            // Already charged (a lost answer before): only the server's check remains.
            if Self.charged(terminal.intentStatus(intent)) {
                feed(.cardRead, gen: gen)
                feed(.processed, gen: gen)
                return
            }
            if simulationActive, terminal.connectedReaderSimulated { applyTestCard(terminal) }
            let result: Result<NSObject, Error> = await withCheckedContinuation { continuation in
                terminal.processPaymentIntent(intent) { processed, error in
                    if let processed { continuation.resume(returning: .success(processed)) }
                    else { continuation.resume(returning: .failure(Self.flowError(error ?? POSFlowError.noResult))) }
                }
            }
            guard gen == generation else { return }
            readerMessage = nil
            switch result {
            case .success(let processed):
                sdkIntent = processed
                feed(.cardRead, gen: gen)
                feed(.processed, gen: gen)
            case .failure(let error):
                // processPaymentIntent fails with a ConfirmPaymentIntentError when the intent was reached.
                if let updated = terminal.intent(in: error) {
                    sdkIntent = updated
                }
                feed(.failed(Self.sdkFailure(error)), gen: gen)
            }
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    private func retrieve(clientSecret: String) async throws -> NSObject {
        guard let terminal = startedTerminal() else { throw POSFlowError.noResult }
        return try await withCheckedThrowingContinuation { continuation in
            terminal.retrievePaymentIntent(clientSecret: clientSecret) { intent, error in
                if let intent { continuation.resume(returning: intent) }
                else { continuation.resume(throwing: Self.flowError(error ?? POSFlowError.noResult)) }
            }
        }
    }

    /// The card was taken (or is being): only the server's check remains.
    private static func charged(_ status: String) -> Bool {
        status == "succeeded" || status == "processing" || status == "requiresCapture"
    }

    /// Asks the server to check the PaymentIntent with Stripe; only its "succeeded" counts.
    private func finalize(gen: Int) async {
        guard let api, let payment = machine.payment else { return }
        do {
            let response: POSFinalizeResponse = try await api.send("POST", "/api/pos/payments/\(payment.id)/finalize", body: EmptyBody())
            guard gen == generation else { return }
            switch response.payment.status {
            case "succeeded", "partially_refunded", "refunded":
                recordedInvoice = response.invoice
                let label = response.payment.cardLabel ?? sdkCardLabel
                // A test payment is not booked: the sheet says so instead of "kirjattu".
                let receipt = POSReceipt(amount: response.payment.amount, cardLabel: label, testPayment: response.isTestPayment)
                feed(.finalized(succeeded: true, receipt: receipt), gen: gen)
                return
            case "canceled":
                dropIntent(notice: "Maksu peruttiin Stripessä. Korttia ei veloitettu.", gen: gen)
                return
            default:
                break
            }
        } catch let error as LKError where error.status == 409 || error.status == 0 || error.status >= 500 {
            // Not settled yet, or the answer was lost: check the same intent again below.
        } catch is CancellationError {
        } catch {
            feed(.failed(.make(.network, message: error.userMessage)), gen: gen)
            return
        }
        await notYetFinal(payment, gen: gen)
    }

    private func notYetFinal(_ payment: POSCreatedPayment, gen: Int) async {
        finalizeAttempts += 1
        let charged = sdkIntent.flatMap { intent in loadedTerminal.map { Self.charged($0.intentStatus(intent)) } } ?? false
        if !charged, let intent = try? await retrieve(clientSecret: payment.clientSecret) {
            guard gen == generation else { return }
            sdkIntent = intent
            let status = loadedTerminal?.intentStatus(intent)
            if status == "requiresPaymentMethod" || status == "requiresConfirmation" {
                // Nothing was taken: collect again on the same PaymentIntent.
                feed(.notCharged, gen: gen)
                return
            }
        }
        if finalizeAttempts >= 5 {
            if charged {
                feed(.verificationPending(POSReceipt(amount: payment.amount, cardLabel: sdkCardLabel)), gen: gen)
            } else {
                feed(.failed(.make(.network, message: "Maksun tilaa ei saatu vahvistettua. Tarkista se uudelleen; korttia ei veloiteta kahdesti.")), gen: gen)
            }
            return
        }
        try? await Task.sleep(nanoseconds: UInt64(1_000_000_000) << UInt64(min(finalizeAttempts - 1, 3)))
        feed(.finalized(succeeded: false, receipt: nil), gen: gen)
    }

    private func cancelCollection(gen: Int) {
        if StripeTerminalLoader.loaded?.cancelRunning() != true {
            // Between steps: nothing on the reader to stop.
            feed(.failed(.make(.canceled)), gen: gen)
        }
    }

    private func cancelIntent(gen: Int) async {
        if let api, let payment = machine.payment {
            // Nothing was charged; a failed cancel leaves an intent that can never be captured.
            do { let _: Ignored = try await api.send("POST", "/api/pos/payments/\(payment.id)/cancel", body: EmptyBody()) } catch {}
        }
        dropIntent(notice: nil, gen: gen)
    }

    private func dropIntent(notice: String?, gen: Int) {
        guard gen == generation else { return }
        sdkIntent = nil
        finalizeAttempts = 0
        feed(.intentCanceled, gen: gen)
        self.notice = notice
    }

    private var sdkCardLabel: String? {
        guard let intent = sdkIntent, let parts = loadedTerminal?.cardLabelParts(intent), parts.count == 2 else { return nil }
        return POSCard.label(brand: parts[0], last4: parts[1])
    }

    // MARK: Reader events (from the driver, on the main actor)

    private func readerEvent(_ kind: String, value: Double, text: String?) {
        switch kind {
        case StripeDriverEvent.waitingForInput, StripeDriverEvent.readerInput:
            readerMessage = nil
            if machine.phase == .readyForCard { _ = machine.send(.waitingForCard) }
        case StripeDriverEvent.processing:
            if machine.phase == .readyForCard || machine.phase == .waitingForCard { _ = machine.send(.cardRead) }
        case StripeDriverEvent.updateStarted:
            updateProgress = 0
            readerMessage = "Päivitetään Tap to Pay -ohjelmistoa…"
        case StripeDriverEvent.updateProgress:
            updateProgress = value
        case StripeDriverEvent.updateFinished:
            updateProgress = nil
            readerMessage = nil
        case StripeDriverEvent.reconnecting:
            readerMessage = value > 0 ? "Yhteys katkesi, yhdistetään uudelleen…" : nil
        default:
            if kind.hasPrefix(StripeDriverEvent.messagePrefix) {
                readerMessage = Self.finnish(String(kind.dropFirst(StripeDriverEvent.messagePrefix.count)), sdkText: text)
            }
        }
    }

    // MARK: Errors

    static func serverFailure(_ error: Error) -> POSFailure {
        guard let error = error as? LKError else { return .make(.network) }
        if error.status == 0 { return .make(.network, message: error.message) }
        return .make(.rejected, message: error.message)
    }

    static func sdkFailure(_ error: Error) -> POSFailure {
        if let flow = error as? POSFlowError { return .make(flow == .noReader ? .readerDisconnected : .other) }
        // Also the server's answer the SDK wrapped (a connection token refused with 429, say):
        // shown as is, and nothing retries it on its own; the owner taps "Yritä uudelleen".
        if let server = POSErrorMapping.serverError(in: error) { return serverFailure(server) }
        let ns = error as NSError
        // Stripe's codes are positive (SCPErrors.h); a URL error here means the network went away.
        if ns.domain == NSURLErrorDomain { return .make(.network) }
        return POSErrorMapping.failure(code: ns.code, declineCode: declineCode(error))
    }

    /// The card network's reason, wherever this SDK version puts it.
    private static func declineCode(_ error: Error) -> String? {
        if let code = StripeTerminalLoader.loaded?.declineCode(in: error) { return code }
        // Fall back to any decline code string in userInfo.
        return (error as NSError).userInfo.values.lazy
            .compactMap { $0 as? String }
            .first { POSErrorMapping.offlinePinDeclineCodes.contains($0) }
    }

    /// The reader's prompt (a ReaderDisplayMessage case name) in Finnish; any other as the SDK says it.
    static func finnish(_ message: String, sdkText: String?) -> String? {
        switch message {
        case "retryCard": "Yritä korttia uudelleen."
        case "insertCard": "Aseta kortti lukijaan."
        case "insertOrSwipeCard": "Aseta tai vedä kortti."
        case "swipeCard": "Vedä kortti."
        case "removeCard": "Poista kortti."
        case "multipleContactlessCardsDetected": "Useita kortteja havaittiin. Näytä vain yksi kortti."
        case "tryAnotherReadMethod": "Korttia ei voitu lukea. Yritä uudelleen."
        case "tryAnotherCard": "Kokeile toista korttia."
        case "cardRemovedTooEarly": "Kortti poistettiin liian aikaisin. Yritä uudelleen."
        default: sdkText
        }
    }
}

enum POSFlowError: Error, Equatable { case noReader, noResult }
