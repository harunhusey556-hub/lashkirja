import SwiftUI
import LashKirjaCore

/// One tiliote: its totals, rows and the actions of the web's StatementDetailView.
struct StatementDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let statementId: String
    @State private var state = ScreenLoad<Statement>()
    @State private var onlyOpen = false
    @State private var limit = ShowMore()
    @State private var selected: BankTransaction?
    @State private var editing: BankTransaction?
    @State private var deletingRow: BankTransaction?
    @State private var confirmDelete = false
    @State private var busy = false
    @State private var failure: String?
    @State private var locked = false
    @State private var status: String?
    /// A screen the row sheet asked for, pushed once the sheet has closed.
    @State private var openAfterSheet: Route?
    @State private var pushed: Route?

    var body: some View {
        List {
            if let statement = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                content(statement)
            } else {
                ScreenStateView(state: state, retry: load) { (_: Statement) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(state.value.map(StatementText.title) ?? "Tiliote")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if state.value != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { Task { await rerunMatching() } } label: { Label("Etsi kuitteja uudelleen", systemImage: "arrow.triangle.2.circlepath") }
                        Button { Task { await reinferTypes() } } label: { Label("Tunnista palkat uudelleen", systemImage: "wand.and.stars") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Poista tiliote", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(busy)
                    .accessibilityLabel("Toiminnot")
                }
            }
        }
        .confirmationDialog("Poistetaanko tiliote?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista tiliote", role: .destructive) { Task { await deleteStatement() } }
        } message: {
            if let statement = state.value {
                Text(StatementText.deleteDescription(title: StatementText.title(statement), rows: statement.transactions))
            }
        }
        .confirmationDialog(
            "Poistetaanko tapahtuma?",
            isPresented: Binding(get: { deletingRow != nil }, set: { if !$0 { deletingRow = nil } }),
            titleVisibility: .visible,
            presenting: deletingRow
        ) { row in
            Button("Poista", role: .destructive) { Task { await deleteRow(row) } }
        } message: { row in
            Text(StatementText.deleteRowDescription(row))
        }
        .sheet(item: $selected, onDismiss: {
            // "Avaa kuitti/lasku" in the sheet: pushed here once it has closed, so Back returns to the tiliote.
            if let route = openAfterSheet {
                openAfterSheet = nil
                pushed = route
            }
            Task { await load() }
        }) { row in
            BankRowSheet(row: row, showStatementLink: false, onOpen: { openAfterSheet = $0 })
        }
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .sheet(item: $editing) { row in
            StatementRowEditSheet(statementId: statementId, row: row) { Task { await changed() } }
        }
        .refreshable { await load() }
        .task(id: app.dataVersion) { await load() }
    }

    @ViewBuilder private func content(_ s: Statement) -> some View {
        let rows = s.transactions
        let relevant = rows.filter { $0.type != "oma_siirto" && $0.type != "palkka" }.count
        let linked = rows.filter { $0.matchStatus == "confirmed" }.count
        let sales = rows.filter { BankFeed.state(of: $0) == .sale }
        let suggestions = BankFeed.confirmableSuggestions(rows)
        let missing = rows.filter { BankFeed.state(of: $0) == .missing }.count
        let shown = rows.filter { !onlyOpen || BankFeed.needsAction($0) }

        Section {
            VStack(alignment: .leading, spacing: 4) {
                if let net = s.totals?.net {
                    MoneyText(amount: net, signed: true)
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .foregroundStyle(net >= 0 ? Theme.success : Theme.ink)
                }
                Text(StatementText.title(s)).font(.headline).foregroundStyle(Theme.ink)
                Text(s.bankAccount?.name ?? "Ei pankkitiliä").font(.caption).foregroundStyle(Theme.ink2)
                if relevant > 0 {
                    Text("\(linked)/\(relevant) kuittia kohdistettu").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            .listRowBackground(Color.clear)
        }

        if let totals = s.totals {
            Section {
                LabeledContent("Tulot") { MoneyText(amount: totals.income).foregroundStyle(Theme.success) }
                LabeledContent("Menot") { MoneyText(amount: totals.expenses) }
                LabeledContent("Netto") { MoneyText(amount: totals.net, signed: true).fontWeight(.semibold) }
            } footer: {
                if let transfers = totals.transfers, transfers != 0 {
                    Text("Omat siirrot \(Money.format(transfers)), eivät sisälly nettoon")
                }
            }
        }

        Section {
            Picker("Kohdekuukausi", selection: Binding(get: { s.periodMonth ?? "" }, set: { value in Task { await setPeriod(value) } })) {
                if s.periodMonth == nil { Text("Ei kuukautta").tag("") }
                ForEach(periodChoices(s), id: \.self) { key in
                    Text(StatementText.month(key)).tag(key)
                }
            }
        } footer: {
            Text("Valitse, minkä kuukauden luvuissa tämä tiliote näkyy Kodissa.")
        }

        if let failure {
            Section {
                Text(failure).foregroundStyle(Theme.danger)
                if locked {
                    NavigationLink(value: Route.periods) { Label("Kuukauden sulku", systemImage: "lock") }
                }
            }
        }
        if let status {
            Text(status).font(.footnote).foregroundStyle(Theme.success)
        }

        if !sales.isEmpty {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Tunnistetut myynnit").font(.body.weight(.semibold)).foregroundStyle(Theme.success)
                    Text("Tunnistimme tiliotteelta \(sales.count) myyntitapahtumaa (esim. MobilePay-tilitystä). Hyväksymällä lisäät ne automaattisesti kirjanpitoon tuloina, alv mukaan lukien.")
                        .font(.caption).foregroundStyle(Theme.ink)
                    Button("Hyväksy kaikki \(sales.count) kpl") { Task { await approveSales(sales) } }
                        .buttonStyle(.primary)
                        .disabled(busy)
                }
                .padding(.vertical, 4)
            }
        }

        if suggestions > 0 {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Kuittien kohdistus").font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                    Text(missing > 0 ? "\(suggestions) valmista ehdotusta · \(missing) tapahtumaa odottaa kuittia" : "\(suggestions) valmista ehdotusta")
                        .font(.caption).foregroundStyle(Theme.ink2)
                    Button(BankFeed.confirmAllLabel(suggestions)) { Task { await confirmAll() } }
                        .buttonStyle(.primary)
                        .disabled(busy)
                }
                .padding(.vertical, 4)
            }
        }

        Section {
            Picker("Näytä", selection: Binding(get: { onlyOpen }, set: { onlyOpen = $0; limit.reset() })) {
                Text("Kaikki").tag(false)
                Text("Vaatii toimia").tag(true)
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }

        Section {
            if rows.isEmpty {
                Text("Ei tapahtumia").foregroundStyle(Theme.ink2)
            } else if shown.isEmpty {
                Text("Kaikilla tapahtumilla on kuitti tai merkintä").foregroundStyle(Theme.ink2)
            }
            ForEach(shown.prefix(limit.visible(shown.count))) { row in
                Button { selected = row } label: { BankRow(row: row) }
                    .buttonStyle(.pressable)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { deletingRow = row } label: { Label("Poista", systemImage: "trash") }
                        Button { editing = row } label: { Label("Muokkaa", systemImage: "pencil") }
                            .tint(Theme.neutralFill)
                    }
            }
            ShowMoreButton(limit: $limit, total: shown.count)
        } header: {
            HStack {
                Text("Tapahtumat")
                Spacer()
                Text("\(shown.count) / \(rows.count)").monospacedDigit()
            }
        }
    }

    /// The statement's own month and the last two years, newest first.
    private func periodChoices(_ s: Statement) -> [String] {
        var keys = BankFeed.monthChoices(count: 24)
        if let current = s.periodMonth, !keys.contains(current) { keys.append(current) }
        return keys
    }

    private func load() async {
        state.begin()
        do {
            let response: StatementResponse = try await app.api.get("/api/statements/\(statementId)")
            state.succeed(response.statement)
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    /// Runs an action with the shared busy flag and error handling; true when it went through.
    @discardableResult
    private func perform(_ work: () async throws -> Void) async -> Bool {
        busy = true
        failure = nil
        locked = false
        status = nil
        defer { busy = false }
        do {
            try await work()
            Haptics.success()
            return true
        } catch is CancellationError {
            return false
        } catch {
            failure = error.userMessage
            locked = (error as? LKError)?.isPeriodLocked ?? false
            Haptics.error()
            return false
        }
    }

    /// Something changed rows other screens show too; `.task(id: app.dataVersion)` reloads this one.
    private func changed() async {
        app.dataVersion += 1
    }

    private func rerunMatching() async {
        var message: String?
        let ok = await perform {
            let result: BankMatchRunResult = try await app.api.send("POST", "/api/matching/run", body: EmptyBody())
            message = result.summary
        }
        if ok { status = message ?? "Uusia kohdistuksia ei löytynyt."; await changed() }
    }

    private func reinferTypes() async {
        var message: String?
        let ok = await perform {
            let result: StatementReinferResult = try await app.api.send("POST", "/api/statements/\(statementId)/reinfer-types", body: EmptyBody())
            if let statement = result.statement { state.succeed(statement) }
            message = result.message
        }
        if ok { status = message; await changed() }
    }

    private func confirmAll() async {
        var message: String?
        let ok = await perform {
            let result: BankConfirmAllResult = try await app.api.send("POST", "/api/matching/confirm-all", body: BankConfirmAllRequest(statementId: statementId))
            message = result.message
        }
        if ok { status = message; await changed() }
    }

    private func approveSales(_ rows: [BankTransaction]) async {
        struct Body: Encodable { let receiptIds: [String] }
        let ids = rows.compactMap(\.suggestedReceiptId)
        guard !ids.isEmpty else { return }
        let ok = await perform {
            let result: BatchApproveResult = try await app.api.send("POST", "/api/receipts/batch-approve", body: Body(receiptIds: ids))
            if let problem = result.firstError { throw LKError(status: 200, message: problem) }
        }
        if ok { await changed() } else { await load() }
    }

    private func setPeriod(_ month: String) async {
        guard !month.isEmpty, month != state.value?.periodMonth else { return }
        struct Body: Encodable { let periodMonth: String }
        let ok = await perform {
            let _: Ignored = try await app.api.send("PATCH", "/api/statements/\(statementId)", body: Body(periodMonth: month))
        }
        if ok { await changed() }
    }

    private func deleteRow(_ row: BankTransaction) async {
        struct Body: Encodable { let transactionId: String }
        let ok = await perform {
            let _: Ignored = try await app.api.send("DELETE", "/api/statements/\(statementId)/transactions", body: Body(transactionId: row.id))
        }
        if ok { await changed() }
    }

    private func deleteStatement() async {
        let api = app.api, id = statementId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/statements/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }
}

/// Edit one bank row: counterparty, date, amount, type and message.
struct StatementRowEditSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let statementId: String
    let row: BankTransaction
    let onSaved: () -> Void
    @State private var counterparty = ""
    @State private var hasDate = true
    @State private var date = Date()
    @State private var amount = ""
    @State private var type = "meno"
    @State private var message = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var opened: Fields?
    @State private var confirmDiscard = false

    /// The editable fields, to tell whether anything was changed since opening.
    private struct Fields: Equatable {
        let counterparty: String
        let hasDate: Bool
        let day: String
        let amount: String
        let type: String
        let message: String
    }

    private var current: Fields {
        Fields(counterparty: counterparty, hasDate: hasDate, day: hasDate ? APIDate.dayString(date) : "", amount: amount, type: type, message: message)
    }

    private var dirty: Bool { opened.map { $0 != current } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Vastapuoli", text: $counterparty).textInputAutocapitalization(.words)
                    Toggle("Päivämäärä", isOn: $hasDate)
                    if hasDate {
                        DatePicker("Päivä", selection: $date, displayedComponents: .date)
                    }
                    TextField("Summa", text: $amount).keyboardType(.numbersAndPunctuation)
                    Picker("Tyyppi", selection: $type) {
                        Text("Meno").tag("meno")
                        Text("Tulo").tag("tulo")
                        Text("Palkka").tag("palkka")
                        Text("Oma siirto").tag("oma_siirto")
                    }
                    TextField("Viesti", text: $message, axis: .vertical).lineLimit(1...4)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Muokkaa tapahtumaa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }.disabled(busy || Money.parse(amount) == nil)
                }
            }
            .onAppear(perform: fill)
        }
        .presentationDetents([.medium, .large])
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private func fill() {
        guard opened == nil else { return }
        defer { opened = current }
        counterparty = row.counterparty ?? ""
        if let day = row.date.flatMap({ APIDate.day(String($0.prefix(10))) }) { date = day } else { hasDate = false }
        amount = Money.format(row.amount).replacingOccurrences(of: "\u{00A0}€", with: "")
        type = StatementRowPatch.types.contains(row.type) ? row.type : (row.amount > 0 ? "tulo" : "meno")
        message = row.message ?? ""
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let patch = try StatementRowPatch.make(
                transactionId: row.id,
                counterparty: counterparty,
                date: hasDate ? APIDate.dayString(date) : nil,
                amount: amount,
                type: type,
                message: message
            )
            let _: Ignored = try await app.api.send("PATCH", "/api/statements/\(statementId)/transactions", body: patch)
            Haptics.success()
            onSaved()
            dismiss()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
