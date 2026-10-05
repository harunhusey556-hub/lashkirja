import SwiftUI
import LashKirjaCore

struct MyyntiView: View {
    @Environment(AppModel.self) private var app
    /// Opens the new-invoice form once on appear (the assistant's "/laskut/uusi" link).
    var openNewInvoice = false
    /// A report link's period or customer (`/laskut?month=…`); empty for the Myynti tab itself.
    var scope = InvoiceScope()
    @State private var state: Loadable<InvoiceList> = .idle
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var counts: [String: Int]?
    @State private var filter: SalesFilter
    @State private var search = ""
    /// The search as sent to the server: settles 250 ms after the last keystroke (as on the web).
    @State private var query = ""
    /// A days-late figure narrows the late invoices to its bucket (on top of the Myöhässä chip).
    @State private var lateBucket: AgingBucket?
    @State private var showNew = false
    @State private var showMatch = false
    @State private var notice: String?
    @State private var openedNew = false
    /// A just-created invoice, opened when the form's sheet has closed.
    @State private var createdId: String?
    @State private var openedInvoiceId: String?
    @State private var shortcut: Shortcut?
    @State private var limit = ShowMore()

    /// Asiakkaat and Toistuvat laskut, one compact line under the summary.
    enum Shortcut: Hashable { case customers, recurring }

    /// A link opens exactly the list it names: its status chip, or Kaikki when it names none.
    init(openNewInvoice: Bool = false, scope: InvoiceScope = InvoiceScope(), status: SalesFilter = .all) {
        self.openNewInvoice = openNewInvoice
        self.scope = scope
        _filter = State(initialValue: status)
    }

