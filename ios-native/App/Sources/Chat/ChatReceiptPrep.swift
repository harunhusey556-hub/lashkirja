import SwiftUI
import UIKit
import ImageIO
import PDFKit
import LashKirjaCore

/// Turns a picked photo or file into a receipt upload for the chat. Decoding and scaling a
/// 12–48 MP photo is heavy, so every path runs off the main actor.
enum ChatReceiptPrep {
    typealias Prepared = Result<ChatReceiptUpload, LKError>

    static func camera(_ image: UIImage) async -> Prepared {
        await Task.detached(priority: .userInitiated) { () -> Prepared in
            guard let jpeg = ReceiptImageEncoder.jpeg(from: image) else { return .failure(Self.unreadable) }
            return Self.photo(jpeg: jpeg, name: ChatReceiptFile.generatedName())
        }.value
    }

    /// Photo library data (HEIC, JPEG, PNG): scaled and sent as JPEG.
    static func library(_ data: Data) async -> Prepared {
        await Task.detached(priority: .userInitiated) { () -> Prepared in
            guard let jpeg = ReceiptImageEncoder.jpeg(fromData: data) else { return .failure(Self.unreadable) }
            return Self.photo(jpeg: jpeg, name: ChatReceiptFile.generatedName())
        }.value
    }

    /// A file from Files: a PDF as it is, an image scaled to JPEG like a photo.
    static func file(_ url: URL) async -> Prepared {
        await Task.detached(priority: .userInitiated) { () -> Prepared in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = ChatReceiptFile.safeName(url.lastPathComponent)
            guard ChatReceiptFile.mimeType(forFileName: name) != nil else {
                return .failure(LKError(status: 0, message: ChatReceiptFile.unsupportedMessage))
            }
            guard let data = try? Data(contentsOf: url) else { return .failure(Self.unreadable) }
            if ChatReceiptFile.isPDF(name) {
                if let problem = ChatReceiptFile.problem(name: name, bytes: data.count) { return .failure(LKError(status: 0, message: problem)) }
                return .success(ChatReceiptUpload(name: name, mimeType: "application/pdf", data: data, thumbnail: Self.pdfThumbnail(data), clientId: UUID().uuidString))
            }
            guard let jpeg = ReceiptImageEncoder.jpeg(fromData: data) else { return .failure(Self.unreadable) }
            return Self.photo(jpeg: jpeg, name: ChatReceiptFile.jpegName(name))
        }.value
    }

    private static let unreadable = LKError(status: 0, message: ChatReceiptFile.unreadableMessage)

    private static func photo(jpeg: Data, name: String) -> Prepared {
        let data = shrink(jpeg)
        if let problem = ChatReceiptFile.problem(name: name, bytes: data.count) { return .failure(LKError(status: 0, message: problem)) }
        return .success(ChatReceiptUpload(name: name, mimeType: "image/jpeg", data: data, thumbnail: thumbnail(data), clientId: UUID().uuidString))
    }

    /// A busy receipt photo can stay large at the capture quality: it is compressed harder
    /// until it fits the chat's target size.
    private static func shrink(_ jpeg: Data) -> Data {
        guard jpeg.count > ChatReceiptFile.targetImageBytes, let image = UIImage(data: jpeg) else { return jpeg }
        var smallest = jpeg
        for quality in ChatReceiptFile.fallbackQualities {
            guard let data = image.jpegData(compressionQuality: quality) else { continue }
            if data.count < smallest.count { smallest = data }
            if data.count <= ChatReceiptFile.targetImageBytes { break }
        }
        return smallest
    }

    private static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 360,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }

    private static func pdfThumbnail(_ data: Data) -> UIImage? {
        PDFDocument(data: data)?.page(at: 0)?.thumbnail(of: CGSize(width: 240, height: 320), for: .mediaBox)
    }
}
