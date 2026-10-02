import Foundation

/// When a screen that comes back into view should ask the server again: the first time, after a
/// change elsewhere in the app (`version`), when what it shows changed (`key`, e.g. a filter), or
/// once its figures are older than `maxAge`.
/// Pull-to-refresh always loads; a failed load calls `reset()` so the next appearance retries.
public struct ReloadGate: Sendable, Equatable {
    public let maxAge: TimeInterval
    private var version: Int?
    private var key = ""
    private var loadedAt: Date?

    public init(maxAge: TimeInterval = 60) { self.maxAge = maxAge }

    public func isDue(key: String = "", version: Int, now: Date = Date()) -> Bool {
        guard let loaded = self.version, let at = loadedAt else { return true }
        return loaded != version || self.key != key || now.timeIntervalSince(at) > maxAge
    }

    public mutating func mark(key: String = "", version: Int, now: Date = Date()) {
        self.version = version
        self.key = key
        loadedAt = now
    }

    public mutating func reset() {
        version = nil
        loadedAt = nil
    }
}
