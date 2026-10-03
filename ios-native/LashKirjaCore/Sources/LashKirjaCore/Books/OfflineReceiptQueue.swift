import Foundation

/// A receipt photo or file kept on the phone until `POST /api/receipts/inbox` takes it
/// (web `lib/offline/receipt-queue.ts`). The id is also the Idempotency-Key, so a send that
/// reached the server but lost its answer does not make a second receipt.
public struct QueuedReceipt: Codable, Sendable, Equatable, Identifiable {
    public enum Status: String, Codable, Sendable { case queued, sending, failed, done }

    public let id: String
    public let userId: String
    public let createdAt: Date
    /// ISO time on the phone's clock; the server dates the receipt with it when the file has no date.
    public let capturedAt: String
    public let fileName: String
    public let mimeType: String
    public let size: Int
    public var status: Status
    public var attempts: Int
    public var nextAttemptAt: Date
    public var lastError: String?
    public var jobId: String?
    /// When the server took it. Records from before this field have none: their `createdAt` stands in.
    public var completedAt: Date?

    public init(id: String, userId: String, createdAt: Date, capturedAt: String, fileName: String, mimeType: String,
                size: Int, status: Status, attempts: Int, nextAttemptAt: Date, lastError: String? = nil, jobId: String? = nil,
                completedAt: Date? = nil) {
        self.id = id
        self.userId = userId
        self.createdAt = createdAt
        self.capturedAt = capturedAt
        self.fileName = fileName
        self.mimeType = mimeType
        self.size = size
        self.status = status
        self.attempts = attempts
        self.nextAttemptAt = nextAttemptAt
        self.lastError = lastError
        self.jobId = jobId
        self.completedAt = completedAt
    }
}

/// The queue's decisions, as the web driver (`useOfflineReceiptQueue.ts`) makes them.
public enum OfflineReceiptRules {
    public enum Outcome: Equatable, Sendable { case done, retry, failed, paused }

    /// 5 s, 30 s, 2 min, 10 min, then 30 min. `attempts` counts the one that just failed.
    static let retryDelays: [TimeInterval] = [5, 30, 120, 600, 1800]
    /// Past this many automatic tries a row stops and waits for "Yritä uudelleen".
    public static let maxSendAttempts = 8
    static let doneRetention: TimeInterval = 24 * 60 * 60

    public static func nextAttemptDelay(attempts: Int) -> TimeInterval {
        retryDelays[min(max(attempts - 1, 0), retryDelays.count - 1)]
    }

    /// nil = no answer from the server at all.
    public static func classify(status: Int?) -> Outcome {
        guard let status else { return .retry }
        if (200..<300).contains(status) { return .done }
        if status == 401 { return .paused }
        if status == 408 || status == 429 || (500..<600).contains(status) { return .retry }
        return .failed
    }

    /// The oldest queued row whose wait is over; failed rows go only by hand.
    public static func pickNext(_ items: [QueuedReceipt], now: Date) -> QueuedReceipt? {
        items.filter { $0.status == .queued && $0.nextAttemptAt <= now }.min { $0.createdAt < $1.createdAt }
    }

    public static func earliestNextAttempt(_ items: [QueuedReceipt]) -> Date? {
        items.filter { $0.status == .queued }.map(\.nextAttemptAt).min()
    }

    /// The connection came back: rows only waiting out a backoff are due now (attempts kept).
    public static func releaseBackoff(_ items: [QueuedReceipt], now: Date) -> [QueuedReceipt] {
        items.map { item in
            var item = item
            if item.status == .queued && item.nextAttemptAt > now { item.nextAttemptAt = now }
            return item
        }
    }

    /// The app was closed mid-send: that row goes back to the queue.
    public static func recoverCrashedSends(_ items: [QueuedReceipt]) -> [QueuedReceipt] {
        items.map { item in
            var item = item
            if item.status == .sending { item.status = .queued }
            return item
        }
    }

    /// Sent rows are kept a day after sending (for "Lähetetyt kuvat"), then dropped. A photo
    /// that waited offline for days is not gone the moment it is sent.
    public static func expiredDone(_ items: [QueuedReceipt], now: Date) -> [String] {
        items.filter { $0.status == .done && now.timeIntervalSince($0.completedAt ?? $0.createdAt) > doneRetention }.map(\.id)
    }

