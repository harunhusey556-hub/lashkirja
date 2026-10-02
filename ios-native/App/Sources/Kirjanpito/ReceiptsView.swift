import SwiftUI
import LashKirjaCore

/// Kuitit: the approved receipts with search, tabs, month/category filters,
/// sorting and paging (the server sends at most 200 rows at a time), the
/// review queue on top, and multi-select delete.
struct ReceiptsView: View {
    @Environment(AppModel.self) private var app
    @State private var receipts: Loadable<[Receipt]> = .idle
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var total = 0
    @State private var truncated = false
    @State private var loadingMore = false
    @State private var counts: ReceiptCounts.Counts?
    @State private var pending: [Receipt] = []
    @State private var query: ReceiptListQuery
    @State private var editingAmount = false
    @State private var minDraft = ""
    @State private var maxDraft = ""
    @State private var searchText = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var notice: String?
    @State private var capture = false
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var deleteIds: [String] = []
    @State private var confirmDelete = false

    /// Month, tab, category, source and sort are kept between visits (as the purchase invoices' filter).
    private static let filterKey = "kuitit.filter"

    /// With a month or a tab the screen opens on exactly that; otherwise on the filters of the last visit.
    init(month: String = "", tab: ReceiptTab = .all) {
        var initial: ReceiptListQuery
        if !month.isEmpty || tab != .all {
            initial = ReceiptListQuery()
            initial.month = month
            initial.tab = tab
        } else {
            initial = ReceiptListQuery(remembered: UserDefaults.standard.string(forKey: Self.filterKey) ?? "")
        }
        _query = State(initialValue: initial)
    }

    private struct ReloadKey: Hashable {
        let query: ReceiptListQuery
        let version: Int
    }

