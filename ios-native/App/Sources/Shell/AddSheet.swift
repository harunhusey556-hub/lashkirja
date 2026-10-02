import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

/// The "+" actions: each opens its real flow.
struct AddSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var capture = false
    @State private var newInvoice = false
    @State private var importing = false
    @State private var notice: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                Button { capture = true } label: { Label("Kuvaa kuitti", systemImage: "camera") }
                Button { importing = true } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
                Button { newInvoice = true } label: { Label("Uusi lasku", systemImage: "doc.badge.plus") }
                Button { Task { await fetchEmail() } } label: {
                    HStack { Label("Hae sähköpostista", systemImage: "envelope"); if busy { Spacer(); ProgressView() } }
                }
                if let notice { Text(notice).font(.footnote).foregroundStyle(Theme.ink2) }
            }
            .navigationTitle("Lisää")
            .navigationBarTitleDisplayMode(.inline)
            // Screens reload only when something was actually added (AppModel.dataVersion).
            .fullScreenCover(isPresented: $capture, onDismiss: { app.dataVersion += 1; dismiss() }) { CaptureFlow(transactionId: nil) }
            .sheet(isPresented: $newInvoice, onDismiss: { app.dataVersion += 1; dismiss() }) { InvoiceFormView(existing: nil) }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
                if case .success(let url) = result { Task { await upload(url) } }
            }
        }
    }

    private func upload(_ url: URL) async {
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else { notice = "Tiedostoa ei voitu lukea."; return }
        var form = Multipart()
        form.addFile("file", filename: url.lastPathComponent.replacingOccurrences(of: "\"", with: ""), mimeType: "application/octet-stream", data: data)
        busy = true
        defer { busy = false }
        do {
            struct Result: Decodable { let count: Int? }
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            notice = "Tuotiin \((try? JSONDecoder().decode(Result.self, from: response.body))?.count ?? 0) tapahtumaa."
            app.dataVersion += 1
            Haptics.success()
        } catch {
            notice = error.userMessage
        }
    }

    private func fetchEmail() async {
        struct Result: Decodable { let count: Int? }
        busy = true
        defer { busy = false }
        do {
            let r: Result = try await app.api.send("POST", "/api/integrations/imap/sync", body: EmptyBody())
            notice = "Haettiin \(r.count ?? 0) kuittia sähköpostista."
            if (r.count ?? 0) > 0 { app.dataVersion += 1 }
            Haptics.success()
        } catch let error as LKError where error.status == 404 {
            notice = "Sähköpostia ei ole yhdistetty. Yhdistä se kohdassa Asetukset › Sähköpostien tuonti."
        } catch {
            notice = error.userMessage
        }
    }
}
