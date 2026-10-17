import Foundation
import StripeTerminal

/// Stripe Terminal behind `StripeTerminalDriving`, in its own framework so the SDK loads on the
/// first card payment instead of at every launch (StripeTerminalLoader in the app). Called on the
/// main thread, as POSCoordinator drove the SDK before; the SDK's delegates may call from any.
@objc(LKStripeTerminalDriver)
final class StripeTerminalDriver: NSObject, StripeTerminalDriving {
    private var tokenProvider: TokenSource?
    private var bridge: Bridge?
    private var collectCancelable: Cancelable?
    private var discoverCancelable: Cancelable?

    var isInitialized: Bool { Terminal.isInitialized() }

    func start(fetchToken: @escaping (@escaping (String?, Error?) -> Void) -> Void,
               events: @escaping (String, Double, String?) -> Void) {
        // Stripe holds both weakly: the driver keeps them for the app's life.
        let bridge = self.bridge ?? Bridge(events: events)
        self.bridge = bridge
        if !Terminal.isInitialized() {
            let provider = TokenSource(fetch: fetchToken)
            tokenProvider = provider
            Terminal.initWithTokenProvider(provider)
        }
        Terminal.shared.delegate = bridge
    }

    var connectedReaderKind: String? {
        guard Terminal.isInitialized(), Terminal.shared.connectionStatus == .connected,
              let reader = Terminal.shared.connectedReader else { return nil }
        switch reader.deviceType {
        case .tapToPay: return "tapToPay"
        case .wisePad3: return "wisePad3"
        default: return "other"
        }
    }

    var connectedReaderSimulated: Bool {
        guard Terminal.isInitialized() else { return false }
        return Terminal.shared.connectedReader?.simulated == true
    }

    func disconnect(_ done: @escaping () -> Void) {
        guard Terminal.isInitialized(), Terminal.shared.connectionStatus == .connected else { return done() }
        Terminal.shared.disconnectReader { _ in done() }
    }

    func disconnectAndClearCredentials() {
        guard Terminal.isInitialized() else { return }
        Terminal.shared.disconnectReader { _ in
            DispatchQueue.main.async { _ = Terminal.shared.clearCachedCredentials() }
        }
    }

    func connect(kind: String, simulated: Bool, locationId: String, done: @escaping (Error?) -> Void) {
        guard let bridge else { return done(StripeTerminalDriver.failure(StripeDriverError.noReader)) }
        do {
            let discovery: DiscoveryConfiguration
            let connection: ConnectionConfiguration
            let pick: ([Reader]) -> Reader?
            if kind == "bluetooth" {
                discovery = try BluetoothScanDiscoveryConfigurationBuilder().setSimulated(simulated).build()
                connection = try BluetoothConnectionConfigurationBuilder(delegate: bridge, locationId: locationId).build()
                // The simulator offers several Bluetooth readers; the WisePad 3 is the one Stripe sells in Finland.
                pick = { readers in readers.first { $0.deviceType == .wisePad3 } ?? readers.first }
            } else {
                discovery = try TapToPayDiscoveryConfigurationBuilder().setSimulated(simulated).build()
                connection = try TapToPayConnectionConfigurationBuilder(delegate: bridge, locationId: locationId).build()
                pick = { $0.first }
            }
            var connecting = false
            var answered = false
            func finish(_ error: Error?) {
                guard !answered else { return }
                answered = true
                done(error)
            }
            bridge.onDiscovered = { [weak self] readers in
                guard let reader = pick(readers) else { return }
                DispatchQueue.main.async {
                    guard !connecting, !answered else { return }
                    connecting = true
                    Terminal.shared.connectReader(reader, connectionConfig: connection) { connected, error in
                        DispatchQueue.main.async {
                            self?.discoverCancelable = nil
                            if connected != nil { finish(nil) } else { finish(error ?? StripeTerminalDriver.failure(StripeDriverError.noReader)) }
                        }
                    }
                }
            }
            discoverCancelable = Terminal.shared.discoverReaders(discovery, delegate: bridge) { error in
                // Called again (with nil) when a connect ends discovery: once a reader was picked,
                // only the connect's answer counts.
                DispatchQueue.main.async {
                    guard !connecting else { return }
                    finish(error ?? StripeTerminalDriver.failure(StripeDriverError.noReader))
                }
            }
        } catch {
            done(error)
        }
    }

    func setSimulatedCard(_ card: String) {
        let type: SimulatedCardType
        switch card {
        case "mastercard": type = .mastercard
        case "declined": type = .chargeDeclined
        case "insufficientFunds": type = .chargeDeclinedInsufficientFunds
        case "expired": type = .chargeDeclinedExpiredCard
        case "processingError": type = .chargeDeclinedProcessingError
        case "offlinePin": type = .offlinePinScaRetry
        default: type = .visa
        }
        Terminal.shared.simulatorConfiguration.simulatedCard = SimulatedCard(type: type)
    }

    func retrievePaymentIntent(clientSecret: String, done: @escaping (NSObject?, Error?) -> Void) {
        Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { intent, error in
            if let intent { done(intent, nil) } else { done(nil, error ?? StripeTerminalDriver.failure(StripeDriverError.noResult)) }
        }
    }

    func processPaymentIntent(_ intent: NSObject, done: @escaping (NSObject?, Error?) -> Void) {
        guard let intent = intent as? PaymentIntent else { return done(nil, StripeTerminalDriver.failure(StripeDriverError.noResult)) }
        collectCancelable = Terminal.shared.processPaymentIntent(intent, collectConfig: nil, confirmConfig: nil) { [weak self] processed, error in
            self?.collectCancelable = nil
            if let processed { done(processed, nil) } else { done(nil, error ?? StripeTerminalDriver.failure(StripeDriverError.noResult)) }
        }
    }

