import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import VisionKit
import UniformTypeIdentifiers
import LashKirjaCore

/// Lisää kuitti: camera, photos (up to 25 at once) or files (PDF, images) → the files are
/// uploaded in turn and read side by side → the owner checks the fields → save (web `ReceiptUploadArea.tsx`).
/// The first file read opens in the editor by itself; the rest wait in "Lähetysjono" with
/// "Käytä lomakkeessa". Without a connection the files are kept on the phone and sent later
/// (`OfflineReceiptQueueModel`). With `transactionId` one receipt is picked and the saved one
/// is matched to that bank row.
struct CaptureFlow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let transactionId: String?
    /// Called after each receipt is saved (and matched). Not called when the flow is cancelled.
    var onSaved: (() -> Void)? = nil

    /// `opensCamera`: a missing-receipt action goes straight to the camera; "+" → "Lisää kuitti"
    /// opens this page so the owner picks camera, photos or files.
    init(transactionId: String?, onSaved: (() -> Void)? = nil, opensCamera: Bool = true) {
        self.transactionId = transactionId
        self.onSaved = onSaved
        _showCamera = State(initialValue: opensCamera && CaptureFlow.cameraAvailable)
    }

    enum Step { case pick, queue, edit(rowId: String, draft: ReceiptDraft) }
    /// Where a picked file's bytes come from; read only when its turn comes, so ten photos are
    /// never all in memory at once.
    /// `refused`: a picked file that was never copied (too large, empty); its row fails with the reason.
    enum Source { case camera(UIImage), photo(PhotosPickerItem), file(URL), refused(String) }
    /// A file as it is sent: photos re-encoded to JPEG, PDFs as they are.
    struct Encoded: Sendable { let data: Data; let name: String; let mimeType: String }

    @State private var step: Step = .pick
    @State private var queue = ReceiptUploadQueue()
    @State private var sources: [String: Source] = [:]
    @State private var worker: Task<Void, Never>?
    /// One per file the server is reading: the next file goes up meanwhile, so all are read side by side.
    @State private var readers: [String: Task<Void, Never>] = [:]
    /// Bumped by "Peruuta lähetys": a cancelled worker finishing late must not clear a newer one.
    @State private var generation = 0
    @State private var showCamera: Bool
    @State private var showFiles = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var confirmDiscard = false
    @State private var importFailure: String?
    /// Copying picked files off the main actor; cancelled when the flow closes.
    @State private var importTask: Task<Void, Never>?
    @State private var limit = ShowMore()

    /// Matching a bank row takes exactly one receipt, and never goes to the offline queue
    /// (the inbox cannot match it).
    private var single: Bool { transactionId != nil }

    /// A file on its way, or read but not saved, is work the owner would lose.
    private var unsaved: Bool { editing || queue.holdsWork }

    private var editing: Bool {
        if case .edit = step { return true }
        return false
    }

    /// The document scanner where the device has one, else the plain camera.
    private static var cameraAvailable: Bool {
        VNDocumentCameraViewController.isSupported || UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private static let fileTypes: [UTType] = [.pdf, .jpeg, .png, .heic, .heif]

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .pick:
                    ScrollView { picker.padding(24) }
                case .queue:
                    queueList
                case .edit(let rowId, let draft):
                    ReceiptEditor(draft: draft, transactionId: transactionId) { saved(rowId) }
                        .id(rowId)
                }
            }
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle("Uusi kuitti")
            .onAppear { EventLog.shared.log(.screen(transactionId.map { "capture.forBankRow(\($0))" } ?? "capture")) }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if unsaved { confirmDiscard = true } else { close() } }
                }
                if editing && queue.rows.count > 1 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Lähetysjono") { step = .queue }
                    }
                }
            }
            .discardGuard(dirty: unsaved, busy: false, asking: $confirmDiscard) { close() }
            .fullScreenCover(isPresented: $showCamera) {
                if VNDocumentCameraViewController.isSupported {
                    DocumentScanner { images in
                        showCamera = false
                        addScanned(images)
                    }
                    .ignoresSafeArea()
                } else {
                    CameraPicker { image in
                        showCamera = false
                        if let image { add([(ReceiptUploadQueue.Pick(name: "kuitti.jpg", size: nil), .camera(image))]) }
                    }
                    .ignoresSafeArea()
                }
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: Self.fileTypes, allowsMultipleSelection: !single) { result in
                importFiles(result)
            }
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                // Cleared so that picking the same photos again after a failure still fires.
                photos = []
                let start = queue.rows.count
                add(items.enumerated().map { offset, item in
                    (ReceiptUploadQueue.Pick(name: ReceiptUploadFile.photoName(index: start + offset), size: nil), Source.photo(item))
                })
            }
        }
    }

    // MARK: Pieces

    private var picker: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.viewfinder").scaledFont(size: 54, relativeTo: .largeTitle).foregroundStyle(Theme.accent).accessibilityHidden(true)
            Text("Lisää kuva tai PDF kuitista tai laskusta").font(.headline).multilineTextAlignment(.center)
            pickButtons
            if let importFailure { Text(importFailure).font(.footnote).foregroundStyle(Theme.danger) }
        }
    }

    @ViewBuilder private var pickButtons: some View {
        if Self.cameraAvailable {
            Button { showCamera = true } label: { Label("Kuvaa kuitti", systemImage: "camera").frame(maxWidth: .infinity, minHeight: 44) }
                .buttonStyle(.primary)
        }
        PhotosPicker(selection: $photos, maxSelectionCount: single ? 1 : ReceiptUploadQueue.maxPick, matching: .images) {
            Label("Valitse kuvista", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        Button { showFiles = true } label: { Label("Valitse tiedosto", systemImage: "doc").frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.bordered)
    }

    private var queueList: some View {
        List {
            if queue.offlineCount > 0 {
                Text(OfflineReceiptRules.offlineNotice).font(.footnote).foregroundStyle(Theme.ink)
                    .listRowBackground(Theme.accentSoft)
            }
            Section {
                ForEach(queue.rows.prefix(limit.visible(queue.rows.count))) { row in queueRow(row) }
                ShowMoreButton(limit: $limit, total: queue.rows.count)
                if queue.isWorking {
                    Button("Peruuta lähetys") { cancelUploads() }.foregroundStyle(Theme.ink)
                }
                if queue.hasFailed {
                    Button("Yritä epäonnistuneet") { retryFailed() }.foregroundStyle(Theme.accent)
                }
            } header: {
                Text("Lähetysjono")
            }
            if queue.isFinished {
                Section {
                    Button { close() } label: { Text("Valmis").frame(maxWidth: .infinity, minHeight: 44).font(.headline) }
                        .buttonStyle(.primary)
                        .listRowBackground(Color.clear)
                }
            }
            // Matching a bank row: another pick only once the first one is out of the way.
            if !single || !queue.holdsWork {
                Section {
                    pickButtons.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    if let importFailure { Text(importFailure).font(.footnote).foregroundStyle(Theme.danger) }
                } header: {
                    Text("Lisää")
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func queueRow(_ row: UploadQueueRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.name).lineLimitUnlessLarge().truncationMode(.middle)
                Spacer(minLength: 8)
                if row.status == .uploading || row.status == .processing { ProgressView().controlSize(.small) }
                Text(row.status.label).font(.caption).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
            }
            if let progress = row.progress, row.status != .ready {
                Text(progress).font(.caption).foregroundStyle(Theme.ink2)
            }
            if let error = row.error {
                Text(error).font(.caption).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
            }
            if row.status == .ready, let draft = row.draft {
                Button("Käytä lomakkeessa") {
                    Haptics.selection()
                    step = .edit(rowId: row.id, draft: draft)
                }
                .font(.caption.bold())
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accent)
            }
        }
    }

    // MARK: Picking

    /// Each scanned page is its own receipt, like each photo of a multi-pick; matching a bank row
    /// takes the first page only.
    private func addScanned(_ images: [UIImage]) {
        let pages = single ? Array(images.prefix(1)) : images
        let start = queue.rows.count
        add(pages.enumerated().map { offset, image in
            (ReceiptUploadQueue.Pick(name: ReceiptUploadFile.photoName(index: start + offset), size: nil), Source.camera(image))
        })
    }

    private func add(_ picks: [(ReceiptUploadQueue.Pick, Source)]) {
        guard !picks.isEmpty else { return }
        importFailure = nil
        let ids = queue.enqueue(picks.map(\.0))
        for (id, pick) in zip(ids, picks) { sources[id] = pick.1 }
        if case .pick = step { step = .queue }
        startWorker()
    }

    /// Files picked from Files are copied to the app's temporary folder, off the main actor (a
    /// large PDF must not freeze the screen): the access to the originals is opened here, while
    /// the picker's grant is fresh, and closed once each copy is made. A file over the limit is
    /// sized from its metadata and never copied.
    private func importFiles(_ result: Result<[URL], Error>) {
        let urls: [URL]
        switch result {
        case .success(let picked): urls = picked
        case .failure: importFailure = "Tiedostoa ei voitu avata."; return
        }
        let scoped = urls.map { ($0, $0.startAccessingSecurityScopedResource()) }
        let maxBytes = ReceiptUploadQueue.maxBytes
        importTask = Task {
            var picks: [(ReceiptUploadQueue.Pick, Source)] = []
            var unreadable = 0
            for (url, didScope) in scoped {
                var copied: Result<LocalFile.Copied, LocalFile.Problem> = .failure(.unreadable)
                if !Task.isCancelled { copied = await LocalFile.copyToTemporary(url, prefix: "kuitti", maxBytes: maxBytes) }
                if didScope { url.stopAccessingSecurityScopedResource() }
                switch copied {
                case .success(let copy):
                    picks.append((ReceiptUploadQueue.Pick(name: url.lastPathComponent, size: copy.size), .file(copy.url)))
                case .failure(.unreadable):
                    unreadable += 1
                case .failure(let problem):
                    picks.append((ReceiptUploadQueue.Pick(name: url.lastPathComponent, size: nil), .refused(problem.message(maxBytes: maxBytes))))
                }
            }
            importTask = nil
            // Closed meanwhile: the copies are not kept.
            guard !Task.isCancelled else {
                for case (_, .file(let copy)) in picks { try? FileManager.default.removeItem(at: copy) }
                return
            }
            add(picks)
            if unreadable > 0 { importFailure = unreadable == 1 ? "Yhtä tiedostoa ei voitu avata." : "\(unreadable) tiedostoa ei voitu avata." }
        }
    }

    // MARK: Sending

    private func startWorker() {
        guard worker == nil else { return }
        let mine = generation
        worker = Task {
            while !Task.isCancelled, let next = queue.nextPending {
                await process(next.id, name: next.name)
            }
            if generation == mine { worker = nil }
        }
    }

    private func stopWorker() {
        generation += 1
        worker?.cancel()
        worker = nil
        for reader in readers.values { reader.cancel() }
        readers = [:]
    }

    /// "Peruuta lähetys": what has not finished stops; read and failed files stay.
    private func cancelUploads() {
        stopWorker()
        queue.cancelPending()
        Haptics.selection()
    }

    private func retryFailed() {
        queue.retryFailed()
        startWorker()
    }

    private func process(_ id: String, name: String) async {
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
                readers[id] = Task { await awaitReading(id, jobId: jobId, uploadId: result.uploadId, file: file) }
                return
            }
            finishReading(id, uploadId: result.uploadId, extracted: result.extracted)
        } catch is CancellationError {
            queue.markCancelled(id)
        } catch let error where !single && ReceiptUploadFile.isNetworkFailure(error) {
            keepOffline(id, file)
        } catch {
            queue.markFailed(id, error.userMessage)
        }
    }

    /// Waits for the server's reading of one uploaded file; runs beside the uploads of the others.
    private func awaitReading(_ id: String, jobId: String, uploadId: String, file: Encoded) async {
        defer { readers[id] = nil }
        do {
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                let job: JobResponse = try await app.api.get("/api/jobs/\(jobId)")
                if job.job.isFinished {
                    // Not status 0: a reading the server gave up on is not a lost connection.
                    if job.job.status != "done" { throw LKError(status: 422, message: job.job.error ?? "Kuitin luku epäonnistui.") }
                    finishReading(id, uploadId: uploadId, extracted: job.job.extracted)
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

    private func finishReading(_ id: String, uploadId: String, extracted: Extracted?) {
        queue.markReady(id, draft: ReceiptDraft(uploadId: uploadId, extracted: extracted))
        dropSource(id)
        if case .queue = step, let row = queue.takeAutoOpen(), let draft = row.draft {
            step = .edit(rowId: row.id, draft: draft)
        }
    }

    private func keepOffline(_ id: String, _ file: Encoded) {
        if OfflineReceiptQueueModel.shared.enqueue(app: app, data: file.data, fileName: file.name, mimeType: file.mimeType) {
            queue.markOffline(id)
            dropSource(id)
        } else {
            queue.markFailed(id, "Kuvaa ei voitu tallentaa puhelimeen.")
        }
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

    // MARK: Closing

    private func saved(_ rowId: String) {
        queue.markSaved(rowId)
        onSaved?()
        // A bank row takes one receipt: once it is saved the match is done.
        if single || queue.closesAfterSave { close() } else { step = .queue }
    }

    private func close() {
        importTask?.cancel()
        stopWorker()
        removeTemporaryFiles()
        dismiss()
    }

    private func dropSource(_ id: String) {
        if case .file(let url)? = sources[id] { try? FileManager.default.removeItem(at: url) }
        sources[id] = nil
    }

    private func removeTemporaryFiles() {
        for id in Array(sources.keys) { dropSource(id) }
    }
}

/// The fields of a receipt that was just read, as the web editor shows a new
/// receipt: editable VAT rows that follow the total (and, while nobody chose
/// the rate, the date).
struct ReceiptEditor: View {
    @Environment(AppModel.self) private var app
    let uploadId: String
    let transactionId: String?
    let done: () -> Void
    @State private var form: ReceiptForm
    @State private var errors: [String: String] = [:]
    @State private var busy = false
    @State private var failure: String?
    @State private var duplicate = false
    @State private var savedId: String?
    @State private var customCategory: Bool

    init(draft: ReceiptDraft, transactionId: String?, done: @escaping () -> Void) {
        let form = ReceiptForm(draft: draft)
        uploadId = draft.uploadId
        self.transactionId = transactionId
        self.done = done
        _form = State(initialValue: form)
        _customCategory = State(initialValue: !form.category.isEmpty && !form.isKnownCategory)
    }

    var body: some View {
        Form {
            Section {
                Picker("Laji", selection: $form.type) {
                    Text("Meno").tag("meno")
                    Text("Tulo").tag("tulo")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                TextField("Myyjä", text: $form.vendor).textContentType(.organizationName)
                fieldError("vendor")
                DatePicker("Päivä", selection: dateBinding, displayedComponents: .date)
                fieldError("date")
                TextField("Summa €", text: Binding(get: { form.totalText }, set: { form.setTotal($0) }))
                    .moneyInput()
                fieldError("totalAmount")
            }
            Section {
                ReceiptCategoryField(category: $form.category, custom: $customCategory)
                fieldError("category")
            } header: {
                Text("Kategoria")
            }
            vatSection
            Section {
                TextField("Viitenumero", text: $form.reference)
                fieldError("reference")
                TextField("Laskun numero", text: $form.invoiceNumber)
                fieldError("invoiceNumber")
                TextField("Muistiinpano", text: $form.notes, axis: .vertical)
                fieldError("notes")
            } header: {
                Text("Lisätiedot")
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            if duplicate {
                Section {
                    Button("Tallenna silti") { Task { await save(forceDuplicate: true) } }
                        .disabled(busy)
                } footer: { Text("Sama kuitti on jo tallennettu.") }
            }
            Section {
                Button { Task { await save(forceDuplicate: false) } } label: {
                    Text("Tallenna kuitti").frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                }
                .buttonStyle(.primary)
                .disabled(busy)
                .listRowBackground(Color.clear)
            }
        }
        .onAppear {
            if form.date.isEmpty { form.setDate(APIDate.dayString(Date())) }
        }
    }

    private var dateBinding: Binding<Date> {
        Binding(get: { APIDate.day(form.date) ?? Date() }, set: { form.setDate(APIDate.dayString($0)) })
    }

    @ViewBuilder private func fieldError(_ key: String) -> some View {
        if let message = errors[key] {
            Text(message).font(.caption).foregroundStyle(Theme.danger)
        }
    }

    private var vatSection: some View {
        Section {
            if form.vatRows.isEmpty {
                Text("Ei ALV-erittelyä").foregroundStyle(Theme.ink2)
            }
            ForEach(Array(form.vatRows.enumerated()), id: \.element.id) { index, row in
                HStack {
                    Picker("ALV", selection: Binding(get: { row.rate }, set: { form.setRate($0, at: index) })) {
                        ForEach(ReceiptVat.rateChoices(forDate: form.date, including: row.rate), id: \.self) { rate in
                            Text(ReceiptVat.rateLabel(rate)).tag(rate)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                    TextField("ALV €", text: Binding(get: { row.amountText }, set: { form.setVatAmount($0, at: index) }))
                        .moneyInput()
                        .multilineTextAlignment(.trailing)
                    Button(role: .destructive) { form.removeVatRow(at: index) } label: { Image(systemName: "minus.circle").tapTarget() }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Poista ALV-rivi")
                }
                fieldError("vat-\(index)")
            }
            Button { form.addVatRow() } label: { Label("Lisää ALV-rivi", systemImage: "plus.circle") }
        } header: {
            Text("ALV")
        } footer: {
            if form.vatRows.count == 1 && form.vatRows[0].auto {
                Text("ALV lasketaan summasta ja ALV-kannasta.")
            }
        }
    }

    private func save(forceDuplicate: Bool) async {
        guard !busy else { return }
        struct Saved: Decodable { struct R: Decodable { let id: String }; let receipt: R }
        struct Match: Encodable { let transactionId: String; let receiptId: String }
        // A retry after a failed match only repeats the match, never the save.
        var request: ReceiptDraft?
        if savedId == nil {
            switch form.makeDraft(uploadId: uploadId, forceDuplicate: forceDuplicate) {
            case .invalid(let found):
                errors = found
                failure = nil
                Haptics.error()
                return
            case .draft(let draft):
                request = draft
            }
        }
        errors = [:]
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let receiptId: String
            if let savedId {
                receiptId = savedId
            } else if let request {
                let saved: Saved = try await app.api.send("POST", "/api/receipts/save", body: request)
                receiptId = saved.receipt.id
                savedId = receiptId
                duplicate = false
            } else {
                return
            }
            if let transactionId {
                let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Match(transactionId: transactionId, receiptId: receiptId))
            }
            Haptics.success()
            done()
        } catch is CancellationError {
        } catch let error as LKError where error.isDuplicate && savedId == nil {
            duplicate = true
            failure = error.message
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// Receipt photos as the upload sends them: at most `CaptureImageSizing.maxSide`
/// pixels on the longest side, JPEG. Called off the main actor.
enum ReceiptImageEncoder {
    /// Photo library data: ImageIO decodes straight at the target size, never the full bitmap.
    static func jpeg(fromData data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        var longest = CaptureImageSizing.maxSide
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let w = props[kCGImagePropertyPixelWidth] as? Double, let h = props[kCGImagePropertyPixelHeight] as? Double {
            longest = min(CaptureImageSizing.maxSide, max(w, h))
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(longest),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: CaptureImageSizing.jpegQuality)
    }

    /// A camera photo: drawn once at the target size (orientation applied), then JPEG.
    static func jpeg(from image: UIImage) -> Data? {
        let width = Double(image.size.width * image.scale)
        let height = Double(image.size.height * image.scale)
        guard CaptureImageSizing.needsResize(width: width, height: height) else {
            return image.jpegData(compressionQuality: CaptureImageSizing.jpegQuality)
        }
        let target = CaptureImageSizing.targetSize(width: width, height: height)
        let size = CGSize(width: target.width, height: target.height)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return scaled.jpegData(compressionQuality: CaptureImageSizing.jpegQuality)
    }
}

/// The system camera, as SwiftUI.
struct CameraPicker: UIViewControllerRepresentable {
    let completion: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (UIImage?) -> Void
        init(completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            completion(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
    }
}
