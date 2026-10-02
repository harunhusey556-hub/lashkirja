import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import LashKirjaCore

/// Kuvaa kuitti: camera (or photo library) → upload → the server reads it →
/// the owner checks the fields → save. With `transactionId` the saved
/// receipt is matched to that bank row.
struct CaptureFlow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let transactionId: String?
    /// Called once the receipt is saved (and matched), just before the flow closes.
    /// Not called when the flow is cancelled.
    var onSaved: (() -> Void)? = nil

    enum Step { case pick, uploading, edit(ReceiptDraft), failed(String) }
    @State private var step: Step = .pick
    @State private var showCamera = UIImagePickerController.isSourceTypeAvailable(.camera)
    @State private var photo: PhotosPickerItem?
    @State private var progress = "Ladataan…"
    @State private var confirmDiscard = false

    /// A receipt that is being read or was read but not saved is work the owner would lose.
    private var unsaved: Bool {
        switch step {
        case .uploading, .edit: true
        case .pick, .failed: false
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .pick:
                    VStack(spacing: 16) {
                        Image(systemName: "doc.viewfinder").font(.system(size: 54)).foregroundStyle(Theme.accent)
                        Text("Kuvaa kuitti tai valitse kuva").font(.headline)
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            Button { showCamera = true } label: { Label("Avaa kamera", systemImage: "camera").frame(maxWidth: .infinity, minHeight: 44) }
                                .buttonStyle(.primary)
                        }
                        PhotosPicker(selection: $photo, matching: .images) {
                            Label("Valitse kirjastosta", systemImage: "photo").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(24)
                case .uploading:
                    ProgressView(progress)
                case .edit(let draft):
                    ReceiptEditor(draft: draft, transactionId: transactionId) {
                        onSaved?()
                        dismiss()
                    }
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Kuitin luku epäonnistui", systemImage: "exclamationmark.triangle")
                    } description: { Text(message) } actions: {
                        Button("Yritä uudelleen") { step = .pick }
                    }
                }
            }
            .navigationTitle("Uusi kuitti")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if unsaved { confirmDiscard = true } else { dismiss() } }
                }
            }
            .discardGuard(dirty: unsaved, busy: false, asking: $confirmDiscard) { dismiss() }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    showCamera = false
                    if let image { Task { await upload { ReceiptImageEncoder.jpeg(from: image) } } }
                }
                .ignoresSafeArea()
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                // Cleared so that picking the same photo again after a failure still fires.
                photo = nil
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await upload { ReceiptImageEncoder.jpeg(fromData: data) }
                    }
                }
            }
        }
    }

    /// `encode` runs off the main actor: decoding and scaling a 12–48 MP photo is heavy.
    private func upload(_ encode: @escaping @Sendable () -> Data?) async {
        step = .uploading
        progress = "Ladataan…"
        guard let jpeg = await Task.detached(priority: .userInitiated, operation: encode).value else {
            step = .failed("Kuvaa ei voitu lukea.")
            return
        }
        var form = Multipart()
        form.addFile("file", filename: "kuitti.jpg", mimeType: "image/jpeg", data: jpeg)
        do {
            let response = try await app.api.raw("POST", "/api/receipts", body: form.finalize(), contentType: form.contentType)
            let result = try JSONDecoder().decode(UploadResult.self, from: response.body)
            var extracted = result.extracted
            if let jobId = result.jobId {
                progress = "Luetaan kuittia…"
                for _ in 0..<60 {
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                    let job: JobResponse = try await app.api.get("/api/jobs/\(jobId)")
                    if job.job.isFinished {
                        if job.job.status != "done" { throw LKError(status: 0, message: job.job.error ?? "Kuitin luku epäonnistui.") }
                        extracted = job.job.extracted
                        break
                    }
                }
            }
            step = .edit(ReceiptDraft(uploadId: result.uploadId, extracted: extracted))
        } catch is CancellationError {
        } catch {
            step = .failed(error.userMessage)
        }
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
                    .keyboardType(.decimalPad)
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
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                    Button(role: .destructive) { form.removeVatRow(at: index) } label: { Image(systemName: "minus.circle") }
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
