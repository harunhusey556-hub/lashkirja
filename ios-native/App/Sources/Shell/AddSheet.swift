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
    /// The invoice just made with "Uusi lasku": opened in Myynti once the sheets are gone.
    @State private var createdInvoiceId: String?
    /// Whether a mailbox is connected; nil while unknown (then "Hae sähköpostista" is offered and a 404 tells).
    @State private var hasMailbox: Bool?
    /// The server answered that no mailbox is connected: the notice links to connecting one.
    @State private var mailboxMissing = false
    @State private var showEmailImport = false
    @State private var detent: PresentationDetent = .medium

    var body: some View {
        NavigationStack {
            List {
                Button { capture = true } label: { Label("Lisää kuitti", systemImage: "doc.badge.plus") }
                Button { importing = true } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
                    .disabled(busy)
                Button { newInvoice = true } label: { Label("Uusi lasku", systemImage: "doc.badge.plus") }
                if hasMailbox == false {
                    Button { openEmailImport() } label: { Label("Yhdistä sähköposti", systemImage: "envelope.badge") }
                        .disabled(busy)
                } else {
                    Button { Task { await fetchEmail() } } label: {
                        HStack { Label("Hae sähköpostista", systemImage: "envelope"); if busy { Spacer(); ProgressView() } }
                    }
                    .disabled(busy)
                }
                if mailboxMissing {
                    Button { openEmailImport() } label: {
                        Text("Sähköpostia ei ole yhdistetty. Yhdistä se tästä ›").font(.footnote).foregroundStyle(Theme.accentDark)
                    }
                } else if let notice {
                    Text(notice).font(.footnote).foregroundStyle(Theme.ink2)
                }
            }
            .navigationTitle("Lisää")
            .navigationBarTitleDisplayMode(.inline)
            // Connecting a mailbox opens here, so Back returns to these actions.
            .navigationDestination(isPresented: $showEmailImport) {
                EmailImportView { profile in
                    app.profileChanged(profile)
                    hasMailbox = !(profile.imapAccounts ?? []).isEmpty
                    if hasMailbox == true { mailboxMissing = false }
                }
            }
            .task {
                guard hasMailbox == nil, let profile = await app.cachedProfile(), let accounts = profile.imapAccounts else { return }
                hasMailbox = !accounts.isEmpty
            }
            // Screens reload when something was actually saved: every accepted write bumps
            // AppModel.dataVersion, so a cancelled flow reloads nothing.
            .fullScreenCover(isPresented: $capture, onDismiss: { dismiss() }) { CaptureFlow(transactionId: nil, opensCamera: false) }
            .sheet(isPresented: $newInvoice, onDismiss: openCreatedInvoice) {
                InvoiceFormView(existing: nil, onCreated: { id in createdInvoiceId = id })
            }
            // A swipe down during an upload would lose its result.
            .interactiveDismissDisabled(busy)
            .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
                if case .success(let url) = result { Task { await upload(url) } }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
    }

    /// The mailbox screen needs room: the sheet grows to full height for it.
    private func openEmailImport() {
        detent = .large
        showEmailImport = true
    }

    /// As on the web, a new invoice opens once made: the Myynti tab, then the invoice.
    private func openCreatedInvoice() {
        if let id = createdInvoiceId {
            createdInvoiceId = nil
            app.pendingRoute = PendingRoute(tab: .myynti, route: .invoice(id))
        }
        dismiss()
    }

    private func upload(_ url: URL) async {
        guard !busy else { return }
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else { notice = "Tiedostoa ei voitu lukea."; return }
        var form = Multipart()
        form.addFile("file", filename: url.lastPathComponent.replacingOccurrences(of: "\"", with: ""), mimeType: "application/octet-stream", data: data)
        busy = true
        mailboxMissing = false
        defer { busy = false }
        do {
            struct Result: Decodable { let count: Int? }
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            notice = "Tuotiin \((try? JSONDecoder().decode(Result.self, from: response.body))?.count ?? 0) tapahtumaa."
            Haptics.success()
        } catch {
            notice = error.userMessage
        }
    }

    private func fetchEmail() async {
        struct Result: Decodable { let count: Int? }
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let r: Result = try await app.api.send("POST", "/api/integrations/imap/sync", body: EmptyBody())
            notice = "Haettiin \(r.count ?? 0) kuittia sähköpostista."
            Haptics.success()
        } catch let error as LKError where error.status == 404 {
            hasMailbox = false
            mailboxMissing = true
        } catch {
            notice = error.userMessage
        }
    }
}
