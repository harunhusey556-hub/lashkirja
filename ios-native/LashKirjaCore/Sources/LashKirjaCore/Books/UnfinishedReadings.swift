import Foundation

/// A file the server read but nobody saved yet, kept on the phone so that closing the "Lisää
/// kuitti" screen or the app never loses it (owner, 2026-10-12: going back discarded the other
/// files). It is good while the server keeps the upload (`UnfinishedReadingStore.lifetime`).
public struct UnfinishedReading: Codable, Sendable, Equatable {
    /// The queue row's id; also names the picture file.
    public let id: String
    public let name: String
    public let draft: ReceiptDraft
    public let readAt: Date
    /// The file as it was sent ("<id>.jpg" / "<id>.pdf"), in the store's folder; nil when none was kept.
    public let previewName: String?

    public init(id: String, name: String, draft: ReceiptDraft, readAt: Date, previewName: String?) {
        self.id = id
        self.name = name
        self.draft = draft
        self.readAt = readAt
        self.previewName = previewName
    }
}

/// One folder per phone: `readings.json` (whose account it is, and the readings) plus the picture of
/// each reading. Another account's readings are removed, never shown; readings past the server's
/// upload lifetime are dropped with their pictures.
public struct UnfinishedReadingStore: Sendable {
    /// `STAGING_TTL_MS` of the server's `lib/receipt-staging.ts`: an upload older than this can no
    /// longer be saved ("Latausta ei löytynyt tai se on jo käytetty").
    public static let lifetime: TimeInterval = 24 * 60 * 60

    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// `Application Support/CaptureQueue`, left out of backups.
    public static func standard() -> UnfinishedReadingStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return UnfinishedReadingStore(directory: base.appendingPathComponent("CaptureQueue", isDirectory: true))
    }

    private struct Record: Codable {
        let userId: String
        let readings: [UnfinishedReading]
    }

    private var recordURL: URL { directory.appendingPathComponent("readings.json") }

    private var writeOptions: Data.WritingOptions {
        #if os(iOS)
        // Readable once the phone has been unlocked after a restart: uploads go on in the background.
        [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        [.atomic]
        #endif
    }

    private func ensureDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    public func previewURL(_ name: String) -> URL { directory.appendingPathComponent(name) }

    /// Keeps the file as it was sent; returns its name for `UnfinishedReading.previewName`.
    public func writePreview(id: String, data: Data, isPDF: Bool) throws -> String {
        try ensureDirectory()
        let name = "\(id).\(isPDF ? "pdf" : "jpg")"
        try data.write(to: previewURL(name), options: writeOptions)
        return name
    }

    /// The readings of `userId` still within the lifetime. Another account's record is removed with
    /// its pictures; expired readings are left out (and go at the next `save`).
    public func load(userId: String, now: Date = Date()) -> [UnfinishedReading] {
        guard let data = try? Data(contentsOf: recordURL) else { return [] }
        guard let record = try? JSONDecoder().decode(Record.self, from: data), record.userId == userId else {
            removeAll()
            return []
        }
        return record.readings.filter { now.timeIntervalSince($0.readAt) < Self.lifetime }
    }

    /// Writes the readings that are still unsaved; a picture no reading names any more is removed.
    public func save(userId: String, readings: [UnfinishedReading]) throws {
        if readings.isEmpty {
            try? FileManager.default.removeItem(at: recordURL)
        } else {
            try ensureDirectory()
            // The rate a reading carried is kept with it (it is not part of a save body).
            let encoder = JSONEncoder()
            encoder.userInfo[ReceiptDraft.keepsReadingKey] = true
            try encoder.encode(Record(userId: userId, readings: readings)).write(to: recordURL, options: writeOptions)
        }
        let kept = Set(readings.compactMap(\.previewName))
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name != "readings.json" && !kept.contains(name) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// Sign-out, or another account: nothing of the previous owner stays.
    public func removeAll() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}
