import Foundation

extension DeviceSession {
    /// This device first, so it stays in sight when a long session list opens on its first rows.
    public static func currentFirst(_ sessions: [DeviceSession]) -> [DeviceSession] {
        sessions.filter(\.current) + sessions.filter { !$0.current }
    }
}
