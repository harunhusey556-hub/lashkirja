import SwiftUI
import QuickLook
import LashKirjaCore

/// Downloads an authorised file (invoice PDF, receipt image) and shows it in QuickLook,
/// which brings zoom, share and print for free.
struct DocumentPreviewSheet: View {
    @Environment(AppModel.self) private var app
    let path: String
    let fileName: String
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
            let response = try await app.api.raw("GET", path, body: nil, contentType: nil)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
            try response.body.write(to: file, options: .atomic)
            url = file
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
