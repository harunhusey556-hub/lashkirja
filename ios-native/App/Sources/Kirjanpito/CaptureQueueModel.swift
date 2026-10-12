import SwiftUI
import PhotosUI
import UIKit
import LashKirjaCore

/// The "Lisää kuitti" queue (web `useReceiptUploadQueue.ts`), kept apart from its screen so that
/// leaving the screen never loses a file (owner, 2026-10-12: going back from the form discarded the
/// other files). Back from the form returns to the same rows; closing the screen leaves the
/// uploads, readings and saves running, and Kuitit offers "Kesken: N kuittia" to come back. A
/// reading not yet saved is also written to the phone (`UnfinishedReadingStore`), so it is still
/// there after the app restarts, for as long as the server keeps its upload.
///
/// Saves go through `ReceiptSaving`: the current server approves complete receipts as they are
/// saved (`autoApprove`); a server from before wave 2 refuses the flag with a 400, so the save is
/// sent again without it and the flag is left out for the rest of the app run.
///
/// Matching one bank row takes a model of its own that ends with its screen.
@MainActor
@Observable
final class CaptureQueueModel {
    /// The bulk queue of the app run.
    static let shared = CaptureQueueModel(store: UnfinishedReadingStore.standard())

    enum Step { case pick, queue, edit(rowId: String, draft: ReceiptDraft) }
    /// Where a picked file's bytes come from; read only when its turn comes, so the two hundred
    /// photos of a full pick are never all in memory at once.
    /// `refused`: a picked file that was never copied (too large, empty); its row fails with the reason.
    enum Source { case camera(UIImage), photo(PhotosPickerItem), file(URL), refused(String) }
    /// A file as it is sent: photos re-encoded to JPEG, PDFs as they are.
    struct Encoded: Sendable { let data: Data; let name: String; let mimeType: String }

    /// Whether the server takes `autoApprove`: learned from the first save, kept for the app run.
    static var flagSupport: ReceiptSaving.FlagSupport = .unknown

    private(set) var queue = ReceiptUploadQueue()
    var step: Step = .pick
    /// Each read row's file as it was sent, on the phone: the form shows it above the fields.
    private(set) var previews: [String: URL] = [:]
    /// Set by a saved bank-row match or the last save: the screen closes itself.
    private(set) var closeRequested = false
    /// Set by Kuitit's "Jatka": the screen opens on the queue, not on the camera.
    var resuming = false
    /// Said for a few seconds after a single file is saved as a bill ("Tallennettu · ostolasku luotu, …").
    private(set) var notice: String?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    let transactionId: String?
    /// Called after each receipt is saved (and matched); set by the screen.
    @ObservationIgnored var onSaved: (() -> Void)?
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var app: AppModel?
    @ObservationIgnored private var userId: String?
    /// Nil for a bank-row match: nothing of it is kept after its screen.
    private let store: UnfinishedReadingStore?
    /// Where the pictures go: the store's folder, or a temporary one for a bank-row match.
    private let previewStore: UnfinishedReadingStore
    @ObservationIgnored private var sources: [String: Source] = [:]
    @ObservationIgnored private var readAt: [String: Date] = [:]
    @ObservationIgnored private var worker: Task<Void, Never>?
    /// One per file the server is reading: the next file goes up meanwhile, so all are read side by side.
    @ObservationIgnored private var readers: [String: Task<Void, Never>] = [:]
    /// Saves of finished readings, bounded apart from the uploads (each save runs the bank matching).
    @ObservationIgnored private var saver: Task<Void, Never>?
    /// Bumped by "Peruuta lähetys": a cancelled worker finishing late must not clear a newer one.
    @ObservationIgnored private var generation = 0

    init(transactionId: String? = nil, store: UnfinishedReadingStore? = nil) {
        self.transactionId = transactionId
        self.store = store
        previewStore = store ?? UnfinishedReadingStore(
            directory: FileManager.default.temporaryDirectory.appendingPathComponent("capture-\(UUID().uuidString)", isDirectory: true))
    }

    /// Matching a bank row takes exactly one receipt, and never goes to the offline queue
    /// (the inbox cannot match it).
    var single: Bool { transactionId != nil }

    var editing: Bool {
        if case .edit = step { return true }
        return false
    }

    /// Kuitit's "Kesken: N kuittia": files on their way, or read and not saved.
    var unfinishedCount: Int { queue.unfinishedCount }

