import SwiftUI
import LashKirjaCore

enum ReceiptTypeFilter: String, CaseIterable, Identifiable {
    case all, meno, tulo
    var id: String { rawValue }
    var title: String { switch self { case .all: "Kaikki"; case .meno: "Menot"; case .tulo: "Tulot" } }
}

struct ReceiptsView: View {
    @Environment(AppModel.self) private var app
    @State private var receipts: Loadable<[Receipt]> = .idle
    @State private var pending: [Receipt] = []
    @State private var filter: ReceiptTypeFilter = .all
    @State private var search = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var capture = false

    var body: some View {
        List {
            if !pending.isEmpty {
                Section {
                    ForEach(pending) { receipt in
                        HStack {
                            NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt) }
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Hyväksy") { Task { await review([receipt.id]) } }.tint(Theme.success)
                        }
                    }
                    Button { Task { await review(pending.map(\.id)) } } label: {
                        Label("Hyväksy kaikki (\(pending.count))", systemImage: "checkmark.circle")
                    }
                    .disabled(busy)
                } header: {
                    Text("Odottaa hyväksyntää")
                } footer: {
                    Text("Pyyhkäise vasemmalle hyväksyäksesi yhden.")
                }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
            Section {
                Picker("Laji", selection: $filter) { ForEach(ReceiptTypeFilter.allCases) { Text($0.title).tag($0) } }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if let all = receipts.value {
                let rows = visible(all)
                Section(rows.isEmpty ? "" : "\(rows.count) kuittia") {
                    if rows.isEmpty { Text("Ei kuitteja.").foregroundStyle(Theme.ink2) }
                    ForEach(rows) { receipt in
                        NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt) }
                    }
                }
            } else {
                LoadState(state: receipts, retry: load) { (_: [Receipt]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $search, prompt: "Hae myyjää")
        .navigationTitle("Kuitit")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { capture = true } label: { Image(systemName: "camera") }.accessibilityLabel("Kuvaa kuitti") } }
        .fullScreenCover(isPresented: $capture, onDismiss: { Task { await load() } }) { CaptureFlow(transactionId: nil) }
        .refreshable { await load() }
        .task { await load() }
        .animation(.snappy, value: pending.map(\.id))
    }

    private func visible(_ all: [Receipt]) -> [Receipt] {
        all.filter { r in
            (filter == .all || r.type == filter.rawValue)
                && (search.isEmpty || r.title.localizedCaseInsensitiveContains(search))
        }
    }

    private func load() async {
        if receipts.value == nil { receipts = .loading }
        do {
            let list: ReceiptList = try await app.api.get("/api/receipts", query: ["sort": "date_desc"])
            receipts = .loaded(list.receipts)
            let queue: ReceiptList = try await app.api.get("/api/receipts", query: ["reviewStatus": "pending"])
            pending = queue.receipts
        } catch is CancellationError {
        } catch {
            if receipts.value == nil { receipts = .failed(error.userMessage) }
        }
    }

    private func review(_ ids: [String]) async {
        struct Body: Encodable { let receiptIds: [String] }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let result: BatchApproveResult = try await app.api.send("POST", "/api/receipts/batch-approve", body: Body(receiptIds: ids))
            if let problem = result.firstError {
                failure = problem
                Haptics.error()
                await load()
                return
            }
            Haptics.success()
            withAnimation { pending.removeAll { ids.contains($0.id) } }
            await load()
        } catch {
            failure = error.userMessage
        }
    }
}

struct ReceiptRow: View {
    let receipt: Receipt
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.title).lineLimit(1)
                Text([receipt.date.map(APIDate.displayDay), receipt.category].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer()
            if let amount = receipt.totalAmount {
                MoneyText(amount: receipt.isIncome ? amount : -amount, signed: receipt.isIncome)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(receipt.isIncome ? Theme.success : Theme.ink)
            }
        }
    }
}
