import Foundation

/// One GET answer as the cache knows it: whose it is, which route and which query.
/// The account is part of the key, so one owner's figures are never served to another.
public struct ResourceKey: Hashable, Sendable {
    public let user: String
    public let path: String
    public let query: [String: String]

    public init(user: String, path: String, query: [String: String] = [:]) {
        self.user = user
        self.path = path
        self.query = query
    }

    /// The same text for the same query in any order.
    public var id: String {
        let items = query.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return user + "|" + path + "?" + items
    }
}

/// An answer's bytes, the app's `dataVersion` when it was asked for, and when it arrived.
public struct ResourceEntry: Codable, Sendable, Equatable {
    public let data: Data
    public let dataVersion: Int
    public let fetchedAt: Date

    public init(data: Data, dataVersion: Int, fetchedAt: Date) {
        self.data = data
        self.dataVersion = dataVersion
        self.fetchedAt = fetchedAt
    }

    /// Fresh while nothing changed in the app since it was asked for and it is at most `maxAge` old.
    public func isFresh(version: Int, maxAge: TimeInterval, now: Date) -> Bool {
        dataVersion == version && now.timeIntervalSince(fetchedAt) <= maxAge
    }
}

/// A cached answer handed to a screen before (or instead of) asking the server.
public struct ResourceHit<Value> {
    public let value: Value
    public let fetchedAt: Date
    public let isFresh: Bool
}

/// The app's one cache of GET answers (every screen's list and detail). A screen paints what is
/// cached at once (`cached`), then calls `load`, which hands back the cached answer while it is
/// fresh and otherwise asks the server, once per key however many screens ask at the same time.
/// Answers are kept as bytes and decoded here, off the main actor; the decoded value is kept
/// too, so painting a screen again does not decode again. The main lists are also written to
/// disk per account (`persist`), so a cold launch paints the last known figures, then refreshes.
public actor ResourceCache {
    public static let defaultMaxAge: TimeInterval = 60

    public let maxAge: TimeInterval
    private let store: ResourceDiskStore?
    private let now: @Sendable () -> Date
    private var entries: [String: ResourceEntry] = [:]
    /// The decoded value of an entry, by the entry's `fetchedAt`.
    private var decoded: [String: (fetchedAt: Date, value: Any)] = [:]
    private var inFlight: [String: (version: Int, task: Task<ResourceEntry, Error>)] = [:]
    /// Keys written to disk, per account.
    private var persisted: [String: Set<String>] = [:]
    private var restoredUsers: Set<String> = []
    /// Bumped by `clear()`: an answer asked for before it is not kept.
    private var generation = 0
    /// Disk writes run one after another, so an older snapshot never lands after a newer one.
    private var writeChain: Task<Void, Never>?

    public init(maxAge: TimeInterval = ResourceCache.defaultMaxAge, store: ResourceDiskStore? = nil,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.maxAge = maxAge
        self.store = store
        self.now = now
    }

    /// The cached answer, fresh or not; nil when there is none or it does not decode as `type`.
    public func cached<T: Decodable>(_ key: ResourceKey, version: Int, as type: T.Type = T.self) -> ResourceHit<T>? {
        restoreIfNeeded(key.user)
        guard let entry = entries[key.id], let value: T = decode(entry, id: key.id) else { return nil }
        return ResourceHit(value: value, fetchedAt: entry.fetchedAt,
                           isFresh: entry.isFresh(version: version, maxAge: maxAge, now: now()))
    }

    public func isFresh(_ key: ResourceKey, version: Int) -> Bool {
        restoreIfNeeded(key.user)
        return entries[key.id]?.isFresh(version: version, maxAge: maxAge, now: now()) ?? false
    }

    /// The answer for `key`: the cached one while fresh (unless `force`), otherwise the server's
    /// through `fetch`. Requests for the same key and version share one call. A failed call or an
    /// answer that does not decode leaves the cached entry as it was.
    public func load<T: Decodable>(_ key: ResourceKey, version: Int, force: Bool = false, persist: Bool = false,
                                   as type: T.Type = T.self,
                                   fetch: @escaping @Sendable () async throws -> Data) async throws -> T {
        restoreIfNeeded(key.user)
        let id = key.id
        if persist { persisted[key.user, default: []].insert(id) }
        if !force, let entry = entries[id], entry.isFresh(version: version, maxAge: maxAge, now: now()),
           let value: T = decode(entry, id: id) {
            return value
        }
        let task: Task<ResourceEntry, Error>
        if let running = inFlight[id], running.version == version {
            task = running.task
        } else {
            let clock = now
            task = Task {
                let data = try await fetch()
                return ResourceEntry(data: data, dataVersion: version, fetchedAt: clock())
            }
            inFlight[id] = (version, task)
        }
        let started = generation
        let entry: ResourceEntry
        do {
            entry = try await task.value
        } catch {
            if generation == started, inFlight[id]?.task == task { inFlight[id] = nil }
            throw error
        }
        if generation == started, inFlight[id]?.task == task { inFlight[id] = nil }
        guard let value: T = decode(entry, id: id) else {
            throw LKError(status: 200, code: "DECODE", message: "Palvelimen vastausta ei voitu lukea.")
        }
        // Signed out meanwhile: the answer is handed to the screen that asked, never kept.
        guard generation == started else { return value }
        keep(entry, id: id, user: key.user, value: value)
        return value
    }

    /// An answer that arrived another way (a write's answer, `/api/bootstrap`) stands for `key`.
    public func prime(_ key: ResourceKey, data: Data, version: Int, persist: Bool = false) {
        restoreIfNeeded(key.user)
        if persist { persisted[key.user, default: []].insert(key.id) }
        keep(ResourceEntry(data: data, dataVersion: version, fetchedAt: now()), id: key.id, user: key.user, value: nil)
    }

    /// Sign-out: nothing of the owner stays in memory or on disk, and nothing asked before is kept.
    public func clear() {
        generation += 1
        for running in inFlight.values { running.task.cancel() }
        inFlight.removeAll()
        entries.removeAll()
        decoded.removeAll()
        persisted.removeAll()
        restoredUsers.removeAll()
        guard let store else { return }
        // Now, so the next sign-in cannot read it back; and again after a write already on its way.
        store.removeAll()
        let previous = writeChain
        writeChain = Task.detached {
            await previous?.value
            store.removeAll()
        }
    }

    /// Waits for the disk writes asked for so far (tests, and before the app is suspended).
    public func flushWrites() async {
        await writeChain?.value
    }

    // MARK: Inside

    private func keep(_ entry: ResourceEntry, id: String, user: String, value: Any?) {
        // A slower answer for an older version never replaces a newer one.
        if let current = entries[id], current.dataVersion > entry.dataVersion { return }
        entries[id] = entry
        if let value { decoded[id] = (entry.fetchedAt, value) } else { decoded[id] = nil }
        if persisted[user]?.contains(id) == true { writeToDisk(user) }
    }

    private func decode<T: Decodable>(_ entry: ResourceEntry, id: String) -> T? {
        if let memo = decoded[id], memo.fetchedAt == entry.fetchedAt, let value = memo.value as? T { return value }
        // A 204 (or any empty body) reads as an empty object, as APIClient does.
        let body = entry.data.isEmpty ? Data("{}".utf8) : entry.data
        guard let value = try? JSONDecoder().decode(T.self, from: body) else { return nil }
        decoded[id] = (entry.fetchedAt, value)
        return value
    }

    /// The account's lists from the previous run, once: shown at once, never taken as fresh.
    private func restoreIfNeeded(_ user: String) {
        guard let store, !restoredUsers.contains(user) else { return }
        restoredUsers.insert(user)
        let saved = store.read(user: user)
        for (id, entry) in saved where entries[id] == nil {
            entries[id] = ResourceEntry(data: entry.data, dataVersion: ResourceDiskStore.restoredVersion, fetchedAt: entry.fetchedAt)
            persisted[user, default: []].insert(id)
        }
    }

    private func writeToDisk(_ user: String) {
        guard let store else { return }
        let ids = persisted[user] ?? []
        var snapshot: [String: ResourceEntry] = [:]
        for id in ids { if let entry = entries[id] { snapshot[id] = entry } }
        let previous = writeChain
        writeChain = Task.detached {
            await previous?.value
            try? store.write(user: user, entries: snapshot)
        }
    }
}

