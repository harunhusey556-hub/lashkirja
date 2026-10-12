import Foundation

/// Where one picked file is on its way to the receipt editor (web `lib/upload-queue.ts`).
/// `saved` and `offline` are the app's own: a row the owner already saved, and one handed to
/// the offline queue because the network was gone. `saveQueued` and `saving` are the web's
/// auto-save: a finished reading waiting for a free slot, and one on its way to the server.
public enum UploadQueueStatus: String, Sendable, Equatable {
    case pending, uploading, processing, ready, saveQueued, saving, saved, failed, cancelled, background, offline

    public var label: String {
        switch self {
        case .pending: "Jonossa"
        case .uploading: "Lähetetään"
        case .processing: "Käsitellään"
        case .ready: "Valmis"
        case .saveQueued: "Odottaa tallennusta"
        case .saving: "Tallennetaan"
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
    /// Set on `saved`: the server approved the receipt as it was saved, so it never waits in the
    /// review queue.
    public var autoApproved = false
    /// Set on `saved`: the server found the same vendor, date and sum already on file, so the
    /// receipt was saved anyway, as pending.
    public var duplicate = false
    /// False on `saved` by a server that predates `autoApprove`: it said nothing about the approval
    /// (it approves by default), so the row counts as saved, never as waiting for review.
    public var approvalKnown = true
    /// Set on `saved`: what the server did with a bill ("ostolasku luotu, eräpäivä 14.10.2026");
    /// nil for a plain receipt.
    public var invoiceNote: String?

    /// Said under a saved row: what became of the receipt (as the web's upload list), and of the
    /// bill it was: "Hyväksytty automaattisesti · ostolasku luotu, eräpäivä 14.10.2026".
    public var outcomeText: String? {
        guard status == .saved else { return nil }
        let approval: String?
        if autoApproved {
            approval = "Hyväksytty automaattisesti"
        } else if !approvalKnown {
            approval = duplicate ? "Samanlainen kuitti oli jo tallennettu" : nil
        } else {
            approval = duplicate ? "Samanlainen kuitti on jo tallennettu – odottaa tarkistusta" : "Odottaa tarkistusta"
        }
        guard let invoiceNote else { return approval }
        return "\(approval ?? "Tallennettu") · \(invoiceNote)"
    }

    /// A save the server refused keeps what was read, so the form can take it from there.
    public var canOpenForm: Bool { status == .failed && draft != nil }
}

/// The several-files-at-once upload of the new-receipt screen (web `useReceiptUploadQueue.ts`):
/// files go up a few at a time and are read side by side. In a pick of several files each reading is
/// saved by the app (`AutoAccept`); a single file that is not complete opens in the editor by
/// itself, and a reading waiting for the form is offered with "Käytä lomakkeessa".
public struct ReceiptUploadQueue: Sendable, Equatable {
    public struct Pick: Sendable, Equatable {
        public let name: String
        /// Unknown for a photo before it is loaded; checked again when it is sent.
        public let size: Int?
        public init(name: String, size: Int?) { self.name = name; self.size = size }
    }

    public static let maxBytes = 15 * 1024 * 1024
    /// How many files one pick may hold: a company moving onto the app imports
    /// its previous bookkeeping in one sitting. The one constant the picker
    /// follows (`CaptureFlow`'s PhotosPicker), so the app and the shell agree. The web has no
    /// cap; 200 is PhotosPicker's practical ceiling on a phone, so the iOS limit stops there.
    public static let maxPick = 200
    /// How many files are on their way to the server at once: enough that a hundred photos do
    /// not take all night, few enough that the phone and the server are not flooded.
    public static let uploadConcurrency = 3
    /// How many auto-saves are on the wire at once (the web's `AUTO_SAVE_CONCURRENCY`, kept at the
    /// phone's upload width): each save runs the bank matching on the server.
    public static let saveConcurrency = 3
    /// Rows the queue list opens on, and each "Näytä enemmän" adds: a bulk import is hundreds long.
    public static let listPage = 50

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
    public var uploadingCount: Int { rows.filter { $0.status == .uploading }.count }

    /// The next waiting file, marked uploading in the same step so two callers never take the
    /// same row; nil while `limit` files are already going up, or when none is waiting.
    public mutating func claimNext(limit: Int = ReceiptUploadQueue.uploadConcurrency) -> UploadQueueRow? {
        guard uploadingCount < max(limit, 1), let next = nextPending else { return nil }
        markUploading(next.id)
        return next
    }

    public mutating func markUploading(_ id: String) { patch(id) { $0.status = .uploading; $0.progress = "Lähetetään"; $0.error = nil } }
    public mutating func markProcessing(_ id: String) { patch(id) { $0.status = .processing; $0.progress = "Käsitellään" } }
    public mutating func markReady(_ id: String, draft: ReceiptDraft) {
        patch(id) { $0.status = .ready; $0.progress = "Odottaa tarkistusta"; $0.error = nil; $0.draft = draft }
    }
    /// `autoApproved` nil: the server did not say (`ReceiptSaving.Outcome.approved`).
    public mutating func markSaved(_ id: String, autoApproved: Bool? = false, duplicate: Bool = false, invoiceNote: String? = nil) {
        patch(id) {
            $0.invoiceNote = invoiceNote
            $0.status = .saved
            $0.progress = nil
            $0.error = nil
            $0.draft = nil
            $0.autoApproved = autoApproved ?? false
            $0.approvalKnown = autoApproved != nil
            $0.duplicate = duplicate
        }
    }

    /// A finished reading that the app saves itself, waiting for a free save slot.
    public mutating func markSaveQueued(_ id: String, draft: ReceiptDraft) {
        patch(id) { $0.status = .saveQueued; $0.progress = "Odottaa tallennusta"; $0.error = nil; $0.draft = draft }
    }

    public var savingCount: Int { rows.filter { $0.status == .saving }.count }
    public var nextSaveQueued: UploadQueueRow? { rows.first { $0.status == .saveQueued } }

    /// The next reading to save, marked saving in the same step so two callers never take the same
    /// row; nil while `limit` saves are already going, or when none is waiting.
    public mutating func claimNextSave(limit: Int = ReceiptUploadQueue.saveConcurrency) -> UploadQueueRow? {
        guard savingCount < max(limit, 1), let next = nextSaveQueued else { return nil }
        patch(next.id) { $0.status = .saving; $0.progress = "Tallennetaan…" }
        return row(next.id)
    }

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

    /// "Peruuta": what has not finished stops; a read or failed file stays. A reading still
    /// waiting for a save slot is not lost: it stays read, for the form. A save already sent finishes.
    public mutating func cancelPending() {
        for index in rows.indices {
            switch rows[index].status {
            case .pending, .uploading, .processing, .background:
                rows[index].status = .cancelled
                rows[index].progress = nil
                rows[index].error = nil
            case .saveQueued:
                rows[index].status = .ready
                rows[index].progress = "Odottaa tarkistusta"
            default:
                break
            }
        }
    }

    /// "Yritä epäonnistuneet": only the failed rows go again. A failed save keeps its reading, so
    /// the reading is saved again; the file is sent again only when it never got that far.
    public mutating func retryFailed() {
        for index in rows.indices where rows[index].status == .failed {
            if rows[index].draft == nil {
                rows[index].status = .pending
            } else {
                rows[index].status = .saveQueued
                rows[index].progress = "Odottaa tallennusta"
            }
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
    public var isWorking: Bool { rows.contains { [.pending, .uploading, .processing, .saveQueued, .saving].contains($0.status) } }
    /// Nothing left to send or to check: the screen may close after the last save.
    public var isFinished: Bool { !rows.contains { Self.unfinished.contains($0.status) } }
    /// Work the owner would lose by closing: a file on its way, or read but not saved (a save the
    /// server refused included: its reading is still waiting for the form).
    public var holdsWork: Bool { rows.contains { Self.unfinished.contains($0.status) || $0.canOpenForm } }
    private static let unfinished: Set<UploadQueueStatus> = [.pending, .uploading, .processing, .ready, .saveQueued, .saving]
    /// After a save the screen closes only when nothing is left to check or to try again.
    public var closesAfterSave: Bool { isFinished && !hasFailed }
    public var offlineCount: Int { rows.filter { $0.status == .offline }.count }
    public var savedCount: Int { rows.filter { $0.status == .saved }.count }
    /// Saved but not approved by the server: these wait in Kuitit's review queue.
    public var reviewCount: Int { rows.filter { $0.status == .saved && !$0.autoApproved && $0.approvalKnown }.count }
    /// Rows the owner would lose by dropping the queue (Kuitit's "Kesken: N kuittia").
    public var unfinishedCount: Int { rows.filter { Self.unfinished.contains($0.status) || $0.canOpenForm }.count }

    // MARK: Kept across screens and app runs

    /// Read but not saved: what `UnfinishedReadingStore` keeps. A save already sent is kept too: if
    /// it did land, the server refuses the second one (the upload is claimed), never a duplicate.
    public var unsavedReadings: [UploadQueueRow] {
        rows.filter { row in
            guard row.draft != nil else { return false }
            return [.ready, .saveQueued, .saving].contains(row.status) || row.canOpenForm
        }
    }

    /// Readings kept from an earlier run come back as rows waiting for the form, under their own
    /// ids. None of them opens the form by itself.
    public mutating func restore(_ readings: [UnfinishedReading]) {
        let known = Set(rows.map(\.id))
        for reading in readings where !known.contains(reading.id) {
            rows.append(UploadQueueRow(id: reading.id, name: reading.name, status: .ready,
                                       progress: "Odottaa tarkistusta", draft: reading.draft))
        }
        if !readings.isEmpty { autoOpened = true }
    }

    /// "Hylkää tallentamattomat": the readings not saved leave the queue (a save already sent
    /// finishes). Returns the ids removed, so their pictures can go too.
    @discardableResult
    public mutating func discardUnsaved() -> [String] {
        let removed = rows.filter { $0.status == .ready || $0.status == .saveQueued || $0.canOpenForm }.map(\.id)
        rows.removeAll { removed.contains($0.id) }
        return removed
    }

    /// Nothing is left to do: the next visit starts on a clean page.
    public mutating func reset() {
        rows = []
        autoOpened = false
    }

    public static let receiptsButtonTitle = "Siirry kuitteihin"

    /// Kuitit's entry back to a queue whose screen was closed: "Kesken: 1 kuitti", "Kesken: 4 kuittia".
    public static func unfinishedTitle(_ count: Int) -> String {
        count == 1 ? "Kesken: 1 kuitti" : "Kesken: \(count) kuittia"
    }

    /// "Näytä tarkistettavat (3)" once the queue has settled; nil when nothing waits in the review queue.
    public var reviewButtonTitle: String? {
        guard isFinished, reviewCount > 0 else { return nil }
        return "Näytä tarkistettavat (\(reviewCount))"
    }

    /// The line under the queue once the files are through, as the web's upload summary:
    /// "Hyväksyttiin automaattisesti 12 · 3 odottaa tarkistusta · 1 epäonnistui". Nil while files
    /// are still going up, and when nothing was saved or waits for a check.
    public var summaryLine: String? {
        guard !isWorking else { return nil }
        let saved = rows.filter { $0.status == .saved }
        let approved = saved.filter { $0.autoApproved }.count
        // Saved by a server that did not say whether it approved (it approves by default).
        let unknown = saved.filter { !$0.approvalKnown }.count
        // A saved receipt the server did not approve waits in Kuitit; a file read but not yet saved waits here.
        let waiting = saved.count - approved - unknown + rows.filter { $0.status == .ready }.count
        let failed = rows.filter { $0.status == .failed }.count
        var parts: [String] = []
        if approved > 0 { parts.append("Hyväksyttiin automaattisesti \(approved)") }
        if unknown > 0 { parts.append("Tallennettiin \(unknown)") }
        if waiting > 0 { parts.append("\(waiting) odottaa tarkistusta") }
        if failed > 0 && !parts.isEmpty { parts.append("\(failed) epäonnistui") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

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
