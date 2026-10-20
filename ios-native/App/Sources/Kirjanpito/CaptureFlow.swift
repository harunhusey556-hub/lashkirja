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
    @Environment(\.dynamicTypeSize) private var typeSize
    let transactionId: String?
    /// Called after each receipt is saved (and matched). Not called when the flow is cancelled.
    var onSaved: (() -> Void)? = nil

    /// Presented over a sheet ("+"): closing goes through the sheet, whose dismissal takes this cover
    /// down with it in one movement. Dismissing the cover and then the sheet showed two (owner, 2026-10-15).
    let onClose: (() -> Void)?

    /// Kuitit under the cover: takes the review queue "Näytä tarkistettavat" asked for, before the cover goes.
    let onReviewQueue: ((ReceiptList) -> Void)?

    /// The page's title: the entry that opened it ("+" → "Lisää tiedosto" names it so), else "Uusi kuitti" (X140).
    let title: String

    /// `opensCamera`: "+" → "Kuvaa kuitti" and a missing-receipt action go straight to the camera;
    /// "+" → "Lisää tiedosto" opens this page so the owner picks camera, photos or files. Kuitit's
    /// "Jatka" opens on the unfinished files instead.
    init(transactionId: String?, onSaved: (() -> Void)? = nil, opensCamera: Bool = true, title: String = "Uusi kuitti",
         onClose: (() -> Void)? = nil, onReviewQueue: ((ReceiptList) -> Void)? = nil) {
        self.transactionId = transactionId
        self.onSaved = onSaved
        self.title = title
        self.onClose = onClose
        self.onReviewQueue = onReviewQueue
        let model = transactionId == nil ? CaptureQueueModel.shared : CaptureQueueModel(transactionId: transactionId)
        _model = State(initialValue: model)
        let asksCamera = opensCamera && !model.resuming
        _showCamera = State(initialValue: asksCamera && CaptureFlow.cameraAvailable)
        _askedCamera = State(initialValue: asksCamera)
    }

    @State private var model: CaptureQueueModel
    /// The model is opened once per presentation, not again when the camera cover closes.
    @State private var opened = false
    @State private var showCamera: Bool
    /// UI tests only (`-LKUITest`): this opening asked for the camera. The simulator has none, so
    /// the page opens on its picker either way, and this says which entry it was (P1Tests.test16).
    @State private var askedCamera: Bool
    @State private var showFiles = false
    /// The photo library, opened from the queue's ⋯ menu.
    @State private var showPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    /// Set by `close`: the queue is let go only once the cover is gone, so it never turns into the
    /// empty picker page while it slides down.
    @State private var closing = false
    /// "Näytä tarkistettavat" is asking for the review queue before the cover goes.
    @State private var openingReceipts = false
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
            // A ZStack, not a Group: a Group gives its modifiers to each page, so the fade below sat
            // inside the page being swapped and never ran; queue → form changed in one frame
            // (row 7, motion gate 39067168826: shift_video "pop", area 0.139, dy 0).
            ZStack {
                switch model.step {
                case .pick:
                    if scannerInline {
                        scanner.transition(.opacity)
                    } else {
                        ScrollView { picker.padding(24) }.transition(.opacity)
                    }
                case .queue:
                    queueList.motionProbe("capture-queue").transition(.opacity)
                case .edit(let rowId, let draft):
                    ReceiptEditor(model: model, rowId: rowId, draft: draft, preview: model.previews[rowId], dirty: $formDirty) { outcome in
                        model.saved(rowId, autoApproved: outcome.approved, invoiceNote: outcome.invoiceNote,
                                    receiptId: outcome.receiptId, kind: outcome.kind)
                    }
                    .id(rowId)
                    .transition(.opacity)
                }
            }
            // The page changes (picker → queue → form → queue) fade into each other instead of
            // swapping in one frame. Linear: a spring changes most of the screen in its first frames.
            .motion(.linear(duration: 0.4), value: stepKey)
            .motion(.snappy, value: scannerInline)
            .background(Theme.canvas)
            .toolbar(scannerInline ? .hidden : .automatic, for: .navigationBar)
            // A bill saved as an ostolasku is said aloud; the queue row keeps saying it.
            .overlay(alignment: .bottom) {
                if let notice = model.notice {
                    ToastView(toast: Toast(text: notice, actionLabel: nil)) {}
                        .padding(.bottom, 8)
                }
            }
            .motion(.snappy, value: model.notice)
            .overlay(alignment: .topLeading) {
                if UITestHooks.active && askedCamera {
                    Text("kamera").font(.caption2).opacity(0.01).allowsHitTesting(false)
                        .accessibilityIdentifier("capture-camera-asked")
                }
            }
            .formKeyboard()
            .navigationTitle(title)
            .onAppear {
                EventLog.shared.log(.screen(transactionId.map { "capture.forBankRow(\($0))" } ?? "capture"))
                model.onSaved = onSaved
                guard !opened else { return }
                opened = true
                model.open(app: app)
            }
            .navigationBarTitleDisplayMode(.inline)
            .onDisappear {
                if closing { model.screenClosed() }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { leadingButton }
                if showsMoreMenu {
                    // The motion gate holds this mark against the queue's SCREEN line: the menu
                    // must arrive with the page's fade, not a beat after it (M002).
                    ToolbarItem(placement: .topBarTrailing) { moreMenu.onAppear { MotionProbe.shared.mark("capture-toolbar") } }
                }
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
            .fullScreenCover(isPresented: cameraCover) {
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
            .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: single ? 1 : ReceiptUploadQueue.maxPick, matching: .images)
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

    /// Which page is up, for the fade between pages.
    private var stepKey: String {
        switch model.step {
        case .pick: return "pick"
        case .queue: return "queue"
        case .edit(let rowId, _): return "edit-\(rowId)"
        }
    }

    /// With nothing picked yet the scanner is this cover's own page, not a second cover over the
    /// empty picker page: "Kuvaa kuitti" slid up the picker and then the camera over it, two
    /// movements with a page in between. Over the queue the camera stays a cover of its own.
    private var scannerInline: Bool {
        guard showCamera, VNDocumentCameraViewController.isSupported, case .pick = model.step else { return false }
        return true
    }

    private var cameraCover: Binding<Bool> {
        Binding(get: { showCamera && !scannerInline }, set: { showCamera = $0 })
    }

    private var scanner: some View {
        DocumentScanner { images in
            showCamera = false
            addScanned(images)
        }
        .ignoresSafeArea()
    }

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
            if let importFailure { Text(importFailure).font(.footnote).foregroundStyle(Theme.danger).transition(.opacity) }
            // Under the buttons, so they never move when it comes or goes.
            if showsQueued {
                QueuedReceiptsStatus().padding(.top, 8).transition(.opacity)
            }
        }
        .motion(.snappy, value: importFailure)
        .motion(.snappy, value: showsQueued)
    }

    /// The offline queue (Kuitit's card, under this cover) has photos or a stop to show. A bank-row
    /// match never puts its file there, so it shows only the bulk queue's own rows.
    private var showsQueued: Bool { !single && QueuedReceiptsStatus.shows }

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
            fixtureButton
            queueFixtureButton
        }
    }

    private var fixtureButton: some View {
        Button {
            add([(ReceiptUploadQueue.Pick(name: UITestHooks.fixtureName, size: nil), .camera(UITestHooks.fixtureReceipt()))])
        } label: { Label("Testikuitti", systemImage: "testtube.2").frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("capture-fixture")
    }

    /// UI tests only: the fixture kept on the phone the way a file read without a connection is
    /// (`CaptureQueueModel.keepOffline`), since the simulator's network cannot be cut from a test.
    private var queueFixtureButton: some View {
        Button {
            guard let data = ReceiptImageEncoder.jpeg(from: UITestHooks.fixtureReceipt()) else { return }
            OfflineReceiptQueueModel.shared.enqueue(app: app, data: data, fileName: UITestHooks.fixtureName, mimeType: "image/jpeg")
        } label: { Label("Testikuitti jonoon", systemImage: "tray.and.arrow.down").frame(maxWidth: .infinity, minHeight: 44) }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("capture-queue-fixture")
    }

    /// Nothing is ever inserted above the rows or taken from between them while files finish (owner,
    /// 2026-10-15: the list jumped when the review ended). Before, "Lähetys jatkuu…" sat above the rows
    /// and went away the moment the last file finished, pulling every row up by its height, and
    /// "Peruuta lähetys" left the section at the same time. The notices now live in the footer under
    /// the rows, the occasional actions in the "…" menu, and the one action section below is there
    /// from the start: when the queue settles only its title changes. Adding more files is in the
    /// "…" menu too: one button under the rows, nothing else in the foreground (owner, 2026-10-18).
    private var queueList: some View {
        List {
            Section {
                ForEach(queue.rows.prefix(limit.visible(queue.rows.count))) { row in queueRow(row) }
                ShowMoreButton(limit: $limit, total: queue.rows.count)
            } header: {
                Text("Lähetysjono")
            } footer: {
                queueFooter
            }
            Section {
                // One primary action: the review queue once something waits there, else "Valmis".
                // A bank-row match closes by itself when saved, so it has none while it works.
                if !single || queue.isFinished {
                    Button { if queue.reviewButtonTitle != nil { openReceipts() } else { close() } } label: {
                        Text(primaryTitle)
                            .contentTransition(.opacity)
                            .frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                    }
                    .buttonStyle(.primary)
                    .motion(.snappy, value: primaryTitle)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                // UI tests only (Debug + `-LKUITest`): the simulator has no camera to take a picture with.
                if UITestHooks.active {
                    fixtureButton.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    queueFixtureButton.listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if let importFailure {
                    Text(importFailure).font(.footnote).foregroundStyle(Theme.danger).listRowSeparator(.hidden)
                        .transition(.opacity)
                }
            }
            // Last, under the actions: nothing above it moves when it comes or goes. A row kept for
            // later says "Odottaa yhteyttä" above for good; this says when it is sent or refused.
            if showsQueued {
                Section { QueuedReceiptsStatus() }.transition(.opacity)
            }
        }
        .scrollContentBackground(.hidden)
        // The bank-row match's primary button and an import failure come and go as the queue
        // works: faded, with the rows around them easing into place.
        .motion(.snappy, value: queue.isFinished)
        .motion(.snappy, value: importFailure)
        .motion(.snappy, value: showsQueued)
    }

    private var primaryTitle: String { queue.reviewButtonTitle ?? "Valmis" }

    /// Under the rows: the offline notice, then "Lähetys jatkuu…" while files go and the web's upload
    /// summary once they are through. Both lines are always laid out and only one is shown, so the
    /// swap is a fade and the footer keeps its height. A lone row says its own outcome: the summary
    /// under it said it a second time, as a count with no noun (X052).
    private var queueFooter: some View {
        let working = !single && queue.isWorking
        let summary = queue.rows.count > 1 ? queue.summaryLine : nil
        return VStack(alignment: .leading, spacing: 6) {
            if queue.offlineCount > 0 {
                Text(OfflineReceiptRules.offlineNotice).foregroundStyle(Theme.ink).transition(.opacity)
            }
            ZStack(alignment: .topLeading) {
                Text(single ? " " : "Lähetys jatkuu, vaikka suljet tämän näkymän. Kesken olevat kuitit löytyvät Kuiteista.")
                    .opacity(working ? 1 : 0)
                    .accessibilityHidden(!working)
                Text(summary ?? " ")
                    .opacity(working ? 0 : 1)
                    .accessibilityHidden(working || summary == nil)
            }
            .motion(.easeInOut(duration: 0.2), value: working)
        }
        .motion(.snappy, value: queue.offlineCount > 0)
    }

    /// Matching a bank row takes another pick only once the first one is out of the way.
    private var canAdd: Bool { !single || !queue.holdsWork }

    /// The occasional actions of the queue, out of the list so that none of them comes or goes
    /// between the rows and the primary action.
    private var hasMoreActions: Bool {
        (!single && queue.savedCount > 0) || queue.isWorking || queue.hasFailed || (!single && droppable > 0)
    }

    private var showsMoreMenu: Bool {
        guard case .queue = model.step else { return false }
        return canAdd || hasMoreActions
    }

    /// Adding more files first, then the occasional actions. The camera, photos and files were a
    /// "⊕ Lisää tiedostoja" row under "Valmis": a second foreground action (owner, 2026-10-18).
    private var moreMenu: some View {
        Menu {
            if canAdd {
                Section {
                    if Self.cameraAvailable {
                        Button { showCamera = true } label: { Label("Kuvaa lisää", systemImage: "camera") }
                    }
                    Button { showPhotos = true } label: { Label("Valitse kuvista", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Valitse tiedosto", systemImage: "doc") }
                }
            }
            Section {
                if !single && queue.savedCount > 0 {
                    Button { openReceipts() } label: { Label(ReceiptUploadQueue.receiptsButtonTitle, systemImage: "doc.text.magnifyingglass") }
                }
                if queue.hasFailed {
                    Button { model.retryFailed() } label: { Label("Yritä epäonnistuneet", systemImage: "arrow.clockwise") }
                }
                if queue.isWorking {
                    Button { cancelUploads() } label: { Label("Peruuta lähetys", systemImage: "stop.circle") }
                }
                if !single && droppable > 0 {
                    Button(role: .destructive) { confirmDropUnsaved = true } label: { Label("Hylkää tallentamattomat", systemImage: "trash") }
                }
            }
        } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("Toiminnot")
    }

    /// A saved document's kind is changed from the row's own menu, opened by a tap on the row: an
    /// accent "⇄ Ostolasku" on every row put a choice few rows need in the foreground (owner,
    /// 2026-10-18). The row names the kind in its grey line under the name.
    @ViewBuilder private func queueRow(_ row: UploadQueueRow) -> some View {
        if row.canSwitchKind, let kind = row.kind {
            Menu {
                Button(kind.switchTitle) {
                    Haptics.selection()
                    Task { await model.switchKind(row.id) }
                }
                .disabled(model.switchingKind.contains(row.id))
            } label: {
                rowLines(row).contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel([row.name, row.slotText, row.detailText].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint(kind.switchTitle)
            .accessibilityIdentifier("capture-queue-row")
        } else {
            rowLines(row)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("capture-queue-row")
        }
    }

    private func rowLines(_ row: UploadQueueRow) -> some View {
        let switching = model.switchingKind.contains(row.id)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.name).lineLimitUnlessLarge().truncationMode(.middle)
                Spacer(minLength: 8)
                // A fixed slot the spinner fades into: the name keeps its width when a file starts or
                // finishes. Not a hidden spinner: one spinning unseen keeps the app from going idle.
                ZStack {
                    if row.status == .uploading || row.status == .processing || row.status == .saving || switching {
                        ProgressView().controlSize(.small).transition(.opacity)
                    }
                }
                .frame(width: 20, height: 20)
                .motion(.easeOut(duration: 0.15), value: switching)
                statusLabel(row)
            }
            // One line under the name from the start, its words swapped by a fade: "Jonossa" gaining
            // "Lähetetään" under it moved every row below, and the buttons under the queue, by a line.
            // And one line only: a saved bill's outcome wrapped to two and moved "Valmis" down by
            // 16 pt (X051). A failure's reason is never cut, nor any line at the largest text sizes.
            // The row's action stands at the end of that line, never on a line of its own: under the
            // rest, "Käytä lomakkeessa" made a read row 18 pt taller and moved the rows and "Valmis"
            // below it (motion gate 39374914516). A read row has no words of its own there.
            let detail = row.detailText
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(detail ?? " ")
                    .font(.caption)
                    .foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
                    .lineLimit(row.status == .failed || typeSize.isAccessibilitySize ? nil : 1)
                    .contentTransition(.opacity)
                    .accessibilityHidden(detail == nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // A save the server refused: the form takes the reading from there (web "Käytä lomakkeessa").
                if row.canOpenForm {
                    Button("Avaa lomake") { openForm(row) }
                        .font(.caption.bold())
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                        .layoutPriority(1)
                }
                if row.status == .ready && row.draft != nil {
                    Button("Käytä lomakkeessa") { openForm(row) }
                        .font(.caption.bold())
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                        .layoutPriority(1)
                }
            }
            if let error = row.error, error != detail {
                Text(error).font(.caption).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2).transition(.opacity)
            }
        }
        // A row's own lines change as its file goes through: the row eases to its new height.
        .motion(.snappy, value: row)
    }

    /// The steps a file goes through on its way share one slot, each word faded in over the others:
    /// as one Text swapping its words, "Lähetetään" → "Käsitellään" moved the word's left edge 3–9 pt
    /// after the screen had settled (motion audit bad-capture-upload, shift_probe, run 39067168826).
    /// The outcome's word ("Odottaa tarkistusta") fades in over them in the same slot, on one line,
    /// and the name gives way to it. As a view of its own beside the slot, it crossed the last
    /// step's word one above the other while the row grew (motion gate 39374914516).
    private func statusLabel(_ row: UploadQueueRow) -> some View {
        ZStack(alignment: .trailing) {
            if Self.onTheWay.contains(row.status) {
                ForEach(Self.onTheWay, id: \.rawValue) { status in
                    Text(status.label)
                        .opacity(status == row.status ? 1 : 0)
                        .accessibilityHidden(status != row.status)
                }
            } else {
                Text(row.slotText).foregroundStyle(row.status == .failed ? Theme.danger : Theme.ink2)
            }
        }
        .font(.caption)
        .foregroundStyle(Theme.ink2)
        .lineLimitUnlessLarge()
        .layoutPriority(typeSize.isAccessibilitySize ? 0 : 1)
    }

    /// Short words only: the slot is as wide as the longest of them.
    private static let onTheWay: [UploadQueueStatus] = [.pending, .uploading, .processing, .saving]

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
    /// One movement (owner, 2026-10-15: several screens went by): the tab and Kuitit are put in place
    /// behind this cover without animation, then the cover (with the "+" sheet under it) goes down once.
    /// The review queue is asked for first (at most 1.5 s): Kuitit puts it on top while still
    /// hidden (`onReviewQueue`, or a Kuitit pushed now paints it from `lastPainted`), and the cover
    /// goes down onto the list as it ends up. Asked after, it was inserted above the rows 0.4 s
    /// after the cover had gone (motion audit bad-show-review, run 39067168826).
    private func openReceipts() {
        guard !openingReceipts else { return }
        openingReceipts = true
        Task {
            let query = ReceiptListQuery.pendingQueue()
            let asked = Task { () -> ReceiptList? in try? await app.cachedGet("/api/receipts", query: query, force: true, persist: true) }
            let cap = Task {
                try? await Task.sleep(for: .seconds(1.5))
                asked.cancel()
            }
            if let queue = await asked.value {
                app.rememberPainted(queue, "/api/receipts", query: query)
                onReviewQueue?(queue)
            }
            cap.cancel()
            app.pendingRoute = PendingRoute(tab: .kirjanpito, route: .receipts, animated: false)
            close()
        }
    }

    // MARK: Closing

    private func close() {
        importTask?.cancel()
        // Opened from Kuitit's "Jatka" (MainTabView's cover has no reload of its own): the lists
        // show what was saved meanwhile.
        if queue.savedCount > 0 { app.dataVersion += 1 }
        // `model.screenClosed()` runs in onDisappear: done here it emptied the queue and the cover
        // showed the picker page on its way down.
        closing = true
        if let onClose { onClose() } else { dismiss() }
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
    /// Called with the save's outcome: the server's approval (nil from a server that did not say), what
    /// it did with a bill ("ostolasku luotu, eräpäivä 14.10.2026"), and the receipt and kind the
    /// queue row's "Kuitti ⇄ Ostolasku" needs.
    let done: (ReceiptSaving.Outcome) -> Void
    @State private var form: ReceiptForm
    /// The form as it opened (with the default date filled in): what "dirty" compares with.
    @State private var baseline: ReceiptForm
    @State private var errors: [String: String] = [:]
    @State private var busy = false
    @State private var failure: String?
    @State private var duplicate = false
    /// The save that went through: a retry after a failed match only repeats the match, and still
    /// reports the approval.
    @State private var savedOutcome: ReceiptSaving.Outcome?
    @State private var customCategory: Bool
    /// The field being typed into. Meanwhile the keyboard's own "Valmis" bar is the only bar over
    /// it: the pinned save stood there too and covered the row being typed (as on Uusi lasku).
    @FocusState private var focus: CaptureFormField?

    private enum CaptureFormField: Hashable { case vendor, total, originalAmount, vat(Int), reference, invoiceNumber, notes }

    init(model: CaptureQueueModel, rowId: String, draft: ReceiptDraft, preview: URL?, dirty: Binding<Bool>, done: @escaping (ReceiptSaving.Outcome) -> Void) {
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
        // The save is pinned under the form, so what a failed save points at can sit below it, out
        // of sight (the category on the first screen, UI suite 39285931841): the form scrolls to the
        // first field it found wrong, to the failure, or to the duplicate question.
        ScrollViewReader { proxy in
            formBody
                .onChange(of: errors) { _, found in
                    if let key = form.firstErrorKey(in: found) { bringIntoView("error-\(key)", proxy) }
                }
                .onChange(of: failure) { _, now in
                    if now != nil { bringIntoView("save-failure", proxy) }
                }
                .onChange(of: duplicate) { _, now in
                    if now { bringIntoView("save-duplicate", proxy) }
                }
        }
    }

    /// The row is inserted by the same update that asks for it, so it is scrolled to on the main
    /// actor's next turn, once the form has it.
    private func bringIntoView(_ id: String, _ proxy: ScrollViewProxy) {
        Task { @MainActor in withMotion(.snappy) { proxy.scrollTo(id, anchor: .center) } }
    }

    private var formBody: some View {
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
                // Labels beside the fields, not placeholders: once filled, the rows read only
                // "Testikauppa Oy" and "12,40", with nothing to say which was the amount (U095).
                LabeledContent("Myyjä") {
                    TextField("", text: $form.vendor)
                        .textContentType(.organizationName)
                        .multilineTextAlignment(.trailing)
                        .focused($focus, equals: .vendor)
                }
                fieldError("vendor")
                DatePicker("Päivä", selection: dateBinding, displayedComponents: .date)
                fieldError("date")
                // The euro sign stays beside the figure, as in Muokkaa kuittia. The name is on the
                // field itself, so the field stays one element that can be typed into.
                LabeledContent("Summa") {
                    HStack(spacing: 4) {
                        TextField("0,00", text: Binding(get: { form.totalText }, set: { form.setTotal($0) }))
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                            .accessibilityLabel("Summa euroina")
                            .focused($focus, equals: .total)
                        Text("€").foregroundStyle(Theme.ink2).accessibilityHidden(true)
                    }
                }
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
                            .focused($focus, equals: .originalAmount)
                        fieldError("originalAmount")
                    }
                }
            }
            // No "Kategoria" header: the picker names itself, and the word stood twice (M009).
            Section {
                ReceiptCategoryField(category: $form.category, custom: $customCategory)
                fieldError("category")
            }
            vatSection
            Section {
                LabeledContent("Viitenumero") {
                    TextField("", text: $form.reference).multilineTextAlignment(.trailing).focused($focus, equals: .reference)
                }
                fieldError("reference")
                LabeledContent("Laskun numero") {
                    TextField("", text: $form.invoiceNumber).multilineTextAlignment(.trailing).focused($focus, equals: .invoiceNumber)
                }
                fieldError("invoiceNumber")
                LabeledContent("Muistiinpano") {
                    TextField("", text: $form.notes, axis: .vertical).multilineTextAlignment(.trailing).focused($focus, equals: .notes)
                }
                fieldError("notes")
            } header: {
                Text("Lisätiedot")
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger).id("save-failure") }.transition(.opacity) }
            if duplicate {
                // Both answers to the look-alike question; before W27 "no" had no button and the
                // file waited under "Kesken" for good.
                Section {
                    Button("Tallenna silti") { Task { await save(forceDuplicate: true) } }
                        .disabled(busy)
                        .id("save-duplicate")
                    Button(ReceiptSaving.skipDuplicateTitle, role: .destructive) { Task { await skipDuplicate() } }
                        .disabled(busy)
                } footer: { Text("Sama kuitti on jo tallennettu. \"\(ReceiptSaving.skipDuplicateTitle)\" poistaa tämän tiedoston.") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .safeAreaInset(edge: .bottom, spacing: 0) { if focus == nil { saveBar } }
        // Field errors, the duplicate question, a currency or VAT row coming or going: the rows
        // below ease to their new place.
        .motion(.snappy, value: errors)
        .motion(.snappy, value: failure)
        .motion(.snappy, value: duplicate)
        .motion(.snappy, value: form.type)
        .motion(.snappy, value: form.isForeign)
        .motion(.snappy, value: form.vatRows.map(\.id))
        .motion(.snappy, value: customCategory)
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

    /// "Tallenna kuitti" under the form from its first frame, on the canvas: as the form's last row
    /// it sat under the picture, the fields and the VAT rows, out of sight (M009). While the save
    /// runs it keeps its size; the words give way to a spinner that exists only then (a spinner
    /// hidden but spinning keeps the app from going idle).
    private var saveBar: some View {
        Button { Task { await save(forceDuplicate: false) } } label: {
            Text("Tallenna kuitti")
                .font(.headline)
                .opacity(busy ? 0 : 1)
                .overlay { if busy { ProgressView().tint(Theme.onInk).transition(.opacity) } }
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.primary)
        .disabled(busy)
        .accessibilityLabel("Tallenna kuitti")
        .motion(.easeOut(duration: 0.15), value: busy)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.canvas.ignoresSafeArea(edges: .bottom))
    }

    @ViewBuilder private func fieldError(_ key: String) -> some View {
        if let message = errors[key] {
            Text(message).font(.caption).foregroundStyle(Theme.danger).id("error-\(key)")
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
                        .focused($focus, equals: .vat(index))
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
        if savedOutcome == nil {
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
            let outcome: ReceiptSaving.Outcome
            if let savedOutcome {
                outcome = savedOutcome
            } else if let request {
                outcome = try await model.save(request, saveDuplicateAnyway: false)
                savedOutcome = outcome
                duplicate = false
            } else {
                return
            }
            if let transactionId {
                let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Match(transactionId: transactionId, receiptId: outcome.receiptId))
            }
            Haptics.success()
            done(outcome)
        } catch is CancellationError {
        } catch let error as LKError where error.isDuplicate && savedOutcome == nil {
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
