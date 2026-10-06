import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// When the client may send a request again by itself. Reads only: a write that may have reached
/// the server is never repeated here (the screen repeats it with the same Idempotency-Key).
public enum RetryPolicy {
    public static let maxGetAttempts = 3

    public static func attempts(method: String) -> Int { method == "GET" ? maxGetAttempts : 1 }

    /// 0.5 s, then 1 s.
    public static func delay(afterAttempt attempt: Int) -> UInt64 { UInt64(500_000_000) << UInt64(attempt) }

    /// A gateway in front of the app failed; an answer the app itself wrote is final.
    public static func retriesStatus(_ status: Int, fromApp: Bool) -> Bool {
        [502, 503, 504].contains(status) && !fromApp
    }

    /// A connection that dropped on the way. No connection at all (offline) or a timeout is not
    /// retried: waiting another 25 s helps nobody.
    public static func retriesTransport(_ error: Error) -> Bool {
        (error as? URLError)?.code == .networkConnectionLost
    }
}