    func cancelRunning() -> Bool {
        guard let cancelable = collectCancelable ?? discoverCancelable, !cancelable.completed else { return false }
        cancelable.cancel { _ in }
        return true
    }

    func forgetRunning() {
        collectCancelable = nil
        discoverCancelable = nil
    }

    func intentStatus(_ intent: NSObject) -> String {
        guard let intent = intent as? PaymentIntent else { return "other" }
        switch intent.status {
        case .succeeded: return "succeeded"
        case .processing: return "processing"
        case .requiresCapture: return "requiresCapture"
        case .requiresPaymentMethod: return "requiresPaymentMethod"
        case .requiresConfirmation: return "requiresConfirmation"
        case .canceled: return "canceled"
        default: return "other"
        }
    }

    func intentId(_ intent: NSObject) -> String { (intent as? PaymentIntent)?.stripeId ?? "" }

    func intent(in error: Error) -> NSObject? { (error as? ConfirmPaymentIntentError)?.paymentIntent }

    func declineCode(in error: Error) -> String? {
        guard let confirm = error as? ConfirmPaymentIntentError else { return nil }
        return confirm.declineCode ?? confirm.apiError?.declineCode ?? confirm.paymentIntent?.lastPaymentError?.declineCode
    }

    func cardLabelParts(_ intent: NSObject) -> [String]? {
        guard let card = (intent as? PaymentIntent)?.charges.first?.paymentMethodDetails?.cardPresent else { return nil }
        return [Terminal.stringFromCardBrand(card.brand), card.last4]
    }

    private static func failure(_ code: Int) -> NSError { NSError(domain: StripeDriverError.domain, code: code) }
}

/// Hands Stripe Terminal a connection token from the app (the LashKirja server, on the owner's own
/// Stripe account).
private final class TokenSource: NSObject, ConnectionTokenProvider {
    private let fetch: (@escaping (String?, Error?) -> Void) -> Void
    init(fetch: @escaping (@escaping (String?, Error?) -> Void) -> Void) { self.fetch = fetch }
    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        fetch { secret, error in completion(secret, error) }
    }
}

/// The Objective-C delegates Stripe Terminal calls (from any thread), told on as driver events.
private final class Bridge: NSObject, DiscoveryDelegate, TapToPayReaderDelegate, TerminalDelegate {
    private let events: (String, Double, String?) -> Void
    var onDiscovered: (([Reader]) -> Void)?

    init(events: @escaping (String, Double, String?) -> Void) { self.events = events }

    // DiscoveryDelegate
    func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        onDiscovered?(readers)
    }

    // TerminalDelegate
    func terminal(_ terminal: Terminal, didChangePaymentStatus status: PaymentStatus) {
        switch status {
        case .waitingForInput: events(StripeDriverEvent.waitingForInput, 0, nil)
        case .processing: events(StripeDriverEvent.processing, 0, nil)
        default: break
        }
    }

    // TapToPayReaderDelegate
    func tapToPayReader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        events(StripeDriverEvent.updateStarted, 0, nil)
    }

    func tapToPayReader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        events(StripeDriverEvent.updateProgress, Double(progress), nil)
    }

    func tapToPayReader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        events(StripeDriverEvent.updateFinished, 0, nil)
    }

    func tapToPayReader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        events(StripeDriverEvent.readerInput, 0, nil)
    }

    func tapToPayReader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        message(displayMessage)
    }

    // ReaderDelegate (auto-reconnect is on by default for Tap to Pay)
    func reader(_ reader: Reader, didStartReconnect cancelable: Cancelable, disconnectReason: DisconnectReason) {
        events(StripeDriverEvent.reconnecting, 1, nil)
    }

    func readerDidSucceedReconnect(_ reader: Reader) {
        events(StripeDriverEvent.reconnecting, 0, nil)
    }

    func readerDidFailReconnect(_ reader: Reader) {
        events(StripeDriverEvent.reconnecting, 0, nil)
    }

    fileprivate func message(_ message: ReaderDisplayMessage) {
        let name: String
        switch message {
        case .retryCard: name = "retryCard"
        case .insertCard: name = "insertCard"
        case .insertOrSwipeCard: name = "insertOrSwipeCard"
        case .swipeCard: name = "swipeCard"
        case .removeCard: name = "removeCard"
        case .multipleContactlessCardsDetected: name = "multipleContactlessCardsDetected"
        case .tryAnotherReadMethod: name = "tryAnotherReadMethod"
        case .tryAnotherCard: name = "tryAnotherCard"
        case .cardRemovedTooEarly: name = "cardRemovedTooEarly"
        @unknown default: name = "other"
        }
        events(StripeDriverEvent.messagePrefix + name, 0, Terminal.stringFromReaderDisplayMessage(message))
    }
}

/// Testitila's simulated Bluetooth reader (WisePad 3) reports through the mobile-reader delegate;
/// the events mean the same as Tap to Pay's.
extension Bridge: MobileReaderDelegate {
    func reader(_ reader: Reader, didReportAvailableUpdate update: ReaderSoftwareUpdate) {}

    func reader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
        events(StripeDriverEvent.updateStarted, 0, nil)
    }

    func reader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {
        events(StripeDriverEvent.updateProgress, Double(progress), nil)
    }

    func reader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {
        events(StripeDriverEvent.updateFinished, 0, nil)
    }

    func reader(_ reader: Reader, didRequestReaderInput inputOptions: ReaderInputOptions = []) {
        events(StripeDriverEvent.readerInput, 0, nil)
    }

    func reader(_ reader: Reader, didRequestReaderDisplayMessage displayMessage: ReaderDisplayMessage) {
        message(displayMessage)
    }
}
