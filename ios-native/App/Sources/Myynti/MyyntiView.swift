import SwiftUI
import LashKirjaCore

enum InvoiceFilter: String, CaseIterable, Identifiable {
    case all, draft, sent, overdue, paid
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "Kaikki"
        case .draft: "Luonnokset"
        case .sent: "Odottaa"
        case .overdue: "Myöhässä"
        case .paid: "Maksetut"
        }
    }
    func matches(_ invoice: Invoice) -> Bool {
        switch self {
        case .all: true
        case .draft: invoice.displayStatus == .draft
        case .sent: invoice.displayStatus == .sent
        case .overdue: invoice.displayStatus == .overdue
        case .paid: invoice.displayStatus == .paid || invoice.displayStatus == .credited
        }
    }
}

struct MyyntiView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<InvoiceList> = .idle
    @State private var filter: InvoiceFilter = .all
    @State private var search = ""
    @State private var showNew = false

    var body: some View {
        List {
            if let list = state.value {
                Section {
                    summary(list.aging)
                        .listRowBackground(Theme.surface)
                }
                Section {
                    NavigationLink(value: Route.customers) { Label("Asiakkaat", systemImage: "person.2") }
                }
                Section {
                    Picker("Näytä", selection: $filter) {
                        ForEach(InvoiceFilter.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                let rows = visible(list.invoices)
                Section(rows.isEmpty ? "" : "\(rows.count) laskua") {
                    if rows.isEmpty {
                        Text(search.isEmpty ? "Ei laskuja tässä näkymässä." : "Ei osumia.")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(rows) { invoice in
                        NavigationLink(value: Route.invoice(invoice.id)) { InvoiceRow(invoice: invoice) }
                    }
                }
            } else {
                LoadState(state: state, retry: load) { (_: InvoiceList) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $search, prompt: "Hae asiakasta tai numeroa")
        .refreshable { await load() }
        .navigationTitle("Myynti")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showNew = true } label: { Label("Uusi lasku", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $showNew, onDismiss: { Task { await load() } }) {
            InvoiceFormView(existing: nil)
        }
        .task(id: app.dataVersion) { await load() }
        .animation(.snappy, value: filter)
    }

    private func visible(_ invoices: [Invoice]) -> [Invoice] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return invoices.filter { invoice in
            filter.matches(invoice) && (needle.isEmpty
                || invoice.customer.name.lowercased().contains(needle)
                || String(invoice.number) == needle
                || invoice.reference.contains(needle))
        }
    }

    private func summary(_ aging: InvoiceList.Aging) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Saatavat, avoinna").font(.caption).foregroundStyle(Theme.ink2)
                MoneyText(amount: aging.totalOpen).font(.title2.weight(.semibold))
            }
            Spacer()
            if aging.overdueCount > 0 {
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Myöhässä \(aging.overdueCount)").font(.caption).foregroundStyle(Theme.danger)
                    MoneyText(amount: aging.overdue).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.danger)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await app.api.get("/api/invoices")) }
        catch is CancellationError {}
        catch { if state.value == nil { state = .failed(error.userMessage) } }
    }
}

struct InvoiceRow: View {
    let invoice: Invoice
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(invoice.customer.name).font(.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text("Lasku \(invoice.number) · \(APIDate.displayDay(invoice.dueDate))").font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                MoneyText(amount: invoice.gross).font(.subheadline.weight(.semibold))
                StatusBadge(status: invoice.displayStatus)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: InvoiceStatus
    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
    }
    private var color: Color {
        switch status {
        case .draft: Theme.ink2
        case .sent: Theme.warning
        case .overdue: Theme.danger
        case .paid, .credited: Theme.success
        }
    }
}
