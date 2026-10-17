import SwiftUI
import UIKit
import PDFKit
import QuickLook
import LashKirjaCore

/// The file just picked, at reading size, above the fields of the form that checks its reading, so
/// a wrong reading can be compared with the document (owner, 2026-10-12: the form showed no
/// picture). The bytes are the ones that were sent and are already on the phone, so nothing is
/// downloaded; a PDF shows its first page. A tap opens the file full screen in QuickLook.
struct CapturedFilePreview: View {
    let url: URL
    @State private var image: UIImage?
    @State private var failed = false
    @State private var fullScreen: URL?

    var body: some View {
        VStack(spacing: 6) {
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityLabel("Kuitin kuva")
                        .accessibilityHint("Avaa koko näytölle")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("captured-file-preview")
                        .onTapGesture { fullScreen = url }
                } else if failed {
                    Label("Kuvaa ei voitu näyttää", systemImage: "doc.questionmark")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                } else {
                    ProgressView("Ladataan kuvaa…")
                        .font(.footnote)
                }
            }
            // The picture's height and its button's row are there before the picture is: the
            // form opens while the file is still being decoded, and a box that grew from the
            // spinner's 120 pt to the picture pushed every field down 160 pt (row 7, motion gate
            // 2026-10-17: "the upload screen jumps down after processing").
            .frame(maxWidth: .infinity)
            .frame(height: 260)
            Button { fullScreen = url } label: {
                Label("Avaa koko näytölle", systemImage: "arrow.up.left.and.arrow.down.right")
            }
            .font(.caption.bold())
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.accent)
            .opacity(image == nil ? 0 : 1)
            .disabled(image == nil)
            .accessibilityHidden(image == nil)
        }
        .padding(.vertical, 8)
        .quickLookPreview($fullScreen)
        .task(id: url) { await load() }
    }

    private func load() async {
        failed = false
        let url = self.url
        // A large PDF page or photo is decoded off the main actor.
        let loaded = await Task.detached(priority: .userInitiated) { CapturedFilePreview.render(url) }.value
        if let loaded {
            image = loaded
        } else {
            failed = true
        }
    }

    private nonisolated static func render(_ url: URL) -> UIImage? {
        if url.pathExtension.lowercased() == "pdf" {
            guard let page = PDFDocument(url: url)?.page(at: 0) else { return nil }
            return page.thumbnail(of: CGSize(width: 1000, height: 1400), for: .mediaBox)
        }
        return UIImage(contentsOfFile: url.path)
    }
}
