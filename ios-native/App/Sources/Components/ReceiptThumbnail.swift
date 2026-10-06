import SwiftUI
import ImageIO
import LashKirjaCore

/// A small rounded picture of a receipt's file in the Kuitit list: the server's JPEG preview
/// (PDF page 1, HEIC as JPEG), fetched through `DocumentCache` (encrypted, cleared at sign-out)
/// and shrunk to thumbnail size so scrolling never decodes a full photo. A symbol shows while
/// it loads and when there is no picture.
struct ReceiptThumbnail: View {
    @Environment(AppModel.self) private var app
    let receipt: Receipt
    @State private var image: UIImage?

    private static let side: CGFloat = 40
    /// Decoded thumbnails of this run, so a row scrolled back into view is instant.
    private static let memory = NSCache<NSString, UIImage>()

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Theme.surface
                Image(systemName: receipt.hasOriginalFile ? "doc.text" : "doc")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
            }
        }
        .frame(width: Self.side, height: Self.side)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.ink2.opacity(0.15), lineWidth: 0.5))
        .accessibilityHidden(true)
        .task(id: receipt.updatedAt) { await load() }
    }

    private func load() async {
        guard receipt.hasOriginalFile, case .signedIn(let user) = app.phase else { return }
        let memoryKey = "\(user.userId)|\(receipt.id)|\(receipt.updatedAt)" as NSString
        if let hit = Self.memory.object(forKey: memoryKey) {
            image = hit
            return
        }
        // A failed download keeps the symbol; the row still opens the receipt.
        guard let url = try? await DocumentCache.shared.file(
            app, path: "/api/receipts/\(receipt.id)/file/preview", fileName: "esikatselu.jpg", key: receipt.updatedAt
        ) else { return }
        let side = Self.side * 3
        let thumb = await Task.detached(priority: .utility) { Self.downsample(url, maxPixel: side) }.value
        guard let thumb, !Task.isCancelled else { return }
        Self.memory.setObject(thumb, forKey: memoryKey)
        image = thumb
    }

    private nonisolated static func downsample(_ url: URL, maxPixel: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}
