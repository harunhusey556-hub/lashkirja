import Foundation

public extension AppLockPolicy {
    /// The lock belongs to the account it was set up for: signing in as anyone else
    /// (or when the owner is unknown) turns it off rather than lock that account behind
    /// the previous owner's PIN.
    static func keepsLock(owner: String?, signingIn userId: String) -> Bool {
        guard let owner else { return false }
        return owner == userId
    }
}

/// Coming back to the app after a while: what the screens show may be out of date.
public enum ForegroundRefresh {
    public static let staleAfter: TimeInterval = 5 * 60

    public static func isStale(backgroundedAt: Date?, now: Date, after: TimeInterval = staleAfter) -> Bool {
        guard let backgroundedAt else { return false }
        return now.timeIntervalSince(backgroundedAt) > after
    }
}