    /// What one send attempt leaves behind (`sendOne` on the web). `status` nil = no answer.
    public static func afterSend(_ item: QueuedReceipt, status: Int?, serverError: String?, jobId: String?,
                                 deviceOffline: Bool, now: Date) -> (item: QueuedReceipt, paused: Bool) {
        var next = item
        switch classify(status: status) {
        case .done:
            next.status = .done
            next.lastError = nil
            next.jobId = jobId
            next.completedAt = now
            return (next, false)
        case .paused:
            // The session is gone: kept for the next sign-in, and the rest of the queue waits too.
            next.status = .queued
            return (next, true)
        case .retry:
            let offlineNow = status == nil && deviceOffline
            // A failure while the phone has no network says nothing about the upload: nothing spent.
            let attempts = offlineNow ? item.attempts : item.attempts + 1
            if attempts >= maxSendAttempts {
                next.status = .failed
                next.attempts = attempts
                next.lastError = status == nil
                    ? "Ei yhteyttä usean yrityksen jälkeen. Yritä myöhemmin uudelleen."
                    : (serverError ?? "Lähetys epäonnistui usean yrityksen jälkeen. Yritä myöhemmin uudelleen.")
                return (next, false)
            }
            next.status = .queued
            next.attempts = attempts
            if offlineNow {
                next.lastError = "Odottaa yhteyttä."
            } else {
                next.nextAttemptAt = now.addingTimeInterval(nextAttemptDelay(attempts: attempts))
                next.lastError = "Ei yhteyttä. Lähetetään uudelleen automaattisesti."
            }
            return (next, false)
        case .failed:
            next.status = .failed
            next.attempts = item.attempts + 1
            next.lastError = serverError ?? "Lähetys epäonnistui."
            return (next, false)
        }
    }

    /// "Yritä uudelleen" gives a fresh budget of automatic tries.
    public static func manualRetry(_ item: QueuedReceipt, now: Date) -> QueuedReceipt {
        var next = item
        next.status = .queued
        next.attempts = 0
        next.nextAttemptAt = now
        next.lastError = nil
        return next
    }

    // MARK: Wording (QueuedReceiptsCard.tsx)

    public static func statusText(_ item: QueuedReceipt) -> String {
        switch item.status {
        case .sending: "Lähetetään…"
        case .failed: item.lastError ?? "Lähetys epäonnistui."
        case .queued, .done: "Odottaa yhteyttä"
        }
    }

    public static func waitingTitle(_ count: Int) -> String {
        count == 1 ? "Jonossa 1 kuitti" : "Jonossa \(count) kuittia"
    }

    public static func sentText(_ count: Int) -> String {
        (count == 1 ? "1 kuva lähetetty." : "\(count) kuvaa lähetetty.") + " Kuitit näkyvät tarkistettavissa, kun ne on luettu."
    }

    /// A state change could not be written: the queue stops rather than sending the same row again.
    public static let storageFailure = "Kuvan tilaa ei voitu tallentaa puhelimeen, joten lähetys pysäytettiin. Vapauta tallennustilaa ja yritä uudelleen."

    /// Records on the phone that could not be read (and so cannot be sent).
    public static func corruptText(_ count: Int) -> String {
        (count == 1 ? "Yhtä" : "\(count)") + " jonossa ollutta kuvaa ei voitu lukea puhelimesta."
    }

    public static let offlineNotice = "Ei yhteyttä. Kuva tallennettiin ja lähetetään automaattisesti, kun yhteys palaa."

    /// "Kuitti 28.9." (the day it was taken, Finnish time).
    public static func title(createdAt: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Helsinki")!
        let parts = calendar.dateComponents([.day, .month], from: createdAt)
        return "Kuitti \(parts.day ?? 0).\(parts.month ?? 0)."
    }

    public static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}

