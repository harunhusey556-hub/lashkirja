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

    enum Step { case pick, uploading, edit(ReceiptDraft), failed(String) }
    @State private var step: Step = .pick
    @State private var showCamera = UIImagePickerController.isSourceTypeAvailable(.camera)
    @State private var photo: PhotosPickerItem?
    @State private var progress = "Ladataan…"

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
                    ReceiptEditor(draft: draft, transactionId: transactionId) { dismiss() }
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
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } } }
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

struct ReceiptEditor: View {
    @Environment(AppModel.self) private var app
    @State var draft: ReceiptDraft
    let transactionId: String?
    let done: () -> Void
    @State private var amountText = ""
    @State private var date = Date()
    @State private var busy = false
    @State private var failure: String?
    @State private var duplicate = false
    @State private var savedId: String?
    @State private var customCategory = false

    var body: some View {
        Form {
            Picker("Laji", selection: $draft.type) {
                Text("Meno").tag("meno")
                Text("Tulo").tag("tulo")
            }
            .pickerStyle(.segmented)
            Section {
                TextField("Myyjä", text: $draft.vendor)
                TextField("Summa €", text: $amountText).keyboardType(.decimalPad)
                    .onChange(of: amountText) { _, t in draft.totalAmount = ReceiptAmount.parse(t) }
                DatePicker("Päivä", selection: $date, displayedComponents: .date)
            }
            Section("Kategoria") {
                ReceiptCategoryField(category: $draft.category, custom: $customCategory)
            }
            if !draft.vatDetails.isEmpty {
                Section("ALV") {
                    ForEach(draft.vatDetails, id: \.self) { row in
                        LabeledContent("ALV \(NSDecimalNumber(decimal: row.rate).stringValue.replacingOccurrences(of: ".", with: ",")) %") { MoneyText(amount: row.amount) }
                    }
                }
            }
            Section { TextField("Muistiinpano", text: $draft.notes, axis: .vertical) }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            if duplicate {
                Section {
                    Button("Tallenna silti") { draft.forceDuplicate = true; Task { await save() } }
                } footer: { Text("Sama kuitti on jo tallennettu.") }
            }
            Section {
                Button { Task { await save() } } label: {
                    Text("Tallenna kuitti").frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                }
                .buttonStyle(.primary)
                .disabled(busy)
                .listRowBackground(Color.clear)
            }
        }
        .onAppear {
            if let amount = draft.totalAmount { amountText = NSDecimalNumber(decimal: amount).stringValue.replacingOccurrences(of: ".", with: ",") }
            if let d = APIDate.day(draft.date) { date = d }
            customCategory = !draft.category.isEmpty && !ReceiptCategory.isKnown(draft.category)
        }
    }

    private func save() async {
        draft.date = APIDate.dayString(date)
        if let problem = draft.validationError { failure = problem; Haptics.error(); return }
        struct Saved: Decodable { struct R: Decodable { let id: String }; let receipt: R }
        struct Match: Encodable { let transactionId: String; let receiptId: String }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            // A retry after a failed match only repeats the match, never the save.
            let receiptId: String
            if let savedId {
                receiptId = savedId
            } else {
                let saved: Saved = try await app.api.send("POST", "/api/receipts/save", body: draft)
                receiptId = saved.receipt.id
                savedId = receiptId
            }
            if let transactionId {
                let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Match(transactionId: transactionId, receiptId: receiptId))
            }
            Haptics.success()
            done()
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
