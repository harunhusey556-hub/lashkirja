import Foundation

/// The app's only way to Stripe Terminal. The SDK (36 MB, ~3,300 Objective-C classes, its own
/// static initializers and CoreBluetooth/ExternalAccessory) lives in LashKirjaStripe.framework,
/// which the app embeds but does not link: it is loaded the first time a card payment needs it,
/// not before `main` on every launch (w56, row 27). This file is compiled into both the app and the
/// framework; the Objective-C runtime matches the two protocols by name.
@objc(LKStripeTerminalDriving)
protocol StripeTerminalDriving: NSObjectProtocol {
    var isInitialized: Bool { get }
    /// Starts the SDK once with a source of connection tokens; `events` hears the reader, from any
    /// thread: (kind, value, text), kinds as in `StripeDriverEvent`.
    func start(fetchToken: @escaping (@escaping (String?, Error?) -> Void) -> Void,
               events: @escaping (String, Double, String?) -> Void)
    /// "tapToPay", "wisePad3" or "other" for the connected reader; nil while none is connected.
    var connectedReaderKind: String? { get }
    var connectedReaderSimulated: Bool { get }
    func disconnect(_ done: @escaping () -> Void)
    /// Another owner signed in: their reader session and cached credentials go.
    func disconnectAndClearCredentials()
    /// Discovers a "tapToPay" or a "bluetooth" reader and connects the first that fits (a
    /// WisePad 3 among the simulated Bluetooth ones).
    func connect(kind: String, simulated: Bool, locationId: String, done: @escaping (Error?) -> Void)
    /// A `POSTestCard` raw value: the card Stripe's simulator presents next.
    func setSimulatedCard(_ card: String)
    func retrievePaymentIntent(clientSecret: String, done: @escaping (NSObject?, Error?) -> Void)
    func processPaymentIntent(_ intent: NSObject, done: @escaping (NSObject?, Error?) -> Void)
    /// Cancels the discovery or collection under way; false when nothing is running.
    func cancelRunning() -> Bool
    /// Forgets the discovery and collection handles (the payment session was dropped).
    func forgetRunning()
    /// "succeeded", "processing", "requiresCapture", "requiresPaymentMethod",
    /// "requiresConfirmation", "canceled" or "other".
    func intentStatus(_ intent: NSObject) -> String
    func intentId(_ intent: NSObject) -> String
    /// The PaymentIntent a failed process reached (ConfirmPaymentIntentError), if any.
    func intent(in error: Error) -> NSObject?
    func declineCode(in error: Error) -> String?
    /// [brand, last4] of the card on the intent's first charge.
    func cardLabelParts(_ intent: NSObject) -> [String]?
}

/// The driver's own failures: no reader was found, or the SDK answered with nothing.
enum StripeDriverError {
    static let domain = "LKStripeDriver"
    static let noReader = 1
    static let noResult = 2
}

/// What `StripeTerminalDriving.start`'s `events` hears.
enum StripeDriverEvent {
    static let waitingForInput = "waitingForInput"
    static let processing = "processing"
    static let readerInput = "readerInput"
    /// text: the SDK's own wording; value: unused. The message itself is `message:<case>`.
    static let messagePrefix = "message:"
    static let updateStarted = "updateStarted"
    /// value: 0…1.
    static let updateProgress = "updateProgress"
    static let updateFinished = "updateFinished"
    /// value: 1 while reconnecting, 0 when done.
    static let reconnecting = "reconnecting"
}