/// The queue on disk: one JSON record and one file per item, in the app's own sandbox
/// (never UserDefaults). On iOS the files are encrypted by Data Protection, readable once the
/// phone has been unlocked after a restart, so a send can run in the background.
public struct OfflineReceiptStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// `Application Support/ReceiptQueue`, left out of backups.
    public static func standard() -> OfflineReceiptStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return OfflineReceiptStore(directory: base.appendingPathComponent("ReceiptQueue", isDirectory: true))
    }

    private var writeOptions: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        [.atomic]
        #endif
    }

    private func recordURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).json") }
    private func fileURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).bin") }

    private func ensureDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    private func all() -> [QueuedReceipt] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        let decoder = JSONDecoder()
        return names.filter { $0.hasSuffix(".json") }.compactMap { name in
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
            return try? decoder.decode(QueuedReceipt.self, from: data)
        }
    }

    /// Oldest first.
    public func list(userId: String) -> [QueuedReceipt] {
        all().filter { $0.userId == userId }.sorted { $0.createdAt < $1.createdAt }
    }

    @discardableResult
    public func enqueue(userId: String, data: Data, fileName: String, mimeType: String,
                        id: String = UUID().uuidString.lowercased(), now: Date = Date()) throws -> QueuedReceipt {
        try ensureDirectory()
        let item = QueuedReceipt(id: id, userId: userId, createdAt: now,
                                 capturedAt: OfflineReceiptRules.isoString(now), fileName: fileName, mimeType: mimeType,
                                 size: data.count, status: .queued, attempts: 0, nextAttemptAt: now)
        // The file first: a record never points at a missing file. A record that cannot be
        // written takes its file with it, so nothing is left that no record knows of.
        try data.write(to: fileURL(item.id), options: writeOptions)
        do {
            try save(item)
        } catch {
            try? FileManager.default.removeItem(at: fileURL(item.id))
            throw error
        }
        return item
    }

    public func save(_ item: QueuedReceipt) throws {
        try ensureDirectory()
        try JSONEncoder().encode(item).write(to: recordURL(item.id), options: writeOptions)
    }

    public func data(for item: QueuedReceipt) throws -> Data { try Data(contentsOf: fileURL(item.id)) }

    public func delete(id: String) {
        try? FileManager.default.removeItem(at: recordURL(id))
        try? FileManager.default.removeItem(at: fileURL(id))
    }

    /// What `repair()` found on disk.
    public struct Check: Equatable, Sendable {
        /// Files with no record (left by a crash between the two writes); already deleted.
        public var orphansRemoved: [String]
        /// Records that could not be read or decoded; kept (with their files) until removed by hand.
        public var corrupt: [String]

        public init(orphansRemoved: [String], corrupt: [String]) {
            self.orphansRemoved = orphansRemoved
            self.corrupt = corrupt
        }
    }

    /// On start: deletes files no record points at and reports records that cannot be read.
    /// Only the queue's own `.json`/`.bin` names are looked at.
    public func repair() -> Check {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        let records = Set(names.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) })
        var orphans: [String] = []
        for name in names where name.hasSuffix(".bin") {
            let id = String(name.dropLast(4))
            guard !records.contains(id) else { continue }
            if (try? FileManager.default.removeItem(at: fileURL(id))) != nil { orphans.append(id) }
        }
        let decoder = JSONDecoder()
        let corrupt = records.filter { id in
            guard let data = try? Data(contentsOf: recordURL(id)) else { return true }
            return (try? decoder.decode(QueuedReceipt.self, from: data)) == nil
        }
        return Check(orphansRemoved: orphans.sorted(), corrupt: corrupt.sorted())
    }

    /// Sign-out: every queued file goes, readable or not (one account's queue at a time is kept).
    public func removeAll() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasSuffix(".json") || name.hasSuffix(".bin") {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// Another account signed in on this phone: the previous owner's photos are not kept for it
    /// (the web wipes its queue on sign-out).
    public func removeOtherUsers(keeping userId: String) {
        for item in all() where item.userId != userId { delete(id: item.id) }
    }
}

/// One pass of the queue's sender (the web driver's `drain`): due rows go oldest first, one at a
/// time. Every state change is written before the next step, and a pass stops at once when
///
/// - `isCurrent` turns false (signed out, another account, the session expired or the pass was
///   cancelled): it is asked after every await and right before a file goes out, and a stale pass
///   neither sends, writes nor reports rows;
/// - a write fails: going on would leave the row `queued` on disk and pick it again, a loop of
///   uploads. The row stays as it was (`sending` after an upload, which the next start re-queues;
///   the Idempotency-Key keeps that resend from becoming a second receipt).
@MainActor
public struct OfflineReceiptDrain {
    public enum Stop: Equatable, Sendable {
        /// Nothing due; `next` is when the earliest backed-off row is (nil = none waiting).
        case idle(next: Date?)
        case offline
        /// A 401: the rest waits for the next sign-in.
        case paused
        case stale
        case storage
    }