    var body: some View {
        List {
            if !pending.isEmpty && !selecting {
                Section {
                    ForEach(pending) { receipt in
                        NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt) }
                            .swipeActions(edge: .trailing) {
                                Button("Hyväksy") { Task { await review([receipt.id]) } }
                                    .tint(Theme.successFill)
                                    .disabled(busy)
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
            if let notice { Text(notice).foregroundStyle(Theme.ink2) }
            Section {
                tabChips
                if query.isFiltered && (!query.month.isEmpty || !query.category.isEmpty || query.source != .all || query.amountLabel != nil) {
                    activeFilters
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

            if let all = receipts.value {
                Section {
                    if all.isEmpty {
                        Text(query.isFiltered ? "Ei hakua vastaavia kuitteja." : "Ei kuitteja.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(all) { receipt in row(receipt) }
                    if truncated {
                        Button { Task { await loadMore() } } label: {
                            HStack {
                                Text(loadingMore ? String("Ladataan…") : String("Lataa lisää (\(all.count) / \(total))"))
                                Spacer()
                                if loadingMore { ProgressView() }
                            }
                        }
                        .disabled(loadingMore)
                        .onAppear { Task { await loadMore() } }
                    }
                } header: {
                    if !all.isEmpty { Text("\(total) kuittia") }
                }
            } else {
                LoadState(state: receipts, retry: load) { (_: [Receipt]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $searchText, prompt: "Hae kuitteja")
        .navigationTitle("Kuitit")
        .toolbar { toolbar }
        .safeAreaInset(edge: .bottom) {
            if selecting && !selected.isEmpty {
                HStack {
                    Text("\(selected.count) valittu").font(.subheadline).foregroundStyle(Theme.onInk)
                    Spacer()
                    Button(role: .destructive) {
                        deleteIds = Array(selected)
                        confirmDelete = true
                    } label: {
                        Label("Poista", systemImage: "trash").font(.subheadline.bold()).foregroundStyle(Theme.onInk)
                    }
                    .disabled(busy)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Theme.ink.opacity(0.94), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .confirmationDialog(deleteIds.count == 1 ? String("Poistetaanko kuitti?") : String("Poistetaanko \(deleteIds.count) kuittia?"),
                            isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await delete(deleteIds) } }
        }
        .fullScreenCover(isPresented: $capture, onDismiss: { Task { await load() } }) { CaptureFlow(transactionId: nil) }
        .alert("Summarajaus", isPresented: $editingAmount) {
            TextField("Vähintään €", text: $minDraft).keyboardType(.decimalPad)
            TextField("Enintään €", text: $maxDraft).keyboardType(.decimalPad)
            Button("Käytä") { applyAmount() }
            Button("Peru", role: .cancel) {}
        } message: {
            Text("Jätä kenttä tyhjäksi, jos rajaa ei tarvita.")
        }
        .refreshable { await load() }
        .task(id: ReloadKey(query: query, version: app.dataVersion)) {
            guard receipts.value == nil || gate.isDue(key: String(describing: query), version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: String(describing: query), version: version) }
        }
        .task(id: searchText) {
            // Typing settles before the list is asked again.
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled, searchText != query.search else { return }
            query.search = searchText
        }
        .onChange(of: query) { _, next in
            UserDefaults.standard.set(next.remembered, forKey: Self.filterKey)
        }
        .animation(.snappy, value: pending.map(\.id))
    }

    // MARK: Pieces

    @ViewBuilder private func row(_ receipt: Receipt) -> some View {
        if selecting {
            Button {
                if selected.contains(receipt.id) { selected.remove(receipt.id) } else { selected.insert(receipt.id) }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selected.contains(receipt.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected.contains(receipt.id) ? Theme.accent : Theme.ink2)
                        .imageScale(.large)
                    ReceiptRow(receipt: receipt)
                }
            }
            .foregroundStyle(Theme.ink)
        } else {
            NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt) }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        deleteIds = [receipt.id]
                        confirmDelete = true
                    } label: { Label("Poista", systemImage: "trash") }
                }
        }
    }

    private var tabChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ReceiptTab.allCases) { tab in
                    let active = query.tab == tab
                    Button {
                        query.tab = tab
                    } label: {
                        HStack(spacing: 4) {
                            Text(tab.title)
                            if let counts { Text("\(tab.count(in: counts))").foregroundStyle(active ? Theme.onInk : Theme.ink2) }
                        }
                        .font(.subheadline.weight(active ? .semibold : .regular))
                        .foregroundStyle(active ? Theme.onInk : Theme.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(active ? Theme.ink : Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.line, lineWidth: active ? 0 : 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var activeFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !query.month.isEmpty {
                    filterChip(MonthKey.title(query.month, currentYear: String(MonthKey.current().prefix(4)))) { query.month = "" }
                }
                if !query.category.isEmpty {
                    filterChip(ReceiptCategory.label(for: query.category)) { query.category = "" }
                }
                if query.source != .all {
                    filterChip(query.source.title) { query.source = .all }
                }
                if let amount = query.amountLabel {
                    filterChip(amount) {
                        query.minAmount = ""
                        query.maxAmount = ""
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func filterChip(_ title: String, clear: @escaping () -> Void) -> some View {
        Button(action: clear) {
            HStack(spacing: 4) {
                Text(title)
                Image(systemName: "xmark").font(.caption2.bold())
            }
            .font(.caption)
            .foregroundStyle(Theme.accentDark)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Theme.accentSoft, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Poista suodatin \(title)")
    }

    /// Checked before it reaches the list: the server would refuse the same range.
    private func applyAmount() {
        var next = query
        next.minAmount = minDraft
        next.maxAmount = maxDraft
        if let problem = next.amountError {
            failure = problem
            Haptics.error()
            return
        }
        failure = nil
        query = next
    }

    /// The last 24 months, newest first.
    private var monthChoices: [String] {
        let now = MonthKey.current()
        return (0..<24).map { MonthKey.shift(now, by: -$0) }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if selecting {
                Button("Valmis") {
                    selecting = false
                    selected = []
                }
            } else {
                Menu {
                    Picker("Kuukausi", selection: $query.month) {
                        Text("Kaikki kuukaudet").tag("")
                        ForEach(monthChoices, id: \.self) { key in
                            Text(MonthKey.title(key, currentYear: String(MonthKey.current().prefix(4)))).tag(key)
                        }
                    }
                    .pickerStyle(.menu)
                    Picker("Kategoria", selection: $query.category) {
                        Text("Kaikki kategoriat").tag("")
                        ForEach(ReceiptCategory.all) { category in Text(category.label).tag(category.id) }
                    }
                    .pickerStyle(.menu)
                    Picker("Lähde", selection: $query.source) {
                        ForEach(ReceiptSourceFilter.allCases) { source in Text(source.title).tag(source) }
                    }
                    .pickerStyle(.menu)
                    Button {
                        minDraft = query.minAmount
                        maxDraft = query.maxAmount
                        editingAmount = true
                    } label: {
                        Label(query.amountLabel.map { "Summa: \($0)" } ?? "Summa…", systemImage: "eurosign")
                    }
                    Picker("Järjestys", selection: $query.sort) {
                        ForEach(ReceiptSort.allCases) { sort in Text(sort.title).tag(sort) }
                    }
                    .pickerStyle(.menu)
                    if !query.month.isEmpty || !query.category.isEmpty || query.source != .all || query.amountLabel != nil || query.sort != .dateDesc {
                        Button("Tyhjennä suodattimet") {
                            query.month = ""
                            query.category = ""
                            query.source = .all
                            query.minAmount = ""
                            query.maxAmount = ""
                            query.sort = .dateDesc
                        }
                    }
                } label: {
                    Image(systemName: query.month.isEmpty && query.category.isEmpty && query.source == .all && query.amountLabel == nil
                          ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel("Suodata kuitteja")
                if receipts.value?.isEmpty == false {
                    Button("Valitse") { selecting = true }
                }
                Button { capture = true } label: { Image(systemName: "camera") }.accessibilityLabel("Kuvaa kuitti")
            }
        }
    }

    // MARK: Loading

    private func load() async {
        if receipts.value == nil { receipts = .loading }
        let api = app.api
        // A slow answer for filters the owner already changed must not replace the newer list.
        let asked = query
        let listQuery = asked.listQuery()
        let countsQuery = asked.countsQuery()
        async let countsResponse: ReceiptCounts? = try? api.get("/api/receipts/counts", query: countsQuery)
        async let queue: ReceiptList? = try? api.get("/api/receipts", query: ["reviewStatus": "pending"])
        do {
            let list: ReceiptList = try await api.get("/api/receipts", query: listQuery)
            guard asked == query else {
                if let q = await queue { pending = q.receipts }
                return
            }
            receipts = .loaded(list.receipts)
            total = list.count ?? list.receipts.count
            truncated = list.truncated ?? false
            failure = nil
            // Rows that left the list (deleted elsewhere, filtered out) are no longer selected.
            selected.formIntersection(list.receipts.map(\.id))
        } catch is CancellationError {
            return
        } catch {
            guard asked == query else { return }
            if receipts.value == nil { receipts = .failed(error.userMessage) } else { failure = error.userMessage }
        }
        if let c = await countsResponse, asked == query { counts = c.counts }
        if let q = await queue { pending = q.receipts }
    }

    private func loadMore() async {
        guard truncated, !loadingMore, let loaded = receipts.value else { return }
        loadingMore = true
        defer { loadingMore = false }
        let asked = query
        do {
            let page: ReceiptList = try await app.api.get("/api/receipts", query: asked.listQuery(offset: loaded.count))
            // The filters changed while this page was on its way: the fresh load wins.
            guard asked == query else { return }
            receipts = .loaded(ReceiptPaging.append(loaded, page.receipts))
            total = page.count ?? total
            truncated = page.truncated ?? false
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }

    // MARK: Actions

    private func review(_ ids: [String]) async {
        struct Body: Encodable { let receiptIds: [String] }
        guard !busy else { return }
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

    private func delete(_ ids: [String]) async {
        struct Body: Encodable { let receiptIds: [String] }
        guard !ids.isEmpty else { return }
        busy = true
        failure = nil
        notice = nil
        defer { busy = false }
        var deleted: [String] = []
        var refused: [String] = []
        var messages: [String] = []
        // The server takes at most 50 ids per call.
        var start = 0
        while start < ids.count {
            let chunk = Array(ids[start..<min(start + 50, ids.count)])
            start += 50
            do {
                let result: BatchDeleteResult = try await app.api.send("POST", "/api/receipts/batch-delete", body: Body(receiptIds: chunk))
                deleted += result.succeeded ?? []
                refused += result.failedIds
                if let reason = result.failed?.first?.error { messages.append(reason) }
            } catch {
                refused += chunk
                messages.append(error.userMessage)
            }
        }
        if !deleted.isEmpty {
            withAnimation {
                if let rows = receipts.value { receipts = .loaded(rows.filter { !deleted.contains($0.id) }) }
                total = max(0, total - deleted.count)
            }
            app.dataVersion += 1
        }
        selected = Set(refused)
        if selecting && refused.isEmpty { selecting = false }
        if refused.isEmpty {
            Haptics.success()
            notice = deleted.count == 1 ? "Poistettiin 1 kuitti." : "Poistettiin \(deleted.count) kuittia."
        } else {
            Haptics.error()
            failure = "Poistettiin \(deleted.count). \(refused.count) epäonnistui" + (messages.first.map { ": \($0)" } ?? ".")
        }
    }
}

struct ReceiptRow: View {
    let receipt: Receipt
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.title).lineLimit(1)
                HStack(spacing: 4) {
                    Text([receipt.date.map(APIDate.displayDay), receipt.category.map(ReceiptCategory.label(for:))].compactMap { $0 }.joined(separator: " · "))
                    if receipt.linkedTransaction != nil {
                        Image(systemName: "link").accessibilityLabel("Kohdistettu")
                    }
                }
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
