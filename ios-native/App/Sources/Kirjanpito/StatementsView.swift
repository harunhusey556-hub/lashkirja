import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

/// Tiliotteet: import a statement file (to a chosen account or detected) and the statement
/// files, newest first. Pankkitapahtumat lists the rows; this lists the files.
struct StatementsView: View {
    @Environment(AppModel.self) private var app
    @State private var statements = ScreenLoad<[Statement]>()
    @State private var accounts: [BankAccount] = []
    @State private var limit = ShowMore()
    @State private var importing = false
    @State private var uploading = false
    @State private var uploadMessage: String?
    @State private var uploadFailed = false
    /// "" = Tunnista automaattisesti.
    @State private var targetAccountId = ""
    @State private var targetChosen = false
    @State private var openedStatement: String?
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()

    var body: some View {
        List {
            Section {
                Text("Tuo tiliote tiedostona (PDF, XML, XLSX tai CSV), jos pankkia ei ole yhdistetty tai tarvitset vanhempia tapahtumia.")
                    .font(.caption)
                    .foregroundStyle(Theme.ink2)
                if !accounts.isEmpty {
                    Picker("Pankkitili", selection: Binding(get: { targetAccountId }, set: { targetAccountId = $0; targetChosen = true })) {
                        Text("Tunnista automaattisesti").tag("")
                        ForEach(accounts) { account in
                            Text(account.bankName.map { "\(account.name) · \($0)" } ?? account.name).tag(account.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
                Button { importing = true } label: {
                    if uploading {
                        HStack(spacing: 8) { ProgressView(); Text("Käsitellään…") }
                    } else {
                        Label("Tuo tiliote", systemImage: "square.and.arrow.down")
                    }
                }
                .disabled(uploading)
                if let uploadMessage {
                    Text(uploadMessage).font(.caption).foregroundStyle(uploadFailed ? Theme.danger : Theme.ink2)
                }
            } header: {
                Text("Tuo tiliote")
            }
            if let list = statements.value?.filter({ !app.removedIds.contains($0.id) }) {
                if let banner = statements.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    if list.isEmpty {
                        Text("Ei vielä tiliotteita. Tuo tiliote tai yhdistä pankki.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(list.prefix(limit.visible(list.count))) { statement in
                        NavigationLink(value: Route.statement(statement.id)) { StatementFileRow(statement: statement) }
                    }
                    ShowMoreButton(limit: $limit, total: list.count)
                } header: {
                    Text("Tiedostot")
                }
            } else {
                ScreenStateView(state: statements, retry: load) { (_: [Statement]) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
            Section {
                NavigationLink(value: Route.bankAccounts) {
                    Label("Pankkiyhteys ja tilit", systemImage: "building.columns")
                }
            } footer: {
                Text("Yhdistetty pankki hakee tapahtumat itse, eikä tiliotetta tarvitse tuoda.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Tiliotteet")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
            if case .success(let url) = result { Task { await upload(url) } }
        }
        .navigationDestination(item: $openedStatement) { id in StatementDetailView(statementId: id) }
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard statements.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }

    private func load() async {
        statements.begin()
        let api = app.api
        // Files and accounts load side by side; the accounts only fill the picker.
        async let filesResult = Result<StatementList, Error>(asyncCatching: { try await api.get("/api/statements") })
        async let accountsResult: BankAccountsOverview? = try? api.get("/api/bank-accounts")
        let (files, overview) = await (filesResult, accountsResult)
        if Task.isCancelled { return }
        switch files {
        case .success(let value): statements.succeed(value.statements)
        case .failure(let error):
            if error is CancellationError { return }
            statements.fail(error)
        }
        if let overview {
            // Accounts a tiliote can be imported to: the ones in use. Keep what was picked.
            let usable = overview.accounts.filter { $0.archivedAt == nil }
            accounts = usable
            if !targetChosen || !usable.contains(where: { $0.id == targetAccountId }) {
                targetAccountId = usable.first(where: { $0.isDefault == true })?.id ?? ""
            }
        }
    }

    private func upload(_ url: URL) async {
        guard !uploading else { return }
        // Busy from the first moment: the file is read before the request, and a second pick
        // must not start meanwhile.
        uploading = true
        defer { uploading = false }
        uploadFailed = false
        uploadMessage = "Käsitellään tiliotetta…"
        let scoped = url.startAccessingSecurityScopedResource()
        // Sized first (the server's statement limit), then read off the main actor.
        let read = await LocalFile.read(url, maxBytes: LocalFile.statementMaxBytes)
        if scoped { url.stopAccessingSecurityScopedResource() }
        let data: Data
        switch read {
        case .success(let bytes): data = bytes
        case .failure(let problem):
            uploadMessage = problem.message(maxBytes: LocalFile.statementMaxBytes)
            uploadFailed = true
            Haptics.error()
            return
        }
        var form = Multipart()
        form.addFile("file", filename: url.lastPathComponent.replacingOccurrences(of: "\"", with: ""), mimeType: "application/octet-stream", data: data)
        if !targetAccountId.isEmpty { form.addField("bankAccountId", targetAccountId) }
        do {
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            let result = try? JSONDecoder().decode(StatementUploadResult.self, from: response.body)
            uploadMessage = result?.message ?? "Tiliote tuotiin."
            Haptics.success()
            await load()
            if let id = result?.statementId { openedStatement = id }
        } catch is CancellationError {
            uploadMessage = nil
        } catch {
            uploadMessage = error.userMessage
            uploadFailed = true
            Haptics.error()
        }
    }
}