    // MARK: Screen

    /// The screen opened (once per presentation). A queue with nothing left to do is not kept: the
    /// visit starts on a clean page. Readings kept from an earlier run come back here.
    func open(app: AppModel) {
        prepare(app: app)
        visible = true
        closeRequested = false
        if !queue.holdsWork { forgetRows() }
        if queue.rows.isEmpty {
            step = .pick
        } else if case .pick = step {
            step = .queue
        }
    }

    /// The screen closed. The bulk queue goes on without it; a bank-row match ends with it.
    func screenClosed() {
        visible = false
        closeRequested = false
        resuming = false
        onSaved = nil
        noticeTask?.cancel()
        noticeTask = nil
        notice = nil
        if single {
            stopWorker()
            forgetRows()
            previewStore.removeAll()
            return
        }
        if editing { step = .queue }
        if !queue.holdsWork { forgetRows() }
        persist()
    }

    func openForm(_ row: UploadQueueRow) {
        guard let draft = row.draft else { return }
        step = .edit(rowId: row.id, draft: draft)
    }

    /// Back from the form: every other row is where it was; this one waits for the form again.
    func leaveForm() {
        step = queue.rows.isEmpty ? .pick : .queue
    }

    /// Binds the queue to the signed-in owner and brings back the readings an earlier run kept, so
    /// Kuitit can offer them before the screen is opened (`OfflineReceiptQueueModel.start` calls
    /// this). Safe to call often. Another account's rows are never shown: they go.
    func prepare(app: AppModel) {
        self.app = app
        guard case .signedIn(let user) = app.phase, userId != user.userId else { return }
        if userId != nil { forgetRows() }
        userId = user.userId
        guard let store, queue.rows.isEmpty else { return }
        restore(store.load(userId: user.userId))
        // Expired readings and their pictures leave the phone now.
        persist()
    }

    /// Readings an earlier run kept come back as rows waiting for the form, with their pictures.
    func restore(_ kept: [UnfinishedReading]) {
        queue.restore(kept)
        for reading in kept {
            readAt[reading.id] = reading.readAt
            if let name = reading.previewName { previews[reading.id] = previewStore.previewURL(name) }
        }
        if !queue.rows.isEmpty, case .pick = step { step = .queue }
    }

    /// Sign-out: nothing of the owner who left stays, in memory or on the phone.
    func clearForSignOut() {
        forgetRows()
        userId = nil
        app = nil
        store?.removeAll()
    }

    private func forgetRows() {
        stopWorker()
        removeTemporaryFiles()
        queue.reset()
        previews = [:]
        readAt = [:]
        step = .pick
    }

    // MARK: Adding

    func add(_ picks: [(ReceiptUploadQueue.Pick, Source)]) {
        guard !picks.isEmpty else { return }
        let ids = queue.enqueue(picks.map(\.0))
        for (id, pick) in zip(ids, picks) { sources[id] = pick.1 }
        if case .pick = step { step = .queue }
        startWorker()
    }

    /// "Hylkää tallentamattomat": the readings nobody saved leave the queue and the phone.
    func discardUnsaved() {
        for id in queue.discardUnsaved() { dropSource(id) }
        persist()
        if queue.rows.isEmpty { step = .pick }
    }

    // MARK: Sending

    private func startWorker() {
        guard worker == nil else { return }
        let mine = generation
        worker = Task {
            // A hundred photos one by one take all night: up to `uploadConcurrency` go up at once,
            // and a slot freed by one file is refilled from the queue straight away. Every row
            // update still happens on the main actor, inside `process`.
            await withTaskGroup(of: Void.self) { group in
                while !Task.isCancelled {
                    while let next = self.queue.claimNext() {
                        group.addTask { await self.process(next.id, name: next.name) }
                    }
                    // Nothing more may start: wait for one upload to finish, or stop when none is left.
                    if await group.next() == nil { break }
                }
            }
            if self.generation == mine { self.worker = nil }
        }
    }

    /// Saves finished readings, `saveConcurrency` at a time (the web's save limiter); a slot freed by
    /// one save is refilled at once, and one refused save never stops the rest.
    private func startSaveWorker() {
        guard saver == nil else { return }
        let mine = generation
        saver = Task {
            repeat {
                await withTaskGroup(of: Void.self) { group in
                    while !Task.isCancelled {
                        while let next = self.queue.claimNextSave() {
                            group.addTask { await self.saveRead(next.id) }
                        }
                        if await group.next() == nil { break }
                    }
                }
                // A reading queued while the group was winding down is picked up here; nothing
                // suspends between this check and clearing `saver`, so none can be missed.
            } while !Task.isCancelled && queue.nextSaveQueued != nil
            if self.generation == mine { self.saver = nil }
        }
    }

