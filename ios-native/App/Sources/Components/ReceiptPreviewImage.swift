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
        do {
            let url = try await DocumentCache.shared.file(
                app, path: "/api/receipts/\(receiptId)/file/preview", fileName: "esikatselu.jpg", key: "view-v1"
            )
            if let loaded = UIImage(contentsOfFile: url.path) {
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
