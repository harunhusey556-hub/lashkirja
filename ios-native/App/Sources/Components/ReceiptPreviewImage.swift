import SwiftUI
import LashKirjaCore

/// The receipt's picture at reading size, shown above the fields while a receipt is checked and
/// approved. The server's JPEG preview (PDF page 1, HEIC as JPEG) is fetched through
/// `DocumentCache` because the route needs the signed-in session, which `AsyncImage` cannot send.
struct ReceiptPreviewImage: View {
    @Environment(AppModel.self) private var app
    let receiptId: String
    /// Tapping the picture opens the full viewer; nil leaves the picture inert.
    var onOpen: (() -> Void)? = nil
    @State private var image: UIImage?
    @State private var failed = false
    /// Decoded pictures of this run: opening the same receipt again shows it at once.
    private static let memory = NSCache<NSString, UIImage>()
    /// The picture is at most 260 pt high and a screen wide: 1 400 px covers a 3x screen.
    private static let maxPixel: CGFloat = 1_400

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Kuitin kuva")
                    .onTapGesture { onOpen?() }
            } else if failed {
                Label("Kuvaa ei voitu ladata", systemImage: "doc.questionmark")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
            } else {
                ProgressView("Ladataan kuvaa…")
                    .font(.footnote)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 260)
        .padding(.vertical, 8)
        .task(id: receiptId) { await load() }
    }

    private func load() async {
        failed = false
        guard case .signedIn(let user) = app.phase else { return }
        let memoryKey = "\(user.userId)|\(receiptId)|view" as NSString
        if let hit = Self.memory.object(forKey: memoryKey) {
            image = hit
            return
        }
        do {
            let url = try await DocumentCache.shared.file(
                app, path: "/api/receipts/\(receiptId)/file/preview", fileName: "esikatselu.jpg", key: "view-v1"
            )
            // Decoded off the main actor at display size, not as the full 1 600 px JPEG.
            let side = Self.maxPixel
            let loaded = await Task.detached(priority: .userInitiated) { ReceiptThumbnail.downsample(url, maxPixel: side) }.value
            guard !Task.isCancelled else { return }
            if let loaded {
                Self.memory.setObject(loaded, forKey: memoryKey)
                image = loaded
            } else {
                failed = true
            }
        } catch is CancellationError {
        } catch {
            failed = true
        }
    }
}