    private func stopWorker() {
        generation += 1
        worker?.cancel()
        worker = nil
        saver?.cancel()
        saver = nil
        for reader in readers.values { reader.cancel() }
        readers = [:]
    }

    /// "Peruuta lähetys": what has not finished stops; read and failed files stay.
    func cancelUploads() {
        stopWorker()
        queue.cancelPending()
        persist()
    }

    func retryFailed() {
        queue.retryFailed()
        startWorker()
        startSaveWorker()
    }

    /// Saves one finished reading and asks the server to approve it when it is complete. Like the
    /// web, a look-alike of a receipt already on file is saved anyway, as pending (the server never
    /// approves a forced duplicate), so the owner decides in the review queue instead of it vanishing.
    private func saveRead(_ id: String) async {
        guard let draft = queue.row(id)?.draft else {
            queue.markFailed(id, "Kuittia ei voitu tallentaa.")
            return
        }
        do {
            let outcome = try await save(draft, saveDuplicateAnyway: true)
            queue.markSaved(id, autoApproved: outcome.approved, duplicate: outcome.duplicate, invoiceNote: outcome.invoiceNote)
            // A lone file has no list of rows to read the outcome from, so it is also said aloud.
            if queue.rows.count == 1 { announce(outcome.invoiceNote) }
            onSaved?()
        } catch {
            // Kept with its reading: "Avaa lomake" or "Yritä epäonnistuneet" take it from here.
            queue.markFailed(id, error.userMessage)
        }
        persist()
    }

    /// One save, for the queue and the form alike (`ReceiptSaving`); what it learns about the
    /// server's `autoApprove` is kept for the next saves.
    func save(_ draft: ReceiptDraft, saveDuplicateAnyway: Bool) async throws -> ReceiptSaving.Outcome {
        guard let api = app?.api else { throw LKError(status: 0, message: LKError.unreachable) }
        let outcome = try await ReceiptSaving.save(draft, support: Self.flagSupport, saveDuplicateAnyway: saveDuplicateAnyway) { body in
            try await Self.post(body, api: api)
        }
        if outcome.support == .unsupported && Self.flagSupport != .unsupported {
            EventLog.shared.log(.action("save-without-autoApprove", screen: "capture"))
        }
        Self.flagSupport = outcome.support
        return outcome
    }

    /// Not tied to the caller's cancellation: a save already sent must finish, or the owner could
    /// not tell whether the receipt exists.
    private nonisolated static func post(_ body: ReceiptDraft, api: APIClient) async throws -> ReceiptSaveResult {
        let sent = Task<ReceiptSaveResult, Error> {
            let result: ReceiptSaveResult = try await api.send("POST", "/api/receipts/save", body: body)
            return result
        }
        return try await sent.value
    }

    /// A receipt saved from the form (or a bank row linked to the receipt its file already was).
    func saved(_ rowId: String, autoApproved: Bool? = false, invoiceNote: String? = nil) {
        queue.markSaved(rowId, autoApproved: autoApproved, invoiceNote: invoiceNote)
        onSaved?()
        persist()
        // A bank row takes one receipt: once it is saved the match is done.
        if single { closeRequested = true; return }
        announce(invoiceNote)
        // A bill that became an ostolasku keeps the screen up: its row and the toast say so, and
        // "Valmis" closes it. Any other last save closes the screen at once.
        if invoiceNote == nil && queue.closesAfterSave { closeRequested = true } else { step = .queue }
    }

    /// "Älä tallenna" on the look-alike question (W27): the staged file is deleted on the server and
    /// the row says "Ohitettu (kaksoiskappale)" instead of waiting under "Kesken" for good. Back on
    /// the queue, so the owner sees what happened; a bank-row match has nothing left to do and ends.
    func skipDuplicate(_ rowId: String, uploadId: String) async throws {
        guard let api = app?.api else { throw LKError(status: 0, message: LKError.unreachable) }
        try await ReceiptSaving.discardDuplicate(uploadId: uploadId) { path in
            let _: Ignored = try await api.send("DELETE", path, body: Optional<EmptyBody>.none)
        }
        queue.markSkippedDuplicate(rowId)
        persist()
        if single { closeRequested = true; return }
        say(UploadQueueStatus.skipped.label)
        step = .queue
    }

