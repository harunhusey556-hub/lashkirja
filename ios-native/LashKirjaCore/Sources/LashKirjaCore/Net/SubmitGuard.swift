import Foundation

/// One important user action (create, send, pay, credit, confirm) that must reach the server once.
///
/// - `begin()` answers nil while the same action is already in flight, so a second tap or a
///   re-entrant `Task` sends nothing.
/// - The `Idempotency-Key` it hands out stays the same until an attempt succeeds: a retry after a
///   network failure or a refusal is the same action, and the server replays a lost answer instead
///   of doing the work twice (a refused attempt releases the key on the server, so an edited retry
///   with the same key is accepted). After a success the next `begin()` is a new action with a new key.
///
/// The view keeps it in `@State` and calls `begin()` before its first `await` and `finish` when the
/// request is over (a `defer` is the usual place). Never hold it `inout` across an `await`.
public struct SubmitGuard: Sendable {
    public private(set) var inFlight = false
    public private(set) var key: String
    private let makeKey: @Sendable () -> String

    public init(makeKey: @escaping @Sendable () -> String = { UUID().uuidString }) {
        self.makeKey = makeKey
        key = makeKey()
    }

    /// Starts an attempt and returns the key to send, or nil when one is already running.
    public mutating func begin() -> String? {
        guard !inFlight else { return nil }
        inFlight = true
        return key
    }

    /// Ends the running attempt. Only a success moves on to a new key.
    public mutating func finish(succeeded: Bool) {
        inFlight = false
        if succeeded { key = makeKey() }
    }

    /// The screen now asks for a genuinely new action (e.g. a fresh send check): a new key.
    /// Ignored while an attempt is in flight, whose key must stay with it.
    public mutating func renew() {
        guard !inFlight else { return }
        key = makeKey()
    }
}
