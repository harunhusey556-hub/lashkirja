import SwiftUI
import LashKirjaCore

struct MyyntiView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<InvoiceList> = .idle
    @State private var counts: [String: Int]?
    @State private var filter: SalesFilter = .all
    @State private var search = ""
    @State private var showNew = false
    @State private var showMatch = false
    @State private var notice: String?

    var body: some View {
        List {
            if let list = state.value {
                Section {
                    summary(list.aging)
                        .listRowBackground(Theme.surface)
                }
                if let notice {
                    Section {
                        Text(notice).font(.subheadline).foregroundStyle(Theme.ink)
                    }
                }
                Section {
                    NavigationLink(value: Route.customers) { Label("Asiakkaat", systemImage: "person.2") }
                    NavigationLink(value: Route.recurringInvoices) { Label("Toistuvat laskut", systemImage: "repeat") }
                    Button { showMatch = true } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Kohdista pankkimaksut", systemImage: "building.columns")
                            Text("Kirjaa maksut viitenumeron mukaan").font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    .foregroundStyle(Theme.ink)
                }
                Section {
                    chips
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                let rows = visible(list.invoices)
                Section {
                    if rows.isEmpty {
                        Text(search.isEmpty ? "Ei laskuja tässä näkymässä." : "Ei osumia.")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(rows) { invoice in
                        NavigationLink(value: Route.invoice(invoice.id)) { InvoiceRow(invoice: invoice) }
                    }
                } header: {
                    if !rows.isEmpty { Text("\(rows.count) laskua") }
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
        .sheet(isPresented: $showMatch) {
            BankMatchSheet { message in
                notice = message
                app.dataVersion += 1
            }
        }
        .task(id: app.dataVersion) { await load() }
        .animation(.snappy, value: filter)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SalesFilter.chips(counts)) { chip in
                    let selected = chip.filter == filter
                    Button {
                        filter = chip.filter
                        Haptics.selection()
                    } label: {
                        HStack(spacing: 4) {
                            Text(chip.filter.title)
                            if let count = chip.count {
                                Text("\(count)").monospacedDigit().foregroundStyle(selected ? Theme.onInk.opacity(0.8) : Theme.ink2)
                            }
                        }
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? Theme.onInk : Theme.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(selected ? Theme.ink : Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.line, lineWidth: selected ? 0 : 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
        // A chip whose status vanished (credited after a refresh) falls back to "Kaikki".
        .onChange(of: counts) { _, _ in
            if !SalesFilter.chips(counts).contains(where: { $0.filter == filter }) { filter = .all }
        }
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
        if let fresh = await loadCounts() { counts = fresh }
    }

    /// Per-status counts for the chips; counted by the server, so the list's row cap cannot skew them.
    private func loadCounts() async -> [String: Int]? {
        do {
            let response: InvoiceCounts = try await app.api.get("/api/invoices/counts")
            return response.counts
        } catch {
            return nil
        }
    }
}

/// Reference-number reconciliation: first what a run would book, then the run (`/api/invoices/match`).
struct BankMatchSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onDone: (String) -> Void
    @State private var state: Loadable<BankMatchPreview> = .idle
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                if let preview = state.value {
                    Section {
                        Text(preview.headline)
                        ForEach(preview.rows) { row in
                            HStack {
                                Text("Lasku \(row.invoiceNumber), \(row.customerName)").lineLimit(2)
                                Spacer()
                                MoneyText(amount: row.amount)
                            }
                        }
                    } footer: {
                        VStack(alignment: .leading, spacing: 6) {
                            if let locked = preview.lockedText { Text(locked) }
                            if let suggestions = preview.suggestionText { Text(suggestions) }
                        }
                    }
                    if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
                    if !preview.rows.isEmpty {
                        Section {
                            Button { Task { await run() } } label: {
                                HStack {
                                    Spacer()
                                    if busy { ProgressView() } else { Text("Kohdista") }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.primary)
                            .disabled(busy)
                            .listRowBackground(Color.clear)
                        }
                    }
                } else {
                    LoadState(state: state, retry: load) { (_: BankMatchPreview) in EmptyView() }
                        .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Kohdista pankkimaksut")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button((state.value?.rows.isEmpty ?? true) ? "Sulje" : "Peruuta") { dismiss() }
                }
            }
            .task { await load() }
            .interactiveDismissDisabled(busy)
        }
    }

    private func load() async {
        state = .loading
        do { state = .loaded(try await app.api.get("/api/invoices/match")) }
        catch is CancellationError {}
        catch { state = .failed(error.userMessage) }
    }

    private func run() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let result: BankMatchResult = try await app.api.send("POST", "/api/invoices/match", body: EmptyBody())
            Haptics.success()
            onDone(result.message)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

struct InvoiceRow: View {
    let invoice: Invoice
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(invoice.customer.name).font(.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text(secondary).font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                MoneyText(amount: invoice.gross).font(.subheadline.weight(.semibold))
                StatusBadge(status: invoice.displayStatus)
            }
        }
        .padding(.vertical, 2)
    }

    private var secondary: String {
        if invoice.isCreditNote { return "Hyvityslasku \(invoice.number)" }
        if invoice.displayStatus == .draft { return "Lasku \(invoice.number)" }
        return "Lasku \(invoice.number) · \(invoice.displayStatus == .overdue ? "myöhässä, eräpäivä" : "eräpäivä") \(APIDate.displayDay(invoice.dueDate))"
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
