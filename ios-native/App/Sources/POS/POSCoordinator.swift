import Foundation
import Observation
import StripeTerminal
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
    @ObservationIgnored private let tokenProvider = StripeConnectionTokenProvider()
    @ObservationIgnored private var bridgeStorage: TerminalBridge?
    @ObservationIgnored private var sdkIntent: PaymentIntent?
    @ObservationIgnored private var collectCancelable: Cancelable?
    @ObservationIgnored private var discoverCancelable: Cancelable?
    @ObservationIgnored private var finalizeAttempts = 0
    /// Bumped when a payment session is dropped: a step still running for the old one (a late
    /// finalize answer) must not move the new one.
    @ObservationIgnored private var generation = 0
    /// Stripe refused the simulated Tap to Pay reader on this install (no entitlement): later test
    /// payments in this app run go straight to the simulated Bluetooth reader.
    @ObservationIgnored private var tapToPaySimulatorRefused = false

    private init() {}

    /// Made on first use (it needs `self`); kept for the app's life because Stripe holds it weakly.
    private var bridge: TerminalBridge {
        if let bridgeStorage { return bridgeStorage }
        let made = TerminalBridge(owner: self)
        bridgeStorage = made
        return made
    }

    // MARK: Session and status

    /// Binds the coordinator to the signed-in owner. Another owner's reader session and cached
    /// credentials are dropped first, so a token for one Stripe account never serves another.
    func bind(_ app: AppModel) {
        guard case .signedIn(let user) = app.phase else { return }
        api = app.api
        tokenProvider.api = app.api
        guard userId != user.userId else { return }
        let switching = userId != nil
        userId = user.userId
        status = nil
        testModeChosen = UserDefaults.standard.bool(forKey: POSTestMode.key(userId: user.userId))
        simulatedReader = nil
        testCard = .defaultCard
        resetPayment()
        if switching && Terminal.isInitialized() {
            Terminal.shared.disconnectReader { _ in
                Task { @MainActor in _ = Terminal.shared.clearCachedCredentials() }
            }
        }
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
        if Terminal.isInitialized() { Task { await disconnectIfConnected() } }
    }

    func update(status new: POSStatus) {
        status = new
        // Lazily, and only for an account that can ask for connection tokens.
        if new.enabled && new.account.connected { initTerminalIfNeeded() }
    }

    private func initTerminalIfNeeded() {
        if !Terminal.isInitialized() {
            Terminal.initWithTokenProvider(tokenProvider)
        }
        Terminal.shared.delegate = bridge
    }

    // MARK: Payment session

    /// Opens the sheet for `invoice`: an unfinished payment for the same invoice continues (its
    /// PaymentIntent may already hold the customer's money); anything else starts fresh.
    func begin(invoiceId: String) {
        let resumable = self.invoiceId == invoiceId && !machine.amountEditable && !machine.isFinished
        if !resumable { resetPayment() }
        self.invoiceId = invoiceId
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
        collectCancelable = nil
        discoverCancelable = nil
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
        initTerminalIfNeeded()
        readerMessage = nil
        if simulationActive {
            await connectSimulated(locationId: locationId, gen: gen)
            return
        }
        if Terminal.shared.connectionStatus == .connected, let connected = Terminal.shared.connectedReader {
            // A reader left from Testitila is never used for a real payment.
            if connected.deviceType == .tapToPay && connected.simulated == POSDevice.isSimulator {
                feed(.readerConnected, gen: gen)
                return
            }
            await disconnectIfConnected()
        }
        do {
            let reader = try await discoverReader()
            try await connect(reader, locationId: locationId)
            feed(.readerConnected, gen: gen)
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    private func discoverReader() async throws -> Reader {
        let config = try TapToPayDiscoveryConfigurationBuilder().setSimulated(POSDevice.isSimulator).build()
        return try await withCheckedThrowingContinuation { continuation in
            let once = ResumeOnce(continuation)
            bridge.onDiscovered = { readers in
                if let first = readers.first { once.resume(.success(first)) }
            }
            discoverCancelable = Terminal.shared.discoverReaders(config, delegate: bridge) { error in
                // Called again (with nil) when a connect ends discovery; only the first answer counts.
                once.resume(.failure(error ?? POSFlowError.noReader))
            }
        }
    }

    private func connect(_ reader: Reader, locationId: String) async throws {
        let config = try TapToPayConnectionConfigurationBuilder(delegate: bridge, locationId: locationId).build()
        let _: Reader = try await withCheckedThrowingContinuation { continuation in
            Terminal.shared.connectReader(reader, connectionConfig: config) { connected, error in
                if let connected { continuation.resume(returning: connected) }
                else { continuation.resume(throwing: error ?? POSFlowError.noReader) }
            }
        }
        discoverCancelable = nil
    }

    // MARK: Testitila (simulated readers)

    /// Stripe's simulated Tap to Pay reader first; when Stripe refuses it (an install without the
    /// Tap to Pay entitlement, an older iPhone), its simulated Bluetooth WisePad 3.
    private func connectSimulated(locationId: String, gen: Int) async {
        if let connected = Terminal.shared.connectedReader, Terminal.shared.connectionStatus == .connected {
            let fits = connected.simulated
                && ((simulatedReader == .tapToPay && connected.deviceType == .tapToPay)
                    || (simulatedReader == .bluetooth && connected.deviceType != .tapToPay))
            if fits {
                feed(.readerConnected, gen: gen)
                return
            }
            await disconnectIfConnected()
        }
        do {
            if !tapToPaySimulatorRefused {
                do {
                    let config = try TapToPayDiscoveryConfigurationBuilder().setSimulated(true).build()
                    let reader = try await discover(config) { $0.first }
                    try await connect(reader, locationId: locationId)
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
                    discoverCancelable = nil
                    await disconnectIfConnected()
                }
            }
            let config = try BluetoothScanDiscoveryConfigurationBuilder().setSimulated(true).build()
            // The simulator offers several Bluetooth readers; the WisePad 3 is the one Stripe sells in Finland.
            let reader = try await discover(config) { readers in readers.first { $0.deviceType == .wisePad3 } ?? readers.first }
            let connection = try BluetoothConnectionConfigurationBuilder(delegate: bridge, locationId: locationId).build()
            try await connect(reader, config: connection)
            guard gen == generation else { return }
            simulatedReader = .bluetooth
            feed(.readerConnected, gen: gen)
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    private func discover(_ config: DiscoveryConfiguration, pick: @escaping ([Reader]) -> Reader?) async throws -> Reader {
        try await withCheckedThrowingContinuation { continuation in
            let once = ResumeOnce(continuation)
            bridge.onDiscovered = { readers in
                if let chosen = pick(readers) { once.resume(.success(chosen)) }
            }
            discoverCancelable = Terminal.shared.discoverReaders(config, delegate: bridge) { error in
                once.resume(.failure(error ?? POSFlowError.noReader))
            }
        }
    }

    private func connect(_ reader: Reader, config: ConnectionConfiguration) async throws {
        let _: Reader = try await withCheckedThrowingContinuation { continuation in
            Terminal.shared.connectReader(reader, connectionConfig: config) { connected, error in
                if let connected { continuation.resume(returning: connected) }
                else { continuation.resume(throwing: error ?? POSFlowError.noReader) }
            }
        }
        discoverCancelable = nil
    }

    private func disconnectIfConnected() async {
        guard Terminal.isInitialized(), Terminal.shared.connectionStatus == .connected else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Terminal.shared.disconnectReader { _ in continuation.resume() }
        }
    }

    /// The card Stripe's simulator presents next; set before every test payment (Stripe resets it
    /// after a payment).
    private func applyTestCard() {
        let reader = simulatedReader ?? .tapToPay
        if !testCard.isSupported(on: reader) { testCard = .defaultCard }
        Terminal.shared.simulatorConfiguration.simulatedCard = SimulatedCard(type: Self.sdkCardType(testCard))
    }

    static func sdkCardType(_ card: POSTestCard) -> SimulatedCardType {
        switch card {
        case .visa: .visa
        case .mastercard: .mastercard
        case .declined: .chargeDeclined
        case .insufficientFunds: .chargeDeclinedInsufficientFunds
        case .expired: .chargeDeclinedExpiredCard
        case .processingError: .chargeDeclinedProcessingError
        case .offlinePin: .offlinePinScaRetry
        }
    }

    private func process(gen: Int) async {
        guard let payment = machine.payment else { return }
        do {
            let intent: PaymentIntent
            if let held = sdkIntent, held.stripeId == payment.paymentIntentId {
                intent = held
            } else {
                intent = try await retrieve(clientSecret: payment.clientSecret)
            }
            // Canceled (or a new session) while the intent loaded: do not open the card reader.
            guard gen == generation, machine.phase == .readyForCard || machine.phase == .waitingForCard else { return }
            sdkIntent = intent
            // Already charged (a lost answer before): only the server's check remains.
            if intent.status == .succeeded || intent.status == .processing || intent.status == .requiresCapture {
                feed(.cardRead, gen: gen)
                feed(.processed, gen: gen)
                return
            }
            if simulationActive, Terminal.shared.connectedReader?.simulated == true { applyTestCard() }
            let result: Result<PaymentIntent, Error> = await withCheckedContinuation { continuation in
                collectCancelable = Terminal.shared.processPaymentIntent(intent, collectConfig: nil, confirmConfig: nil) { processed, error in
                    if let processed { continuation.resume(returning: .success(processed)) }
                    else { continuation.resume(returning: .failure(error ?? POSFlowError.noResult)) }
                }
            }
            guard gen == generation else { return }
            collectCancelable = nil
            readerMessage = nil
            switch result {
            case .success(let processed):
                sdkIntent = processed
                feed(.cardRead, gen: gen)
                feed(.processed, gen: gen)
            case .failure(let error):
                // processPaymentIntent fails with a ConfirmPaymentIntentError when the intent was reached.
                if let updated = (error as? ConfirmPaymentIntentError)?.paymentIntent {
                    sdkIntent = updated
                }
                feed(.failed(Self.sdkFailure(error)), gen: gen)
            }
        } catch {
            feed(.failed(Self.sdkFailure(error)), gen: gen)
        }
    }

    private func retrieve(clientSecret: String) async throws -> PaymentIntent {
        initTerminalIfNeeded()
        return try await withCheckedThrowingContinuation { continuation in
            Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { intent, error in
                if let intent { continuation.resume(returning: intent) }
                else { continuation.resume(throwing: error ?? POSFlowError.noResult) }
            }
        }
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
        let charged = sdkIntent.map { $0.status == .succeeded || $0.status == .processing || $0.status == .requiresCapture } ?? false
        if !charged, let intent = try? await retrieve(clientSecret: payment.clientSecret) {
            guard gen == generation else { return }
            sdkIntent = intent
            if intent.status == .requiresPaymentMethod || intent.status == .requiresConfirmation {
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
        if let cancelable = collectCancelable ?? discoverCancelable, !cancelable.completed {
            cancelable.cancel { _ in }
        } else {
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
        guard let card = sdkIntent?.charges.first?.paymentMethodDetails?.cardPresent else { return nil }
        return POSCard.label(brand: Terminal.stringFromCardBrand(card.brand), last4: card.last4)
    }

    // MARK: Reader events (from TerminalBridge, on the main actor)

    fileprivate func readerWaitsForCard() {
        readerMessage = nil
        if machine.phase == .readyForCard { _ = machine.send(.waitingForCard) }
    }

    fileprivate func paymentStatusChanged(_ status: PaymentStatus) {
        switch status {
        case .waitingForInput: readerWaitsForCard()
        case .processing:
            if machine.phase == .readyForCard || machine.phase == .waitingForCard { _ = machine.send(.cardRead) }
        default: break
        }
    }

    fileprivate func readerMessage(_ message: ReaderDisplayMessage) {
        readerMessage = Self.finnish(message)
    }

    fileprivate func updateStarted() {
        updateProgress = 0
        readerMessage = "Päivitetään Tap to Pay -ohjelmistoa…"
    }

    fileprivate func updateProgressed(_ progress: Float) { updateProgress = Double(progress) }

    fileprivate func updateFinished() {
        updateProgress = nil
        readerMessage = nil
    }

    fileprivate func reconnecting(_ active: Bool) {
        readerMessage = active ? "Yhteys katkesi, yhdistetään uudelleen…" : nil
    }

    // MARK: Errors

    static func serverFailure(_ error: Error) -> POSFailure {
        guard let error = error as? LKError else { return .make(.network) }
        if error.status == 0 { return .make(.network, message: error.message) }
        return .make(.rejected, message: error.message)
    }

    static func sdkFailure(_ error: Error) -> POSFailure {
        if let flow = error as? POSFlowError { return .make(flow == .noReader ? .readerDisconnected : .other) }
        if error is LKError { return serverFailure(error) }
        let ns = error as NSError
        // Stripe's codes are positive (SCPErrors.h); a URL error here means the network went away.
        if ns.domain == NSURLErrorDomain { return .make(.network) }
        return POSErrorMapping.failure(code: ns.code, declineCode: declineCode(error))
    }

    /// The card network's reason, wherever this SDK version puts it.
    private static func declineCode(_ error: Error) -> String? {
        if let confirm = error as? ConfirmPaymentIntentError {
            return confirm.declineCode ?? confirm.apiError?.declineCode ?? confirm.paymentIntent?.lastPaymentError?.declineCode
        }
        // Fall back to any decline code string in userInfo.
        return (error as NSError).userInfo.values.lazy
            .compactMap { $0 as? String }
            .first { POSErrorMapping.offlinePinDeclineCodes.contains($0) }
    }

    static func finnish(_ message: ReaderDisplayMessage) -> String {
        switch message {
        case .retryCard: "Yritä korttia uudelleen."
        case .insertCard: "Aseta kortti lukijaan."
        case .insertOrSwipeCard: "Aseta tai vedä kortti."
        case .swipeCard: "Vedä kortti."
        case .removeCard: "Poista kortti."
        case .multipleContactlessCardsDetected: "Useita kortteja havaittiin. Näytä vain yksi kortti."
        case .tryAnotherReadMethod: "Korttia ei voitu lukea. Yritä uudelleen."
        case .tryAnotherCard: "Kokeile toista korttia."
        case .cardRemovedTooEarly: "Kortti poistettiin liian aikaisin. Yritä uudelleen."
        @unknown default: Terminal.stringFromReaderDisplayMessage(message)
        }
    }
}

enum POSFlowError: Error, Equatable { case noReader, noResult }

/// Resumes a continuation once; Stripe may call a completion again after the first answer.
private final class ResumeOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?

    init(_ continuation: CheckedContinuation<T, Error>) { self.continuation = continuation }

    func resume(_ result: Result<T, Error>) {
        let pending: CheckedContinuation<T, Error>? = lock.withLock {
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(with: result)
    }
}

/// The Objective-C delegates Stripe Terminal calls (from any thread); each event is handed to the
/// coordinator on the main actor. The connection configuration holds its delegate weakly, so the
/// coordinator keeps this object alive.
private final class TerminalBridge: NSObject, DiscoveryDelegate, TapToPayReaderDelegate, TerminalDelegate {
    weak var owner: POSCoordinator?
    var onDiscovered: (([Reader]) -> Void)?

    init(owner: POSCoordinator) { self.owner = owner }

    fileprivate func onMain(_ work: @escaping @MainActor (POSCoordinator) -> Void) {
        Task { @MainActor [weak self] in
            if let owner = self?.owner { work(owner) }
        }
    }

    // DiscoveryDelegate
    func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        onDiscovered?(readers)
    }

    // TerminalDelegate
    func terminal(_ terminal: Terminal, didChangePaymentStatus status: PaymentStatus) {
        onMain { $0.paymentStatusChanged(status) }
    }

    // TapToPayReaderDelegate
    func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        onMain { $0.updateStarted() }
    }

    func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        onMain { $0.updateProgressed(progress) }
    }

    func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        onMain { $0.updateFinished() }
    }

    func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        onMain { $0.readerWaitsForCard() }
    }

    func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        onMain { $0.readerMessage(displayMessage) }
    }

    // ReaderDelegate (auto-reconnect is on by default for Tap to Pay)
    func reader(_ reader: Reader, didStartReconnect cancelable: Cancelable, disconnectReason: DisconnectReason) {
        onMain { $0.reconnecting(true) }
    }

    func readerDidSucceedReconnect(_ reader: Reader) {
        onMain { $0.reconnecting(false) }
    }

    func readerDidFailReconnect(_ reader: Reader) {
        onMain { $0.reconnecting(false) }
    }
}

/// Testitila's simulated Bluetooth reader (WisePad 3) reports through the mobile-reader delegate;
/// the events mean the same as Tap to Pay's.
extension TerminalBridge: MobileReaderDelegate {
    func reader(_ reader: Reader, didReportAvailableUpdate update: ReaderSoftwareUpdate) {}

    func reader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        onMain { $0.updateStarted() }
    }

    func reader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        onMain { $0.updateProgressed(progress) }
    }

    func reader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        onMain { $0.updateFinished() }
    }

    func reader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        onMain { $0.readerWaitsForCard() }
    }

    func reader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        onMain { $0.readerMessage(displayMessage) }
    }
}