/// The main lists of the last run, one small JSON file per account under Caches/ResourceCache.
/// A file holds at most `maxEntries` answers of at most `maxEntryBytes` each (the newest kept).
public struct ResourceDiskStore: Sendable {
    public let directory: URL
    public static let maxEntries = 16
    public static let maxEntryBytes = 512 * 1024
    /// The version a restored entry carries: below any of this run, so it is shown but never fresh.
    public static let restoredVersion = Int.min

    public init(directory: URL) { self.directory = directory }

    public static func standard() -> ResourceDiskStore {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return ResourceDiskStore(directory: base.appendingPathComponent("ResourceCache", isDirectory: true))
    }

    private struct Record: Codable {
        let userId: String
        let entries: [String: ResourceEntry]
    }

    /// Account ids are cuid-like; anything else is dropped from the file name, never trusted as a path.
    func fileURL(user: String) -> URL {
        let safe = String(user.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }.prefix(80))
        return directory.appendingPathComponent((safe.isEmpty ? "tili" : safe) + ".json")
    }

    private var writeOptions: Data.WritingOptions {
        #if os(iOS)
        // Readable once the phone has been unlocked after a restart, like the receipt queue.
        [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        [.atomic]
        #endif
    }

    public func read(user: String) -> [String: ResourceEntry] {
        guard let data = try? Data(contentsOf: fileURL(user: user)),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              record.userId == user else { return [:] }
        // A file written by another account under the same name is never read.
        return record.entries.filter { $0.key.hasPrefix(user + "|") }
    }

    public func write(user: String, entries: [String: ResourceEntry]) throws {
        let kept = entries.filter { $0.value.data.count <= Self.maxEntryBytes }
            .sorted { $0.value.fetchedAt > $1.value.fetchedAt }
            .prefix(Self.maxEntries)
        let record = Record(userId: user, entries: Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.value) }))
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try JSONEncoder().encode(record).write(to: fileURL(user: user), options: writeOptions)
    }

    public func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}