    var body: some View {
        List {
            if let list = state.value {
                Section {
                    ReceivablesCard(aging: list.aging, filter: filter, lateBucket: lateBucket) { segment in
                        filter = filter == segment ? .all : segment
                        lateBucket = nil
                        Haptics.selection()
                    } onBucket: { bucket in
                        lateBucket = lateBucket == bucket ? nil : bucket
                        if lateBucket != nil { filter = .overdue }
                        Haptics.selection()
                    }
                    .listRowBackground(Theme.surface)
                }
                if let notice {
                    Section {
                        Text(notice).font(.subheadline).foregroundStyle(Theme.ink)
                    }
                }
                Section {
                    // A drilled list is about its rows; the registers stay on the Myynti tab.
                    if let title = scope.title {
                        Label(title, systemImage: "line.3.horizontal.decrease.circle")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 0))
                            .listRowSeparator(.hidden)
                    } else {
                        shortcuts
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                    }
                    chips
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))
                        .listRowSeparator(.hidden)
                }
                let rows = visible(list.invoices)
                Section {
                    if rows.isEmpty {
                        Text(search.isEmpty ? "Ei laskuja tässä näkymässä." : "Ei osumia.")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(rows.prefix(limit.visible(rows.count))) { invoice in
                        NavigationLink(value: Route.invoice(invoice.id)) { InvoiceRow(invoice: invoice) }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                } header: {
                    HStack {
                        if !rows.isEmpty { Text("\(rows.count) laskua") }
                        Spacer()
                        if let lateBucket {
                            Button { self.lateBucket = nil } label: {
                                Label("\(lateBucket.label) myöhässä", systemImage: "xmark.circle.fill")
                            }
                            .buttonStyle(.borderless)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.danger)
                            .accessibilityHint("Näytä kaikki myöhässä olevat")
                        }
                    }
                } footer: {
                    if let note = SalesListQuery.limitNote(rowCount: list.invoices.count) { Text(note) }
                }
                if scope.isEmpty {
                    Section("Muut") {
                        Button { showMatch = true } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Label("Hae asiakkaiden maksut pankista", systemImage: "building.columns")
                                Text("Kirjaa maksut viitenumeron mukaan").font(.caption).foregroundStyle(Theme.ink2)
                            }
                        }
                        .foregroundStyle(Theme.ink)
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
        .navigationTitle(scope.isEmpty ? "Myynti" : "Laskut")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Label("Uusi lasku", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $showNew, onDismiss: openCreated) {
            InvoiceFormView(existing: nil, onCreated: { id in createdId = id })
        }
        .sheet(isPresented: $showMatch) {
            BankMatchSheet { message in notice = message }
        }
        .navigationDestination(item: $openedInvoiceId) { id in InvoiceDetailView(invoiceId: id) }
        .navigationDestination(item: $shortcut) { target in
            switch target {
            case .customers: CustomersView()
            case .recurring: RecurringInvoicesView()
            }
        }
        .onAppear {
            guard openNewInvoice, !openedNew else { return }
            openedNew = true
            showNew = true
        }
        .task(id: "\(app.dataVersion)|\(listKey)") {
            guard state.value == nil || gate.isDue(key: listKey, version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion, key = listKey
            await load()
            if !Task.isCancelled { gate.mark(key: key, version: version) }
        }
        .task(id: search) {
            let text = search.trimmingCharacters(in: .whitespaces)
            // Cleared at once; typed text waits for a pause, one request per pause.
            if !text.isEmpty { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard !Task.isCancelled else { return }
            query = text
        }
        .animation(.snappy, value: filter)
        .animation(.snappy, value: lateBucket)
        // Another chip or search shows a different list: it opens on its first rows again.
        .onChange(of: filter) { _, new in
            limit.reset()
            if new != .overdue { lateBucket = nil }
        }
        .onChange(of: search) { _, _ in limit.reset() }
        .onChange(of: lateBucket) { _, _ in limit.reset() }
    }

    private func openCreated() {
        guard let id = createdId else { return }
        createdId = nil
        openedInvoiceId = id
    }

    /// Two tiles as wide as the cards around them, so they read as places to go, not filters.
    private var shortcuts: some View {
        HStack(spacing: 10) {
            shortcutTile("Asiakkaat", symbol: "person.2", target: .customers)
            shortcutTile("Toistuvat laskut", symbol: "repeat", target: .recurring)
        }
    }

    private func shortcutTile(_ title: String, symbol: String, target: Shortcut) -> some View {
        Button { shortcut = target } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 24)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(.pressable)
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
                    .buttonStyle(.pressable)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.vertical, 4)
        }
        // A chip whose status vanished (credited after a refresh) falls back to "Kaikki".
        .onChange(of: counts) { _, _ in
            if !SalesFilter.chips(counts).contains(where: { $0.filter == filter }) { filter = .all }
        }
    }

    /// What the list asks the server for besides the scope: the chip and the settled search.
    private var listKey: String { "\(filter.rawValue)|\(query)" }

    /// The server already filtered by status and search; the chip's own rule still applies while a
    /// new chip's rows are on their way (and keeps "Odottaa maksua" free of late ones, as on the web).
    private func visible(_ invoices: [Invoice]) -> [Invoice] {
        let today = APIDate.dayString(Date())
        return invoices.filter { invoice in
            !app.removedIds.contains(invoice.id) && filter.matches(invoice)
                && (lateBucket == nil || AgingBucket.of(dueDate: invoice.dueDate, today: today) == lateBucket)
        }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        // The list and the chip counts are independent: one round trip instead of two.
        async let fresh = loadCounts()
        do { state = .loaded(try await app.api.get("/api/invoices", query: SalesListQuery.query(scope: scope, filter: filter, search: query))) }
        catch is CancellationError {}
        catch { if state.value == nil { state = .failed(error.userMessage) } }
        if let fresh = await fresh { counts = fresh }
    }

    /// Per-status counts for the chips; counted by the server, so the list's row cap cannot skew them.
    private func loadCounts() async -> [String: Int]? {
        do {
            // Scoped like the list (period, customer), never by status.
            let response: InvoiceCounts = try await app.api.get("/api/invoices/counts", query: scope.query)
            return response.counts
        } catch {
            return nil
        }
    }
}

/// "Saatavat, avoinna": the paid / waiting / late bar (web `receivablesSegments`), each part opening
/// its chip, and under "Erittely" the late money by days late, each figure narrowing the late list.
private struct ReceivablesCard: View {
    let aging: InvoiceList.Aging
    let filter: SalesFilter
    let lateBucket: AgingBucket?
    let onSegment: (SalesFilter) -> Void
    let onBucket: (AgingBucket) -> Void
    @State private var open = false

