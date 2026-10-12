import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import VisionKit
import UniformTypeIdentifiers
import LashKirjaCore

/// Lisää kuitti: camera, photos (up to `ReceiptUploadQueue.maxPick` at once) or files (PDF, images) →
/// the files are uploaded a few at a time and read side by side → the owner checks the fields → save (web `ReceiptUploadArea.tsx`).
/// In a pick of several files every reading is saved straight away, up to `saveConcurrency` at a
/// time (the server approves the complete ones, the rest wait in Kuitit's review queue); a single
/// file is saved at once only when its reading is complete (`AutoAccept`), otherwise the editor
/// opens on it, with the file's picture above the fields. A save the server refuses keeps its row
/// with "Avaa lomake". Without a connection the files are kept on the phone and sent later
/// (`OfflineReceiptQueueModel`). With `transactionId` one receipt is picked and the saved one
/// is matched to that bank row.
///
/// The queue lives in `CaptureQueueModel`, not here: back from the form returns to every row as
/// it was, and closing the screen leaves the files going (Kuitit shows "Kesken: N kuittia").
/// "Hylätäänkö muutokset?" guards only the one form being edited, never the queue; a bank-row
/// match is one receipt, so there it still guards the whole screen.
struct CaptureFlow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let transactionId: String?
    /// Called after each receipt is saved (and matched). Not called when the flow is cancelled.
    var onSaved: (() -> Void)? = nil

    /// `opensCamera`: a missing-receipt action goes straight to the camera; "+" → "Lisää kuitti"
    /// opens this page so the owner picks camera, photos or files. Kuitit's "Jatka" opens on the
    /// unfinished files instead.
    init(transactionId: String?, onSaved: (() -> Void)? = nil, opensCamera: Bool = true) {
        self.transactionId = transactionId
        self.onSaved = onSaved
        let model = transactionId == nil ? CaptureQueueModel.shared : CaptureQueueModel(transactionId: transactionId)
        _model = State(initialValue: model)
        _showCamera = State(initialValue: opensCamera && CaptureFlow.cameraAvailable && !model.resuming)
    }

    @State private var model: CaptureQueueModel
    /// The model is opened once per presentation, not again when the camera cover closes.
    @State private var opened = false
    @State private var showCamera: Bool
    @State private var showFiles = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var confirmDiscard = false
    @State private var confirmDropUnsaved = false
    /// The form on screen has changes the owner made (`ReceiptEditor`).
    @State private var formDirty = false
    @State private var importFailure: String?
    /// Copying picked files off the main actor; cancelled when the flow closes.
    @State private var importTask: Task<Void, Never>?
    /// A bulk import is hundreds of rows long: the list opens on 50 and grows by 50.
    @State private var limit = ShowMore(step: ReceiptUploadQueue.listPage)

    private var queue: ReceiptUploadQueue { model.queue }

    /// Matching a bank row takes exactly one receipt, and never goes to the offline queue
    /// (the inbox cannot match it).
    private var single: Bool { transactionId != nil }

    /// Matching a bank row: a file on its way, or read but not saved, is work the owner would lose.
    private var unsaved: Bool { model.editing || queue.holdsWork }

    /// What "Hylätäänkö muutokset?" guards: the whole bank-row match; in the bulk queue only the
    /// edits of the form on screen.
    private var guarded: Bool { single ? unsaved : (model.editing && formDirty) }

    /// Readings "Hylkää tallentamattomat" would drop (a save already on its way finishes).
    private var droppable: Int { queue.unsavedReadings.filter { $0.status != .saving }.count }

    /// The document scanner where the device has one, else the plain camera.
    private static var cameraAvailable: Bool {
        VNDocumentCameraViewController.isSupported || UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private static let fileTypes: [UTType] = [.pdf, .jpeg, .png, .heic, .heif]

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .pick:
                    ScrollView { picker.padding(24) }
                case .queue:
                    queueList
                case .edit(let rowId, let draft):
                    ReceiptEditor(model: model, rowId: rowId, draft: draft, preview: model.previews[rowId], dirty: $formDirty) { autoApproved, invoiceNote in
                        model.saved(rowId, autoApproved: autoApproved, invoiceNote: invoiceNote)
                    }
                    .id(rowId)
                }
            }
            .background(Theme.canvas)
            // A bill saved as an ostolasku is said aloud; the queue row keeps saying it.
            .overlay(alignment: .bottom) {
                if let notice = model.notice {
                    ToastView(toast: Toast(text: notice, actionLabel: nil)) {}
                        .padding(.bottom, 8)
                }
            }
            .formKeyboard()
            .navigationTitle("Uusi kuitti")
            .onAppear {
                EventLog.shared.log(.screen(transactionId.map { "capture.forBankRow(\($0))" } ?? "capture"))
                model.onSaved = onSaved
                guard !opened else { return }
                opened = true
                model.open(app: app)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { leadingButton }
            }
            .discardGuard(dirty: guarded, busy: false, asking: $confirmDiscard) { discard() }
            .confirmSheet(
                isPresented: $confirmDropUnsaved,
                title: droppable == 1 ? "Hylätäänkö tallentamaton kuitti?" : "Hylätäänkö \(droppable) tallentamatonta kuittia?",
                message: droppable == 1
                    ? "Yksi luettu tiedosto jää tallentamatta kuitiksi."
                    : "\(droppable) luettua tiedostoa jää tallentamatta kuiteiksi.",
                confirmTitle: "Hylkää"
            ) {
                model.discardUnsaved()
            }
            // A saved bank-row match, or the last save of the queue: the screen closes itself.
            .onChange(of: model.closeRequested) { _, now in
                if now { close() }
            }
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
                    (ReceiptUploadQueue.Pick(name: ReceiptUploadFile.photoName(index: start + offset), size: nil), CaptureQueueModel.Source.photo(item))
                })
            }
        }
    }

    // MARK: Pieces

    /// Back from the form to the queue (every other row as it was); closing the queue leaves it
    /// going. Matching a bank row is one receipt: "Peruuta" asks before dropping it.
    @ViewBuilder private var leadingButton: some View {
        if single {
            Button("Peruuta") { if unsaved { confirmDiscard = true } else { close() } }
        } else if model.editing {
            Button {
                if formDirty { confirmDiscard = true } else { leaveForm() }
            } label: {
                Label("Takaisin", systemImage: "chevron.backward").labelStyle(.titleAndIcon)
            }
        } else {
            Button(queue.rows.isEmpty ? "Peruuta" : "Sulje") { close() }
        }
    }

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
        // UI tests only (Debug + `-LKUITest`): the simulator has no camera to take a picture with.
        if UITestHooks.active {
            Button {
                add([(ReceiptUploadQueue.Pick(name: UITestHooks.fixtureName, size: nil), .camera(UITestHooks.fixtureReceipt()))])
            } label: { Label("Testikuitti", systemImage: "testtube.2").frame(maxWidth: .infinity, minHeight: 44) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("capture-fixture")
        }
    }

    private var queueList: some View {
        List {
            if queue.offlineCount > 0 {
                Text(OfflineReceiptRules.offlineNotice).font(.footnote).foregroundStyle(Theme.ink)
                    .listRowBackground(Theme.accentSoft)
            }
            if !single && queue.isWorking {
                Text("Lähetys jatkuu, vaikka suljet tämän näkymän. Kesken olevat kuitit löytyvät Kuiteista.")
                    .font(.footnote).foregroundStyle(Theme.ink2)
            }
            Section {
                ForEach(queue.rows.prefix(limit.visible(queue.rows.count))) { row in queueRow(row) }
                ShowMoreButton(limit: $limit, total: queue.rows.count)
                if queue.isWorking {
                    Button("Peruuta lähetys") { cancelUploads() }.foregroundStyle(Theme.ink)
                }
                if queue.hasFailed {
                    Button("Yritä epäonnistuneet") { model.retryFailed() }.foregroundStyle(Theme.accent)
                }
                if !single && droppable > 0 {
                    Button("Hylkää tallentamattomat", role: .destructive) { confirmDropUnsaved = true }
                        .foregroundStyle(Theme.danger)
                }
            } header: {
                Text("Lähetysjono")
            } footer: {
                // Same words as the web's upload summary.
                if let summary = queue.summaryLine { Text(summary) }
            }
            if queue.isFinished {
                Section {
                    // The queue has settled: the review queue and the list are one tap away.
                    if let title = queue.reviewButtonTitle {
                        Button { openReceipts() } label: { Text(title).frame(maxWidth: .infinity, minHeight: 44).font(.headline) }
                            .buttonStyle(.bordered)
                            .listRowBackground(Color.clear)
                    }
                    if queue.savedCount > 0 {
                        Button { openReceipts() } label: { Text(ReceiptUploadQueue.receiptsButtonTitle).frame(maxWidth: .infinity, minHeight: 44).font(.headline) }
                            .buttonStyle(.bordered)
                            .listRowBackground(Color.clear)
                    }
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
                if row.status == .uploading || row.status == .processing || row.status == .saving { ProgressView().controlSize(.small) }
                Text(row.status.label).font(.caption).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
            }
            if let progress = row.progress, row.status != .ready {
                Text(progress).font(.caption).foregroundStyle(Theme.ink2)
            }
            if let outcome = row.outcomeText {
                Text(outcome).font(.caption).foregroundStyle(Theme.ink2)
            }
            if let error = row.error {
                Text(error).font(.caption).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
            }
            // A save the server refused: the form takes the reading from there (web "Käytä lomakkeessa").
            if row.canOpenForm {
                Button("Avaa lomake") { openForm(row) }
                    .font(.caption.bold())
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
            }
            if row.status == .ready && row.draft != nil {
                Button("Käytä lomakkeessa") { openForm(row) }
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
            (ReceiptUploadQueue.Pick(name: ReceiptUploadFile.photoName(index: start + offset), size: nil), CaptureQueueModel.Source.camera(image))
        })
    }

    private func add(_ picks: [(ReceiptUploadQueue.Pick, CaptureQueueModel.Source)]) {
        guard !picks.isEmpty else { return }
        importFailure = nil
        model.add(picks)
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
            var picks: [(ReceiptUploadQueue.Pick, CaptureQueueModel.Source)] = []
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

    // MARK: Queue

    private func openForm(_ row: UploadQueueRow) {
        Haptics.selection()
        formDirty = false
        model.openForm(row)
    }

    private func leaveForm() {
        formDirty = false
        model.leaveForm()
    }

    /// "Hylkää muutokset": the bulk queue drops only the form's edits and returns to the queue.
    private func discard() {
        if single { close() } else { leaveForm() }
    }

    /// "Peruuta lähetys": what has not finished stops; read and failed files stay.
    private func cancelUploads() {
        model.cancelUploads()
        Haptics.selection()
    }

    /// "Näytä tarkistettavat" and "Siirry kuitteihin": Kuitit, whose review queue sits on top of the list.
    private func openReceipts() {
        app.pendingRoute = PendingRoute(tab: .kirjanpito, route: .receipts)
        close()
    }

    // MARK: Closing

    private func close() {
        importTask?.cancel()
        // Opened from Kuitit's "Jatka" (MainTabView's cover has no reload of its own): the lists
        // show what was saved meanwhile.
        if queue.savedCount > 0 { app.dataVersion += 1 }
        model.screenClosed()
        dismiss()
    }
}

/// The fields of a receipt that was just read, as the web editor shows a new
/// receipt: the file's picture on top, then editable VAT rows that follow the total (and, while
/// nobody chose the rate, the date).
struct ReceiptEditor: View {
    @Environment(AppModel.self) private var app
    let model: CaptureQueueModel
    /// The queue row this form is for: "Älä tallenna" marks it skipped.
    let rowId: String
    let uploadId: String
    let transactionId: String?
    /// The file as it was sent (`CaptureQueueModel.previews`); nil when it could not be kept.
    let preview: URL?
    /// True while the fields differ from the reading: only then does "Takaisin" ask first.
    @Binding var dirty: Bool
    /// Called with the server's approval (true/false, or nil from a server that did not say) and
    /// what it did with a bill ("ostolasku luotu, eräpäivä 14.10.2026"; nil for a plain receipt).
    let done: (Bool?, String?) -> Void
    @State private var form: ReceiptForm
    /// The form as it opened (with the default date filled in): what "dirty" compares with.
    @State private var baseline: ReceiptForm
    @State private var errors: [String: String] = [:]
    @State private var busy = false
    @State private var failure: String?
    @State private var duplicate = false
    @State private var savedId: String?
    /// Kept with `savedId`, so a retry that only repeats the match still reports the approval.
    @State private var savedAutoApproved: Bool? = false
    @State private var savedInvoiceNote: String?
    @State private var customCategory: Bool

    init(model: CaptureQueueModel, rowId: String, draft: ReceiptDraft, preview: URL?, dirty: Binding<Bool>, done: @escaping (Bool?, String?) -> Void) {
        let form = ReceiptForm(draft: draft)
        self.model = model
        self.rowId = rowId
        uploadId = draft.uploadId
        transactionId = model.transactionId
        self.preview = preview
        _dirty = dirty
        self.done = done
        _form = State(initialValue: form)
        _baseline = State(initialValue: form)
        _customCategory = State(initialValue: !form.category.isEmpty && !form.isKnownCategory)
    }

    var body: some View {
        Form {
            // The document first, the reading below it: a wrong reading shows against the receipt.
            if let preview {
                Section {
                    CapturedFilePreview(url: preview)
                } footer: {
                    Text("Tarkista, että luetut tiedot vastaavat kuittia.")
                }
            }
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
                // Which rate priced the euro total of a foreign document (web `fxNote`).
                if let rate = form.fxNote {
                    Text(rate).font(.caption).foregroundStyle(Theme.ink2)
                }
                // The web offers the currency on an expense only (sales documents are in euros).
                if form.type == "meno" {
                    Picker("Valuutta", selection: $form.currency) {
                        ForEach(ReceiptCurrency.choices(including: form.currency), id: \.self) { code in
                            Text(code).tag(code)
                        }
                    }
                    .pickerStyle(.menu)
                    if form.isForeign {
                        TextField(ReceiptCurrency.originalAmountLabel(form.currency), text: $form.originalAmountText)
                            .moneyInput()
                        fieldError("originalAmount")
                    }
                }
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
                // Both answers to the look-alike question; before W27 "no" had no button and the
                // file waited under "Kesken" for good.
                Section {
                    Button("Tallenna silti") { Task { await save(forceDuplicate: true) } }
                        .disabled(busy)
                    Button(ReceiptSaving.skipDuplicateTitle, role: .destructive) { Task { await skipDuplicate() } }
                        .disabled(busy)
                } footer: { Text("Sama kuitti on jo tallennettu. \"\(ReceiptSaving.skipDuplicateTitle)\" poistaa tämän tiedoston.") }
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
            baseline = form
            dirty = false
        }
        .onChange(of: form) { _, now in dirty = now != baseline }
    }

    private var dateBinding: Binding<Date> {
        Binding(get: { APIDate.pickerDate(form.date) ?? Date() }, set: { form.setDate(APIDate.pickerDay($0)) })
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
                // `model.save` asks the server to approve a complete receipt as it saves it (the
                // server checks, not the app), and leaves the flag out for a server without it.
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
                let outcome = try await model.save(request, saveDuplicateAnyway: false)
                receiptId = outcome.receiptId
                savedId = receiptId
                savedAutoApproved = outcome.approved
                savedInvoiceNote = outcome.invoiceNote
                duplicate = false
            } else {
                return
            }
            if let transactionId {
                let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Match(transactionId: transactionId, receiptId: receiptId))
            }
            Haptics.success()
            done(savedAutoApproved, savedInvoiceNote)
        } catch is CancellationError {
        } catch let error as LKError where error.isDuplicate && savedId == nil {
            duplicate = true
            failure = error.message
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    /// "Älä tallenna": the file is dropped on the server and its row says "Ohitettu (kaksoiskappale)".
    private func skipDuplicate() async {
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await model.skipDuplicate(rowId, uploadId: uploadId)
            dirty = false
            Haptics.success()
        } catch is CancellationError {
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