    /// "Tallennettu · ostolasku luotu, eräpäivä 14.10.2026" for a few seconds; nothing for a plain receipt.
    private func announce(_ invoiceNote: String?) {
        guard let invoiceNote else { return }
        say("Tallennettu · \(invoiceNote)")
    }

    private func say(_ text: String) {
        noticeTask?.cancel()
        notice = text
        noticeTask = Task {
            // A cancelled sleep means a newer notice or a closed screen already took over.
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            self.notice = nil
        }
    }

    private func process(_ id: String, name: String) async {
        guard let app else {
            queue.markFailed(id, "Tiedostoa ei voitu lukea.")
            return
        }
        guard let source = sources[id] else {
            queue.markFailed(id, "Tiedostoa ei voitu lukea.")
            return
        }
        if case .refused(let reason) = source {
            queue.markFailed(id, reason)
            return
        }
        queue.markUploading(id)
        guard let file = await Self.encode(source, name: name) else {
            queue.markFailed(id, "Kuvaa ei voitu lukea.")
            return
        }
        guard !Task.isCancelled else { queue.markCancelled(id); return }
        if let problem = ReceiptUploadQueue.validate(name: file.name, size: file.data.count) {
            queue.markFailed(id, problem)
            return
        }
        // No network at all: kept on the phone straight away instead of waiting for a timeout.
        if !single && !Connectivity.shared.online {
            keepOffline(id, file)
            return
        }
        var form = Multipart()
        form.addFile("file", filename: file.name, mimeType: file.mimeType, data: file.data)
        do {
            let response = try await app.api.raw("POST", "/api/receipts", body: form.finalize(), contentType: form.contentType)
            let result = try JSONDecoder().decode(UploadResult.self, from: response.body)
            if result.extracted == nil, let jobId = result.jobId {
                queue.markProcessing(id)
                readers[id] = Task { await self.awaitReading(id, jobId: jobId, uploadId: result.uploadId, file: file) }
                return
            }
            finishReading(id, uploadId: result.uploadId, extracted: result.extracted, file: file)
        } catch is CancellationError {
            queue.markCancelled(id)
        } catch let error as LKError where single && error.duplicateReceiptId != nil {
            // Taken from a bank row, and the file is already a receipt: link that receipt to the
            // row instead of stopping at "Tämä kuitti on jo tallennettu" (2026-10-08).
            await linkExisting(id, receiptId: error.duplicateReceiptId!)
        } catch let error where !single && ReceiptUploadFile.isNetworkFailure(error) {
            keepOffline(id, file)
        } catch {
            queue.markFailed(id, error.userMessage)
        }
    }

