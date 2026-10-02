import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

struct BankFeedView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[BankFeed.Month]> = .idle
    @State private var onlyOpen = false
    @State private var search = ""
    @State private var selected: BankTransaction?
    @State private var importing = false
    @State private var notice: String?

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
            if let notice { Text(notice).font(.footnote).foregroundStyle(Theme.success) }
            if let months = state.value {
                if months.isEmpty {
                    ContentUnavailableView {
                        Label("Ei pankkitapahtumia vielä", systemImage: "building.columns")
                    } description: { Text("Tuo tiliote tai yhdistä pankki.") } actions: {
                        Button("Tuo tiliote") { importing = true }
                    }
                }
                ForEach(months) { month in
                    let rows = month.rows.filter { (!onlyOpen || BankFeed.needsAction($0)) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)) }
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { row in
                                Button { selected = row } label: { BankRow(row: row) }.buttonStyle(.plain)
                            }
                        } header: {
                            HStack {
                                Text(MonthKey.title(month.month, currentYear: String(MonthKey.current().prefix(4))))
                                Spacer()
                                if month.open > 0 { Text("\(month.open) avoinna").foregroundStyle(Theme.accent) }
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
        .navigationTitle("Pankki")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { importing = true } label: { Image(systemName: "square.and.arrow.down") }.accessibilityLabel("Tuo tiliote") } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
            if case .success(let url) = result { Task { await upload(url) } }
        }
        .sheet(item: $selected, onDismiss: { Task { await load() } }) { row in BankRowSheet(row: row) }
        .refreshable { await load() }
        .task { await load() }
        .animation(.snappy, value: onlyOpen)
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let list: StatementList = try await app.api.get("/api/statements")
            state = .loaded(BankFeed.months(list.statements))
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    private func upload(_ url: URL) async {
        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }
        guard let data = try? Data(contentsOf: url) else { return }
        var form = Multipart()
        let name = url.lastPathComponent.replacingOccurrences(of: "\"", with: "")
        form.addFile("file", filename: name, mimeType: "application/octet-stream", data: data)
        do {
            struct Result: Decodable { let count: Int?; let skippedDuplicates: Int? }
            let response = try await app.api.raw("POST", "/api/statements", body: form.finalize(), contentType: form.contentType)
            let result = try? JSONDecoder().decode(Result.self, from: response.body)
            notice = "Tuotiin \(result?.count ?? 0) tapahtumaa."
            Haptics.success()
            await load()
        } catch {
            notice = error.userMessage
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
    let row: BankTransaction
    @State private var busy = false
    @State private var failure: String?
    @State private var capture = false

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
            }
            .appDestinations()
            .navigationTitle(BankFeed.label(BankFeed.state(of: row), income: row.amount > 0))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
            .disabled(busy)
            .fullScreenCover(isPresented: $capture, onDismiss: { dismiss() }) { CaptureFlow(transactionId: row.id) }
        }
        .presentationDetents([.medium, .large])
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
                NavigationLink(value: Route.receipt(receipt.id)) { Label("Avaa kuitti", systemImage: "doc.text") }
            }
            Button(role: .destructive) { Task { await unlink() } } label: { Label("Poista kohdistus", systemImage: "link.badge.plus") }
        case .ignored:
            Button { Task { await ignore(false) } } label: { Label("Palauta", systemImage: "arrow.uturn.backward") }
        case .invoice:
            if let invoice = row.paidInvoice {
                NavigationLink(value: Route.invoice(invoice.id)) { Label("Avaa lasku \(invoice.number)", systemImage: "doc.text") }
            } else {
                Text("Tämä maksu on kirjattu laskulle.").foregroundStyle(Theme.ink2)
            }
        case .transfer:
            Text("Oma siirto tai palkka. Tämä ei tarvitse kuittia.").foregroundStyle(Theme.ink2)
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
        await run { let _: Ignored = try await app.api.send("POST", "/api/receipts/batch-approve", body: Body(receiptIds: [id])) }
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
