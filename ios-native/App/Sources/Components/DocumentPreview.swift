import SwiftUI
import QuickLook
import CryptoKit
import LashKirjaCore

/// Downloaded documents (receipt images, invoice PDFs), so a second look is instant and a detail
/// screen can start the download before the owner taps "Näytä". A file is kept under a key that
/// changes when the document does (an invoice's `updatedAt`); without a key it is kept for this
/// run only. Files are encrypted at rest and removed on sign-out.
@MainActor
final class DocumentCache {
    static let shared = DocumentCache()
    private var inFlight: [String: Task<URL, Error>] = [:]
    private var memory: [String: URL] = [:]

    private var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("documents", isDirectory: true)
    }

    private func id(_ path: String, _ query: [String: String], _ key: String?) -> String {
        let raw = path + "?" + query.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&") + "#" + (key ?? "")
        return SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func file(_ app: AppModel, path: String, query: [String: String] = [:], fileName: String, key: String?) async throws -> URL {
        let id = id(path, query, key)
        // Only a keyed document (a stored receipt, an invoice version) is reused; an export or a
        // reminder PDF is built from today's data, so every open asks the server again.
        if key != nil, let url = memory[id], FileManager.default.fileExists(atPath: url.path) { return url }
        let dir = folder.appendingPathComponent(id, isDirectory: true)
        if key != nil, let kept = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).first {
            memory[id] = kept
            return kept
        }
        if let running = inFlight[id] { return try await running.value }
        let api = app.api
        let task = Task { () throws -> URL in
            let response = try await api.raw("GET", path, query: query, body: nil, contentType: nil)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // The server may send a JPEG preview of a HEIC or PNG original: the name follows what
            // arrived, or QuickLook would read it by the wrong extension.
            let target = dir.appendingPathComponent(Self.name(fileName, contentType: response.headers["content-type"]))
            try response.body.write(to: target, options: [.atomic, .completeFileProtection])
            return target
        }
        inFlight[id] = task
        defer { inFlight[id] = nil }
        let url = try await task.value
        if key != nil { memory[id] = url }
        return url
    }

    static func name(_ fileName: String, contentType: String?) -> String {
        let base = fileName.isEmpty ? "tiedosto" : fileName
        let type = (contentType ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        let ext: String? = switch type {
        case "image/jpeg": "jpg"
        case "image/png": "png"
        case "image/webp": "webp"
        case "image/heic", "image/heif": "heic"
        case "application/pdf": "pdf"
        default: nil
        }
        guard let ext else { return base }
        let current = (base as NSString).pathExtension.lowercased()
        if current == ext || (ext == "jpg" && current == "jpeg") { return base }
        return ((base as NSString).deletingPathExtension) + "." + ext
    }

    /// Starts the download in the background; a failure is shown only if the owner opens it.
    func prefetch(_ app: AppModel, path: String, query: [String: String] = [:], fileName: String, key: String?) {
        Task { _ = try? await file(app, path: path, query: query, fileName: fileName, key: key) }
    }

    func clear() {
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
        memory.removeAll()
        try? FileManager.default.removeItem(at: folder)
    }
}

/// Downloads an authorised file (invoice PDF, receipt image) and shows it in QuickLook,
/// which brings zoom, share and print for free.
struct DocumentPreviewSheet: View {
    @Environment(AppModel.self) private var app
    let path: String
    var query: [String: String] = [:]
    let fileName: String
    /// Changes when the document does; see DocumentCache.
    var cacheKey: String? = nil
    @State private var url: URL?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if let url {
                    QuickLookView(url: url).ignoresSafeArea(edges: .bottom)
                } else if let failure {
                    ContentUnavailableView("Tiedostoa ei voitu avata", systemImage: "doc.questionmark", description: Text(failure))
                } else {
                    ProgressView("Avataan…")
                }
            }
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let url { ToolbarItem(placement: .topBarTrailing) { ShareLink(item: url) } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            url = try await DocumentCache.shared.file(app, path: path, query: query, fileName: fileName, key: cacheKey)
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }
}

private struct QuickLookView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        // Reloaded only when the file changes, not on every SwiftUI update.
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        controller.reloadData()
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