    private func linkExisting(_ id: String, receiptId: String) async {
        struct Match: Encodable { let transactionId: String; let receiptId: String }
        guard let transactionId, let app else { return }
        EventLog.shared.log(.action("link-existing-receipt", screen: "capture"))
        do {
            let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Match(transactionId: transactionId, receiptId: receiptId))
            dropSource(id)
            Haptics.success()
            saved(id)
        } catch is CancellationError {
            queue.markCancelled(id)
        } catch {
            queue.markFailed(id, "Kuitti oli jo tallennettu, mutta sitä ei voitu kohdistaa tähän tapahtumaan: \(error.userMessage)")
        }
    }

    /// Waits for the server's reading of one uploaded file; runs beside the uploads of the others.
    private func awaitReading(_ id: String, jobId: String, uploadId: String, file: Encoded) async {
        defer { readers[id] = nil }
        guard let app else { return }
        do {
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                let job: JobResponse = try await app.api.get("/api/jobs/\(jobId)")
                if job.job.isFinished {
                    // Not status 0: a reading the server gave up on is not a lost connection.
                    if job.job.status != "done" { throw LKError(status: 422, message: job.job.error ?? "Kuitin luku epäonnistui.") }
                    finishReading(id, uploadId: uploadId, extracted: job.job.extracted, file: file)
                    return
                }
            }
            queue.markBackground(id)
            dropSource(id)
        } catch is CancellationError {
            queue.markCancelled(id)
        } catch let error where !single && ReceiptUploadFile.isNetworkFailure(error) {
            keepOffline(id, file)
        } catch {
            queue.markFailed(id, error.userMessage)
        }
    }

    private func finishReading(_ id: String, uploadId: String, extracted: Extracted?, file: Encoded) {
        let reading = ReceiptDraft(uploadId: uploadId, extracted: extracted)
        keepPreview(id, file)
        readAt[id] = Date()
        // As the web: in a pick of several files every reading is saved at once, a single file only
        // when complete; matching one bank row needs the form's save (it links the receipt).
        if !single, AutoAccept.takesAutoSavePath(several: queue.rows.count > 1, reading: extracted) {
            queue.markSaveQueued(id, draft: reading)
            dropSource(id)
            persist()
            startSaveWorker()
            return
        }
        queue.markReady(id, draft: reading)
        dropSource(id)
        persist()
        // The first reading that needs the owner opens by itself, only while the screen is up.
        if visible, case .queue = step, let row = queue.takeAutoOpen(), let draft = row.draft {
            step = .edit(rowId: row.id, draft: draft)
        }
    }

    private func keepOffline(_ id: String, _ file: Encoded) {
        guard let app, OfflineReceiptQueueModel.shared.enqueue(app: app, data: file.data, fileName: file.name, mimeType: file.mimeType) else {
            queue.markFailed(id, "Kuvaa ei voitu tallentaa puhelimeen.")
            return
        }
        queue.markOffline(id)
        dropSource(id)
    }

    /// The file just sent is the picture the form shows: no download, it is already here.
    private func keepPreview(_ id: String, _ file: Encoded) {
        do {
            let name = try previewStore.writePreview(id: id, data: file.data, isPDF: file.mimeType == "application/pdf")
            previews[id] = previewStore.previewURL(name)
        } catch {
            // The reading goes on without its picture; the form then shows the fields alone.
            EventLog.shared.log(.action("capture-preview-not-kept", screen: "capture"))
        }
    }

    /// Writes the readings not yet saved to the phone, and lets go of the pictures of saved ones.
    private func persist() {
        guard let store, let userId else { return }
        let readings = queue.unsavedReadings.compactMap { row -> UnfinishedReading? in
            guard let draft = row.draft else { return nil }
            return UnfinishedReading(id: row.id, name: row.name, draft: draft, readAt: readAt[row.id] ?? Date(),
                                     previewName: previews[row.id]?.lastPathComponent)
        }
        do {
            try store.save(userId: userId, readings: readings)
        } catch {
            // Still in memory for this run; only a restart would lose them.
            EventLog.shared.log(.action("capture-readings-not-kept", screen: "capture"))
        }
        // The store removed the pictures of rows no longer waiting (saved, discarded).
        let keep = Set(readings.map(\.id))
        previews = previews.filter { keep.contains($0.key) }
        readAt = readAt.filter { keep.contains($0.key) }
    }

    /// Decoding and scaling a 12–48 MP photo is heavy: it runs off the main actor.
    private static func encode(_ source: Source, name: String) async -> Encoded? {
        switch source {
        case .camera(let image):
            let jpeg = await Task.detached(priority: .userInitiated) { ReceiptImageEncoder.jpeg(from: image) }.value
            return jpeg.map { Encoded(data: $0, name: name, mimeType: "image/jpeg") }
        case .photo(let item):
            guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
            let jpeg = await Task.detached(priority: .userInitiated) { ReceiptImageEncoder.jpeg(fromData: data) }.value
            return jpeg.map { Encoded(data: $0, name: name, mimeType: "image/jpeg") }
        case .file(let url):
            guard case .success(let data) = await LocalFile.read(url, maxBytes: ReceiptUploadQueue.maxBytes) else { return nil }
            if ReceiptUploadFile.isPDF(name: name) { return Encoded(data: data, name: name, mimeType: "application/pdf") }
            let jpeg = await Task.detached(priority: .userInitiated) { ReceiptImageEncoder.jpeg(fromData: data) }.value
            return jpeg.map { Encoded(data: $0, name: ReceiptUploadFile.jpegName(for: name), mimeType: "image/jpeg") }
        case .refused:
            return nil
        }
    }

    private func dropSource(_ id: String) {
        if case .file(let url)? = sources[id] { try? FileManager.default.removeItem(at: url) }
        sources[id] = nil
    }

    private func removeTemporaryFiles() {
        for id in Array(sources.keys) { dropSource(id) }
    }
}
