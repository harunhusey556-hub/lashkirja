import Foundation

/// Whether a session stored on this device opens the app straight away, with no round trip first
/// (owner, w67): the session is verified by the screens' own loads, and the first 401 signs out.
/// The limits follow OWASP's session guidance (an idle and an absolute timeout); the server
/// enforces the same ones, these only spare a launch that the server would refuse anyway.
public enum TrustedSession {
    /// Not used for this long: the password again (owner decision, reversible).
    public static let idleLimit: TimeInterval = 30 * 86_400
    /// From the sign-in, however often it is used (owner decision, reversible).
    public static let absoluteLimit: TimeInterval = 180 * 86_400
    /// Back from the background after this long: the session is checked again, without waiting.
    public static let reverifyAfterBackground: TimeInterval = 15 * 60

    public enum Decision: Equatable, Sendable {
        /// Open on the cached screens; the first load verifies the session.
        case open
        /// The sign-in screen: no session, or one this device knows has run out.
        case signIn(expired: Bool)
    }

    /// `lastActive` is when the app was last in use on this device (nil: never recorded, as before w67).
    public static func decide(_ stored: StoredToken?, lastActive: Date?, now: Date) -> Decision {
        guard let stored else { return .signIn(expired: false) }
        if stored.expiresAt <= now { return .signIn(expired: true) }
        if let lastActive, now.timeIntervalSince(lastActive) > idleLimit { return .signIn(expired: true) }
        if let started = stored.sessionStartedAt, now.timeIntervalSince(started) > absoluteLimit { return .signIn(expired: true) }
        return .open
    }
}

/// How long the app went unused before a launch or a return to the foreground, as the buckets
/// sent to /api/observe/events (kind `usage_gap`, no user or session id), so the idle limit can be
/// tuned from real use.
public enum UsageGap {
    public static let buckets = ["<1h", "1-12h", "12-24h", "1-3d", "3-7d", "7-30d", ">30d"]

    public static func bucket(_ gap: TimeInterval) -> String {
        let hour: TimeInterval = 3_600, day = 24 * hour
        switch gap {
        case ..<hour: return "<1h"
        case ..<(12 * hour): return "1-12h"
        case ..<day: return "12-24h"
        case ..<(3 * day): return "1-3d"
        case ..<(7 * day): return "3-7d"
        case ...(30 * day): return "7-30d"
        default: return ">30d"
        }
    }

    /// The event for a gap seen at `trigger` ("launch" or "foreground").
    public static func event(_ gap: TimeInterval, trigger: String) -> AppEvent {
        AppEvent(kind: "usage_gap", name: bucket(gap), screen: trigger)
    }
}
