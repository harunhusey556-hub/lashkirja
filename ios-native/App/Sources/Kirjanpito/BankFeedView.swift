import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

struct BankFeedView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[BankFeed.Month]> = .idle
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var statements: [Statement] = []
    @State private var onlyOpen: Bool
    @State private var search = ""
    @State private var month: String?
    @State private var selected: BankTransaction?
    /// A row to open once after loading (from a Koti/Työjono task).
    @State private var pendingFocus: String?
    @State private var importing = false
    @State private var notice: String?
    @State private var noticeFailed = false
    @State private var bulkBusy = false
    /// A screen the row sheet asked for ("Avaa kuitti"): pushed here once the sheet has closed,
    /// so it lands on this tab's stack and Back returns to the feed.
    @State private var openAfterSheet: Route?
    @State private var pushed: Route?

    /// `month` opens the feed on that month, `onlyOpen` on "Vaatii toimia" (web `?nayta=toimet`),
    /// and `focusTransactionId` opens that row's sheet once it is found.
    init(month: String? = nil, onlyOpen: Bool = false, focusTransactionId: String? = nil) {
        _month = State(initialValue: month.flatMap { $0.isEmpty ? nil : $0 })
        _onlyOpen = State(initialValue: onlyOpen)
        _pendingFocus = State(initialValue: focusTransactionId.flatMap { $0.isEmpty ? nil : $0 })
    }

    private var loadKey: String { "\(app.dataVersion)|\(month ?? "")" }
    private var confirmable: Int { BankFeed.confirmableSuggestions(statements.flatMap(\.transactions)) }

    var body: some View {
        List {
            Section {
                Picker("Näytä", selection: $onlyOpen) {
                    Text("Kaikki").tag(false)
                    Text("Vaatii toimia").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section {
                if let month {
                    Button { self.month = nil } label: {
                        Label("\(StatementText.month(month)) · näytä kaikki kuukaudet", systemImage: "xmark.circle")
                    }
                }
                NavigationLink(value: Route.statements) {
                    HStack {
                        Label("Tiliotteet", systemImage: "doc.plaintext").foregroundStyle(Theme.ink)
                        Spacer()
                        if month == nil && !statements.isEmpty {
                            Text("\(statements.count)").foregroundStyle(Theme.ink2)
                        }
                    }
                }
            }
            if let notice { Text(notice).font(.footnote).foregroundStyle(noticeFailed ? Theme.danger : Theme.success) }
            if confirmable > 0 {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Kuittien kohdistus").font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                        Text("\(confirmable) valmista ehdotusta").font(.caption).foregroundStyle(Theme.ink2)
                        Button { Task { await confirmAll() } } label: {
                            if bulkBusy { ProgressView() } else { Text(BankFeed.confirmAllLabel(confirmable)) }
                        }
                        .buttonStyle(.primary)
                        .disabled(bulkBusy)
                    }
                    .padding(.vertical, 4)
                }
            }
            if let months = state.value {
                if months.isEmpty {
                    ContentUnavailableView {
                        Label(month == nil ? "Ei pankkitapahtumia vielä" : "Ei tapahtumia tässä kuussa", systemImage: "building.columns")
                    } description: { Text("Tuo tiliote tai yhdistä pankki.") } actions: {
                        // Borderless: two buttons in one list row each keep their own tap.
                        Button("Tuo tiliote") { importing = true }.buttonStyle(.borderless)
                        Button("Yhdistä pankki") { pushed = .bankAccounts }.buttonStyle(.borderless)
                    }
                }
                ForEach(months) { group in
                    let rows = group.rows.filter { (!onlyOpen || BankFeed.needsAction($0)) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)) }
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { row in
                                Button { selected = row } label: { BankRow(row: row) }.buttonStyle(.plain)
                            }
                        } header: {
                            HStack {
                                Text(group.month.isEmpty ? "Päiväämättömät" : MonthKey.title(group.month, currentYear: String(MonthKey.current().prefix(4))))
                                Spacer()
                                if group.open > 0 { Text("\(group.open) avoinna").foregroundStyle(Theme.accent) }
                            }
                        }
                    }
                }
            } else {
                LoadState(state: state, retry: load) { (_: [BankFeed.Month]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $search, prompt: "Hae…")
        .navigationTitle("Pankkitapahtumat")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Kuukausi", selection: $month) {
                        Text("Kaikki kuukaudet").tag(String?.none)
                        ForEach(BankFeed.monthChoices(), id: \.self) { key in
                            Text(StatementText.month(key)).tag(String?.some(key))
                        }
                    }
                } label: {
                    Image(systemName: month == nil ? "calendar" : "calendar.badge.clock")
                }
                .accessibilityLabel("Valitse kuukausi")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { importing = true } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
                    Button { Task { await rerunMatching() } } label: { Label("Etsi kuitteja uudelleen", systemImage: "arrow.triangle.2.circlepath") }
                        .disabled(bulkBusy)
                    if confirmable > 0 {
                        Button { Task { await confirmAll() } } label: { Label(BankFeed.confirmAllLabel(confirmable), systemImage: "link") }
                            .disabled(bulkBusy)
                    }
                    Button { pushed = .bankAccounts } label: { Label("Pankkiyhteys ja tilit", systemImage: "building.columns") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Toiminnot")
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.statements) { Image(systemName: "doc.plaintext") }
                    .accessibilityLabel("Tiliotteet")
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
            if case .success(let url) = result { Task { await upload(url) } }
        }
        .sheet(item: $selected, onDismiss: {
            if let route = openAfterSheet {
                openAfterSheet = nil
                pushed = route
            }
            Task { await load() }
        }) { row in
            BankRowSheet(row: row, onOpen: { openAfterSheet = $0 })
        }
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .refreshable { await load() }
        .task(id: loadKey) {
            guard state.value == nil || gate.isDue(key: month ?? "", version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: month ?? "", version: version) }
        }
        .animation(.snappy, value: onlyOpen)
    }

    private func load() async {
        if state.value == nil { state = .loading }
        // A slow answer for a month the owner already left must not replace the newer one.
        let requested = month
        do {
            let list: StatementList = try await app.api.get("/api/statements", query: BankFeed.query(month: requested))
            guard requested == month else { return }
            statements = list.statements
            state = .loaded(BankFeed.months(list.statements))
            openPendingFocus()
        } catch is CancellationError {
        } catch {
            guard requested == month else { return }
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    /// Opens the asked-for row once: from the loaded months, else from all months.
    private func openPendingFocus() {
        guard let id = pendingFocus else { return }
        if let row = statements.flatMap({ $0.transactions }).first(where: { $0.id == id }) {
            pendingFocus = nil
            selected = row
        } else if month != nil {
            // Not in this month: look in every month (the month change reloads).
            month = nil
        } else {
            pendingFocus = nil
        }
    }

    private func confirmAll() async {
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            let result: BankConfirmAllResult = try await app.api.send("POST", "/api/matching/confirm-all", body: BankConfirmAllRequest(periodMonth: month))
            notice = result.message ?? "Ei kohdistettavia ehdotuksia."
            noticeFailed = false
            Haptics.success()
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            notice = error.userMessage
            noticeFailed = true
            Haptics.error()
        }
    }

    private func rerunMatching() async {
        bulkBusy = true
        defer { bulkBusy = false }
        do {
            let result: BankMatchRunResult = try await app.api.send("POST", "/api/matching/run", body: EmptyBody())
            notice = result.summary ?? "Uusia kohdistuksia ei löytynyt."
            noticeFailed = false
            Haptics.success()
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            notice = error.userMessage
            noticeFailed = true
            Haptics.error()
        }
    }

    private func upload(_ url: URL) async {
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else { notice = "Tiedostoa ei voitu lukea."; noticeFailed = true; return }
        var form = Multipart()
        let name = url.lastPathComponent.replacingOccurrences(of: "\"", with: "")
        form.addFile("file", filename: name, mimeType: "application/octet-stream", data: data)
        do {
            struct Result: Decodable { let count: Int?; let skippedDuplicates: Int?; let notice: String? }
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            let result = try? JSONDecoder().decode(Result.self, from: response.body)
            let imported = "Tuotiin \(result?.count ?? 0) tapahtumaa."
            notice = [imported, result?.notice].compactMap { $0 }.joined(separator: " ")
            noticeFailed = false
            Haptics.success()
            app.dataVersion += 1
        } catch {
            notice = error.userMessage
            noticeFailed = true
            Haptics.error()
        }
    }
}

