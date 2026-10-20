import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

/// The "+" actions: each opens its real flow. The camera, a file and a sales invoice are the rows;
/// the imports, used now and then, wait in ⋯ (owner, Q4: the camera two taps from any tab).
struct AddSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var capture: CaptureEntry?
    @State private var newInvoice = false
    @State private var importing = false
    @State private var notice: String?
    /// The notice tells of a statement's rows: it links to them in Kirjanpito > Pankki.
    @State private var noticeOpensRows = false
    @State private var busy = false
    /// The invoice just made with "Uusi lasku": opened in Myynti once the sheets are gone.
    @State private var createdInvoiceId: String?
    /// Whether a mailbox is connected; nil while unknown (then "Hae sähköpostista" is offered and a 404 tells).
    @State private var hasMailbox: Bool?
    /// The server answered that no mailbox is connected: the notice links to connecting one.
    @State private var mailboxMissing = false
    @State private var showEmailImport = false

    /// The capture page's two ways in from here.
    private enum CaptureEntry: Identifiable {
        /// "Kuvaa kuitti": straight to the camera.
        case camera
        /// "Lisää tiedosto": the page where camera, photos or files are picked, titled by its row (X140).
        case file
        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            List {
                Button { capture = .camera } label: { Label("Kuvaa kuitti", systemImage: "camera") }
                // One button for receipts and bills alike (owner, 2026-10-15): the reading decides
                // kuitti or ostolasku, and the upload screen's row turns a wrong decision around.
                Button { capture = .file } label: { Label("Lisää tiedosto", systemImage: "doc.badge.plus") }
                // A sales invoice to a customer; a supplier's bill comes in through "Lisää tiedosto".
                Button { Perf.beginOpen("laskuUusi"); newInvoice = true } label: { Label("Uusi myyntilasku", systemImage: "doc.text") }
                if mailboxMissing {
                    Button { showEmailImport = true } label: {
                        Text("Sähköpostia ei ole yhdistetty. Yhdistä se tästä ›").font(.footnote).foregroundStyle(Theme.accentDark)
                    }
                    .transition(.opacity)
                } else if let notice {
                    if noticeOpensRows {
                        Button { openBankRows() } label: {
                            Text("\(notice) Näytä tapahtumat ›").font(.footnote).foregroundStyle(Theme.accentDark)
                        }
                        .transition(.opacity)
                    } else {
                        Text(notice).font(.footnote).foregroundStyle(Theme.ink2).transition(.opacity)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            // The answer of an import or a mail fetch fades in under the actions.
            .motion(.snappy, value: notice)
            .motion(.snappy, value: noticeOpensRows)
            .motion(.snappy, value: mailboxMissing)
            .navigationTitle("Lisää")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { moreMenu }
            }
            // Connecting a mailbox opens here, so Back returns to these actions. At the sheet's own
            // height: grown to full height for it, the sheet stayed there after Back (X138); the owner
            // can still drag it up.
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
            // The capture closes through this sheet: the sheet's dismissal takes the cover with it,
            // so the owner sees the cover go down once and never this sheet in between.
            .fullScreenCover(item: $capture, onDismiss: { dismiss() }) { entry in
                CaptureFlow(transactionId: nil, opensCamera: entry == .camera, title: entry == .file ? "Lisää tiedosto" : "Uusi kuitti",
                            onClose: { dismiss() })
            }
            // The form closes through this sheet too, in one movement: the form going down first showed
            // these actions again before the sheet followed (X139). A swipe down still lands here.
            .sheet(isPresented: $newInvoice, onDismiss: openCreatedInvoice) {
                InvoiceFormView(existing: nil, preview: app.invoiceFormPreview(), onCreated: { id in createdInvoiceId = id },
                                onClose: { openCreatedInvoice() })
            }
            // A swipe down during an upload would lose its result.
            .interactiveDismissDisabled(busy)
            .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
                if case .success(let url) = result { Task { await upload(url) } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// The imports. While one runs, its spinner takes the button's place in the same slot, so the
    /// bar keeps its shape; the mailbox item's words follow once it is known whether one is connected.
    private var moreMenu: some View {
        Menu {
            Button { importing = true } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
            if hasMailbox == false {
                Button { showEmailImport = true } label: { Label("Yhdistä sähköposti", systemImage: "envelope.badge") }
            } else {
                Button { Task { await fetchEmail() } } label: { Label("Hae sähköpostista", systemImage: "envelope") }
            }
            // UI tests only (Debug + `-LKUITest`): a test cannot pick a file in the system's picker.
            if UITestHooks.active {
                Button {
                    Task { await importStatement(UITestHooks.fixtureStatement(day: APIDate.dayString(Date())), name: UITestHooks.statementFixtureName) }
                } label: { Label("Testitiliote", systemImage: "testtube.2") }
            }
        } label: {
            ZStack {
                Image(systemName: "ellipsis.circle").opacity(busy ? 0 : 1)
                // Not a hidden spinner: one spinning unseen keeps the app from going idle.
                if busy { ProgressView().transition(.opacity) }
            }
            .tapTarget()
            .motion(.easeOut(duration: 0.15), value: busy)
        }
        .disabled(busy)
        .accessibilityLabel("Toiminnot")
    }

    /// As on the web, a new invoice opens once made: the Myynti tab, then the invoice.
    /// Placed without animation behind this sheet, whose slide down is then the one movement:
    /// animated, the tab switch and the push ran under the closing sheet as two more.
    private func openCreatedInvoice() {
        if let id = createdInvoiceId {
            createdInvoiceId = nil
            app.pendingRoute = PendingRoute(tab: .myynti, route: .invoice(id), animated: false)
        }
        dismiss()
    }

    /// "Näytä tapahtumat ›": the rows the statement brought, in Kirjanpito > Pankki, placed behind
    /// this sheet as a new invoice is.
    private func openBankRows() {
        app.pendingRoute = PendingRoute(tab: .kirjanpito, route: .bankFeed, animated: false)
        dismiss()
    }

    private func upload(_ url: URL) async {
        guard !busy else { return }
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else {
            notice = "Tiedostoa ei voitu lukea."
            noticeOpensRows = false
            return
        }
        await importStatement(data, name: url.lastPathComponent)
    }

    private func importStatement(_ data: Data, name: String) async {
        guard !busy else { return }
        var form = Multipart()
        form.addFile("file", filename: name.replacingOccurrences(of: "\"", with: ""), mimeType: "application/octet-stream", data: data)
        busy = true
        mailboxMissing = false
        defer { busy = false }
        do {
            struct Result: Decodable { let count: Int? }
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            let count = (try? JSONDecoder().decode(Result.self, from: response.body))?.count ?? 0
            notice = "Tuotiin \(count) tapahtumaa."
            noticeOpensRows = count > 0
            Haptics.success()
        } catch {
            notice = error.userMessage
            noticeOpensRows = false
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
            noticeOpensRows = false
            Haptics.success()
        } catch let error as LKError where error.status == 404 {
            hasMailbox = false
            mailboxMissing = true
        } catch {
            notice = error.userMessage
            noticeOpensRows = false
        }
    }
}
