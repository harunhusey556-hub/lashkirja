import Foundation

/// Where one picked file is on its way to the receipt editor (web `lib/upload-queue.ts`).
/// `saved` and `offline` are the app's own: a row the owner already saved, and one handed to
/// the offline queue because the network was gone.
public enum UploadQueueStatus: String, Sendable, Equatable {
    case pending, uploading, processing, ready, saved, failed, cancelled, background, offline

    public var label: String {
        switch self {
        case .pending: "Jonossa"
        case .uploading: "Lähetetään"
        case .processing: "Käsitellään"
        case .ready: "Valmis"
        case .saved: "Tallennettu"
        case .failed: "Epäonnistui"
        case .cancelled: "Peruttu"
        case .background: "Taustalla"
        case .offline: "Odottaa yhteyttä"
        }
    }
}

public struct UploadQueueRow: Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public var status: UploadQueueStatus
    public var progress: String?
    public var error: String?
    /// What the server read, once the row is `ready`.
    public var draft: ReceiptDraft?
}

/// The several-files-at-once upload of the new-receipt screen (web `useReceiptUploadQueue.ts`):
/// files go one at a time; the first one read opens in the editor by itself, the rest wait
/// with "Käytä lomakkeessa".
public struct ReceiptUploadQueue: Sendable, Equatable {
    public struct Pick: Sendable, Equatable {
        public let name: String
        /// Unknown for a photo before it is loaded; checked again when it is sent.
        public let size: Int?
        public init(name: String, size: Int?) { self.name = name; self.size = size }
    }

    public static let maxBytes = 15 * 1024 * 1024
    /// How many photos one library pick may hold.
    public static let maxPick = 10

    public private(set) var rows: [UploadQueueRow] = []
    private var autoOpened = false

    public init() {}

    /// The web's `validateUploadFile`. `size` nil skips the size checks.
    public static func validate(name: String, size: Int?) -> String? {
        if let size {
            if size == 0 { return "Tiedosto on tyhjä" }
            if size > maxBytes { return "Tiedosto on liian suuri (enintään 15 Mt)" }
        }
        if ReceiptUploadFile.mimeType(forName: name) == nil { return "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja" }
        return nil
    }

    @discardableResult
    public mutating func enqueue(_ picks: [Pick]) -> [String] {
        let added = picks.map { pick -> UploadQueueRow in
            let invalid = Self.validate(name: pick.name, size: pick.size)
            return UploadQueueRow(id: UUID().uuidString, name: pick.name.isEmpty ? "kuitti" : pick.name,
                                  status: invalid == nil ? .pending : .failed, error: invalid)
        }
        rows += added
        return added.map(\.id)
    }

    public func row(_ id: String) -> UploadQueueRow? { rows.first { $0.id == id } }
    public var nextPending: UploadQueueRow? { rows.first { $0.status == .pending } }

    public mutating func markUploading(_ id: String) { patch(id) { $0.status = .uploading; $0.progress = "Lähetetään"; $0.error = nil } }
    public mutating func markProcessing(_ id: String) { patch(id) { $0.status = .processing; $0.progress = "Käsitellään" } }
    public mutating func markReady(_ id: String, draft: ReceiptDraft) {
        patch(id) { $0.status = .ready; $0.progress = "Odottaa tarkistusta"; $0.error = nil; $0.draft = draft }
    }
    public mutating func markSaved(_ id: String) { patch(id) { $0.status = .saved; $0.progress = nil; $0.draft = nil } }
    public mutating func markFailed(_ id: String, _ message: String) { patch(id) { $0.status = .failed; $0.progress = nil; $0.error = message } }
    public mutating func markCancelled(_ id: String) { patch(id) { $0.status = .cancelled; $0.progress = nil; $0.error = nil } }
    public mutating func markBackground(_ id: String) {
        patch(id) {
            $0.status = .background
            $0.progress = "Käsittely jatkuu taustalla"
            $0.error = "Näet tilanteen töistä. Muut tiedostot jatkuvat."
        }
    }
    public mutating func markOffline(_ id: String) { patch(id) { $0.status = .offline; $0.progress = nil; $0.error = nil } }

    /// "Peruuta": what has not finished stops; a read or failed file stays.
    public mutating func cancelPending() {
        for index in rows.indices where [.pending, .uploading, .processing, .background].contains(rows[index].status) {
            rows[index].status = .cancelled
            rows[index].progress = nil
            rows[index].error = nil
        }
    }

    /// "Yritä epäonnistuneet": only the failed rows go again.
    public mutating func retryFailed() {
        for index in rows.indices where rows[index].status == .failed {
            rows[index].status = .pending
            rows[index].error = nil
        }
    }

    /// The first file read opens in the editor by itself, once; later ones wait for a tap.
    public mutating func takeAutoOpen() -> UploadQueueRow? {
        guard !autoOpened, let ready = rows.first(where: { $0.status == .ready && $0.draft != nil }) else { return nil }
        autoOpened = true
        return ready
    }

    public var hasFailed: Bool { rows.contains { $0.status == .failed } }
    public var isWorking: Bool { rows.contains { [.pending, .uploading, .processing].contains($0.status) } }
    /// Nothing left to send or to check: the screen may close after the last save.
    public var isFinished: Bool { !rows.contains { [.pending, .uploading, .processing, .ready].contains($0.status) } }
    /// Work the owner would lose by closing: a file on its way or read but not saved.
    public var holdsWork: Bool { rows.contains { [.pending, .uploading, .processing, .ready].contains($0.status) } }
    /// After a save the screen closes only when nothing is left to check or to try again.
    public var closesAfterSave: Bool { isFinished && !hasFailed }
    public var offlineCount: Int { rows.filter { $0.status == .offline }.count }

    private mutating func patch(_ id: String, _ change: (inout UploadQueueRow) -> Void) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        change(&rows[index])
    }
}

/// File names and types as the receipt upload sends them. The server checks that the
/// extension matches the content, so a re-encoded photo is renamed to `.jpg`.
public enum ReceiptUploadFile {
    public static func mimeType(forName name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "pdf": "application/pdf"
        case "jpg", "jpeg": "image/jpeg"
        case "png": "image/png"
        case "heic", "heif": "image/heic"
        default: nil
        }
    }

    public static func isPDF(name: String) -> Bool { mimeType(forName: name) == "application/pdf" }

    public static func jpegName(for original: String) -> String {
        let base = (original as NSString).deletingPathExtension.trimmingCharacters(in: .whitespaces)
        return base.isEmpty ? "kuitti.jpg" : "\(base).jpg"
    }

    /// Library photos carry no usable name: "kuitti-1.jpg", "kuitti-2.jpg"…
    public static func photoName(index: Int) -> String { "kuitti-\(index + 1).jpg" }

    /// The upload never reached the server (no connection, or a gateway that did not answer),
    /// as opposed to the server refusing the file. Only the first goes to the offline queue.
    public static func isNetworkFailure(_ error: Error) -> Bool {
        guard let error = error as? LKError else { return false }
        if error.status == 0 { return true }
        return [502, 503, 504].contains(error.status) && error.message == LKError.unreachable
    }
}