    /// The server's answer to one upload. `status` nil = no answer at all.
    public struct Answer: Sendable, Equatable {
        public var status: Int?
        public var serverError: String?
        public var jobId: String?
        public init(status: Int?, serverError: String? = nil, jobId: String? = nil) {
            self.status = status
            self.serverError = serverError
            self.jobId = jobId
        }
    }

    public let store: OfflineReceiptStore
    public let userId: String
    private let isCurrent: () -> Bool
    private let isOnline: () -> Bool
    private let onRows: ([QueuedReceipt]) -> Void
    private let now: () -> Date
    private let loadFile: (QueuedReceipt) async -> Data?
    private let upload: (QueuedReceipt, Data) async -> Answer

    /// `loadFile` defaults to reading the stored file off the main actor.
    public init(store: OfflineReceiptStore, userId: String,
                isCurrent: @escaping () -> Bool,
                isOnline: @escaping () -> Bool,
                onRows: @escaping ([QueuedReceipt]) -> Void,
                now: @escaping () -> Date = { Date() },
                loadFile: ((QueuedReceipt) async -> Data?)? = nil,
                upload: @escaping (QueuedReceipt, Data) async -> Answer) {
        self.store = store
        self.userId = userId
        self.isCurrent = isCurrent
        self.isOnline = isOnline
        self.onRows = onRows
        self.now = now
        self.loadFile = loadFile ?? { item in
            try? await Task.detached(priority: .utility) { try store.data(for: item) }.value
        }
        self.upload = upload
    }

    public func run(releaseBackoff: Bool) async -> Stop {
        guard isCurrent() else { return .stale }
        let start = now()
        for id in OfflineReceiptRules.expiredDone(store.list(userId: userId), now: start) { store.delete(id: id) }
        var items = store.list(userId: userId)
        if releaseBackoff {
            for (before, after) in zip(items, OfflineReceiptRules.releaseBackoff(items, now: start)) where before != after {
                guard persist(after) else { return .storage }
            }
            items = store.list(userId: userId)
        }
        onRows(items)
        while true {
            guard isCurrent() else { return .stale }
            guard isOnline() else { return .offline }
            guard let next = OfflineReceiptRules.pickNext(items, now: now()) else {
                return .idle(next: OfflineReceiptRules.earliestNextAttempt(items))
            }
            if let stop = await send(next) { return stop }
            guard isCurrent() else { return .stale }
            items = store.list(userId: userId)
            onRows(items)
        }
    }

    /// nil = go on with the next row.
    private func send(_ item: QueuedReceipt) async -> Stop? {
        var sending = item
        sending.status = .sending
        guard persist(sending) else { return .storage }
        onRows(store.list(userId: userId))

        let data = await loadFile(item)
        // Right before the upload: the account the file was read for must still be the one signed in.
        guard isCurrent() else { return .stale }
        guard let data else {
            // The file itself is gone: another try would read nothing again.
            var failed = item
            failed.status = .failed
            failed.attempts += 1
            failed.lastError = "Kuvaa ei voitu lukea. Kuvaa kuitti uudelleen."
            return persist(failed) ? nil : .storage
        }
        let answer = await upload(item, data)
        // Signed out (or another owner in) while this was on its way: its file may already be
        // gone, and a record written back now would be a ghost row.
        guard isCurrent() else { return .stale }
        let outcome = OfflineReceiptRules.afterSend(item, status: answer.status, serverError: answer.serverError, jobId: answer.jobId,
                                                    deviceOffline: !isOnline(), now: now())
        guard persist(outcome.item) else { return .storage }
        return outcome.paused ? .paused : nil
    }

    private func persist(_ item: QueuedReceipt) -> Bool {
        do {
            try store.save(item)
            return true
        } catch {
            return false
        }
    }
}