    var body: some View {
        let segments = aging.segments
        let buckets = aging.lateBuckets
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saatavat, avoinna").font(.caption).foregroundStyle(Theme.ink2)
                    MoneyText(amount: aging.totalOpen).font(.title2.weight(.semibold))
                }
                Spacer()
                if !buckets.isEmpty {
                    Button { withAnimation(.snappy) { open.toggle() } } label: {
                        HStack(spacing: 4) {
                            Text("Erittely")
                            Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 180 : 0))
                        }
                        .font(.caption)
                        .foregroundStyle(Theme.ink2)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(open ? "Piilota erittely" : "Näytä erittely päivien mukaan")
                }
            }
            bar(segments)
            legend(segments)
            if open && !buckets.isEmpty {
                Divider()
                HStack(spacing: 0) {
                    ForEach(buckets) { bucket in bucketButton(bucket) }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func color(_ tone: ReceivablesSegment.Tone) -> Color {
        switch tone {
        case .success: Theme.success
        case .neutral: Theme.ink2.opacity(0.45)
        case .danger: Theme.danger
        }
    }

    /// A segment other than the chosen chip fades, so the bar shows what the list below is.
    private func dimmed(_ segment: ReceivablesSegment) -> Bool {
        filter != .all && filter != segment.filter
    }

    @ViewBuilder
    private func bar(_ segments: [ReceivablesSegment]) -> some View {
        let total = segments.reduce(Decimal(0)) { $0 + max(0, $1.amount) }
        if total <= 0 {
            Text("Ei avoimia laskuja.").font(.caption).foregroundStyle(Theme.ink2)
        } else {
            GeometryReader { geo in
                let shown = segments.filter { $0.amount > 0 }
                let gaps = CGFloat(max(0, shown.count - 1)) * 2
                HStack(spacing: 2) {
                    ForEach(shown) { segment in
                        let share = CGFloat(NSDecimalNumber(decimal: segment.amount / total).doubleValue)
                        Button { onSegment(segment.filter) } label: {
                            Rectangle().fill(color(segment.tone)).opacity(dimmed(segment) ? 0.3 : 1)
                        }
                        .buttonStyle(.pressable)
                        .frame(width: max(4, (geo.size.width - gaps) * share))
                        .accessibilityLabel("\(segment.label) \(Money.format(segment.amount))")
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 10)
        }
    }

    private func legend(_ segments: [ReceivablesSegment]) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(segments) { segment in
                Button { onSegment(segment.filter) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Circle().fill(color(segment.tone)).frame(width: 7, height: 7)
                            Text(segment.label).lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .font(.caption2)
                        .foregroundStyle(Theme.ink2)
                        MoneyText(amount: segment.amount)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(segment.tone == .danger && segment.amount > 0 ? Theme.danger : Theme.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(dimmed(segment) ? 0.5 : 1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityAddTraits(filter == segment.filter ? .isSelected : [])
                .accessibilityHint(filter == segment.filter ? "Näytä kaikki laskut" : "Näytä nämä laskut")
            }
        }
    }

    private func bucketButton(_ bucket: ReceivablesLateBucket) -> some View {
        let selected = lateBucket == bucket.bucket
        return Button { onBucket(bucket.bucket) } label: {
            VStack(spacing: 2) {
                Text(bucket.label).font(.caption2).foregroundStyle(selected ? Theme.danger : Theme.ink2)
                MoneyText(amount: bucket.amount).font(.caption.weight(.medium)).foregroundStyle(Theme.ink)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(selected ? Theme.danger.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(bucket.count == 0 && !selected)
        .accessibilityLabel("\(bucket.label) myöhässä, \(bucket.count) laskua, \(Money.format(bucket.amount))")
        .accessibilityAddTraits(selected ? .isSelected : [])
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
    @State private var limit = ShowMore()

    var body: some View {
        NavigationStack {
            List {
                if let preview = state.value {
                    Section {
                        Text(preview.headline)
                        ForEach(preview.rows.prefix(limit.visible(preview.rows.count))) { row in
                            HStack {
                                Text("Lasku \(row.invoiceNumber), \(row.customerName)").lineLimit(2)
                                Spacer()
                                MoneyText(amount: row.amount)
                            }
                        }
                        ShowMoreButton(limit: $limit, total: preview.rows.count)
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
                                    if busy { ProgressView() } else { Text("Kirjaa maksut") }
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
            .navigationTitle("Maksut pankista")
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