struct BankRow: View {
    let row: BankTransaction
    var body: some View {
        let state = BankFeed.state(of: row)
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).lineLimit(1).foregroundStyle(Theme.ink)
                Text([row.date.map(APIDate.displayDay), BankFeed.label(state, income: row.amount > 0)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(BankFeed.needsAction(row) ? Theme.accent : Theme.ink2)
            }
            Spacer()
            MoneyText(amount: row.amount, signed: true)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(row.amount > 0 ? Theme.success : Theme.ink)
        }
        .contentShape(Rectangle())
    }
}

struct BankRowSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var row: BankTransaction
    /// Off when the sheet is opened from the tiliote itself.
    let showStatementLink: Bool
    /// "Avaa tiliote/kuitti/lasku": handed to the screen under the sheet, which pushes it after
    /// the sheet closes. Without it the screen opens inside the sheet.
    let onOpen: ((Route) -> Void)?
    @State private var busy = false
    @State private var failure: String?
    @State private var capture = false
    @State private var captured = false
    @State private var candidates: Loadable<[BankMatchCandidate]> = .idle
    /// The data version the row was read at; a newer one re-reads it.
    @State private var seenVersion: Int?

    init(row: BankTransaction, showStatementLink: Bool = true, onOpen: ((Route) -> Void)? = nil) {
        _row = State(initialValue: row)
        self.showStatementLink = showStatementLink
        self.onOpen = onOpen
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.title).font(.headline)
                        if let date = row.date { Text(APIDate.displayDay(date)).font(.caption).foregroundStyle(Theme.ink2) }
                        MoneyText(amount: row.amount, signed: true)
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(row.amount > 0 ? Theme.success : Theme.ink)
                    }
                    .listRowBackground(Color.clear)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                Section { actions }
                if searchable { candidateSection }
                if showStatementLink {
                    Section {
                        openLink(.statement(row.statementId), "Avaa tiliote", symbol: "doc.plaintext")
                    }
                }
            }
            .appDestinations()
            .navigationTitle(BankFeed.label(BankFeed.state(of: row), income: row.amount > 0))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
            .disabled(busy)
            // Only a saved receipt closes the row; a cancelled camera returns to it.
            .fullScreenCover(isPresented: $capture, onDismiss: { if captured { dismiss() } }) {
                CaptureFlow(transactionId: row.id, onSaved: { captured = true })
            }
            .task(id: app.dataVersion) { await refreshRow() }
        }
        .presentationDetents([.medium, .large])
    }

    /// Something changed elsewhere (e.g. the kuitti was unlinked from a pushed screen):
    /// the row is read again; a row that no longer exists closes the sheet.
    private func refreshRow() async {
        let version = app.dataVersion
        guard let seen = seenVersion else { seenVersion = version; return }
        guard seen != version, !busy else { return }
        do {
            let response: StatementResponse = try await app.api.get("/api/statements/\(row.statementId)")
            guard !Task.isCancelled else { return }
            seenVersion = version
            if let fresh = response.statement.transactions.first(where: { $0.id == row.id }) {
                if fresh != row {
                    row = fresh
                    candidates = .idle
                }
            } else {
                dismiss()
            }
        } catch is CancellationError {
        } catch let error as LKError where error.status == 404 {
            dismiss()
        } catch {
            // Keep the copy on screen; the next change tries again.
        }
    }

    @ViewBuilder private var actions: some View {
        switch BankFeed.state(of: row) {
        case .sale:
            Button { Task { await approveSale() } } label: { Label("Hyväksy myynti", systemImage: "checkmark.circle") }
            Button { Task { await ignore(true) } } label: { Label("Ei ole myyntiä", systemImage: "nosign") }
        case .suggested:
            if let suggested = row.suggestedReceipt {
                Text("Ehdotus: \(suggested.vendor ?? "kuitti")").foregroundStyle(Theme.ink2)
                Button { Task { await confirm(suggested.id) } } label: { Label("Kohdista kuitti", systemImage: "link") }
                Button { Task { await reject(suggested.id) } } label: { Label("Väärä kuitti", systemImage: "xmark") }
            }
        case .missing:
            if row.amount < 0 {
                Button { capture = true } label: { Label("Kuvaa kuitti", systemImage: "camera") }
            }
            Button { Task { await ignore(true) } } label: { Label(row.amount > 0 ? "Ei vaadi kuittia" : "Kuittia ei tarvita", systemImage: "nosign") }
        case .linked:
            if let receipt = row.receipt {
                openLink(.receipt(receipt.id), "Avaa kuitti", symbol: "doc.text")
            }
            Button(role: .destructive) { Task { await unlink() } } label: { Label("Poista kohdistus", systemImage: "link.badge.plus") }
        case .ignored:
            Button { Task { await ignore(false) } } label: { Label("Palauta", systemImage: "arrow.uturn.backward") }
        case .invoice:
            if let invoice = row.paidInvoice {
                openLink(.invoice(invoice.id), "Avaa lasku \(invoice.number)", symbol: "doc.text")
            } else {
                Text("Tämä maksu on kirjattu laskulle.").foregroundStyle(Theme.ink2)
            }
        case .transfer:
            Text("Oma siirto tai palkka. Tämä ei tarvitse kuittia.").foregroundStyle(Theme.ink2)
        }
    }

    @ViewBuilder private func openLink(_ route: Route, _ title: String, symbol: String) -> some View {
        if let onOpen {
            Button {
                onOpen(route)
                dismiss()
            } label: {
                Label(title, systemImage: symbol)
            }
        } else {
            NavigationLink(value: route) { Label(title, systemImage: symbol) }
        }
    }

    /// "Etsi kuitti": a kuitti that is waiting or suggested can be chosen by hand.
    private var searchable: Bool {
        let state = BankFeed.state(of: row)
        return (state == .missing || state == .suggested) && BankFeed.canSearchReceipts(row)
    }

    @ViewBuilder private var candidateSection: some View {
        let inline = (row.matchCandidates ?? []).filter { $0.receipt != nil && $0.receipt?.id != row.suggestedReceiptId }
        if !inline.isEmpty && candidates.value == nil {
            Section {
                ForEach(inline, id: \.self) { candidate in candidateButton(candidate) }
            } header: {
                Text("Ehdotetut kuitit")
            }
        }
        Section {
            switch candidates {
            case .idle:
                Button { Task { await loadCandidates() } } label: { Label("Etsi kuitti", systemImage: "magnifyingglass") }
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .failed(let message):
                Text(message).foregroundStyle(Theme.danger)
                Button("Yritä uudelleen") { Task { await loadCandidates() } }
            case .loaded(let list):
                if list.isEmpty {
                    Text("Ei sopivia kuitteja. Lisää ensin uusi kuitti Kuitit-näkymässä.").foregroundStyle(Theme.ink2)
                } else {
                    ForEach(list, id: \.self) { candidate in candidateButton(candidate) }
                }
            }
        } header: {
            if candidates.value != nil { Text("Valitse kuitti") }
        }
    }

    @ViewBuilder private func candidateButton(_ candidate: BankMatchCandidate) -> some View {
        if let receipt = candidate.receipt {
            Button { Task { await confirm(receipt.id) } } label: {
                HStack {
                    Text(BankMatchText.receiptLabel(receipt)).foregroundStyle(Theme.ink).lineLimit(2)
                    Spacer()
                    Text("\(candidate.percent) %").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
        }
    }

    private func loadCandidates() async {
        candidates = .loading
        do {
            let response: BankMatchCandidates = try await app.api.get("/api/matching/candidates", query: ["transactionId": row.id])
            candidates = .loaded(response.usable)
        } catch is CancellationError {
            candidates = .idle
        } catch {
            candidates = .failed(error.userMessage)
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        failure = nil
        defer { busy = false }
        do { try await work(); Haptics.success(); dismiss() }
        catch { failure = error.userMessage; Haptics.error() }
    }

    private func approveSale() async {
        guard let id = row.suggestedReceiptId else { return }
        struct Body: Encodable { let receiptIds: [String] }
        await run {
            let result: BatchApproveResult = try await app.api.send("POST", "/api/receipts/batch-approve", body: Body(receiptIds: [id]))
            if let problem = result.firstError { throw LKError(status: 200, message: problem) }
        }
    }

    private func confirm(_ receiptId: String) async {
        struct Body: Encodable { let transactionId: String; let receiptId: String }
        await run { let _: Ignored = try await app.api.send("POST", "/api/matching/confirm", body: Body(transactionId: row.id, receiptId: receiptId)) }
    }

    private func reject(_ receiptId: String) async {
        struct Body: Encodable { let transactionId: String; let receiptId: String }
        await run { let _: Ignored = try await app.api.send("POST", "/api/matching/reject", body: Body(transactionId: row.id, receiptId: receiptId)) }
    }

    private func ignore(_ ignored: Bool) async {
        struct Body: Encodable { let transactionId: String; let ignored: Bool }
        await run { let _: Ignored = try await app.api.send("POST", "/api/matching/ignore", body: Body(transactionId: row.id, ignored: ignored)) }
    }

    private func unlink() async {
        struct Body: Encodable { let transactionId: String }
        await run { let _: Ignored = try await app.api.send("POST", "/api/matching/unlink", body: Body(transactionId: row.id)) }
    }
}
