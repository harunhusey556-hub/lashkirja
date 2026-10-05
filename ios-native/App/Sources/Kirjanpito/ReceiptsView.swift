import SwiftUI
import LashKirjaCore

/// Kuitit: the approved receipts with search, tabs, month/category filters,
/// sorting and paging (the server sends at most 200 rows at a time), the
/// review queue on top, and multi-select delete.
struct ReceiptsView: View {
    @Environment(AppModel.self) private var app
    @State private var receipts = ScreenLoad<[Receipt]>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var total = 0
    @State private var truncated = false
    @State private var loadingMore = false
    @State private var counts: ReceiptCounts.Counts?
    @State private var pending: [Receipt] = []
    @State private var pendingTruncated = false
    @State private var loadingMorePending = false
    /// Rejected receipts stay reachable and restorable (F38).
    @State private var rejected: [Receipt] = []
    @State private var rejectedTotal = 0
    @State private var rejectedTruncated = false
    @State private var loadingMoreRejected = false
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
    @State private var limit = ShowMore()

    /// Month, tab, category, source and sort are kept between visits (as the purchase invoices' filter).
    private static let filterKey = "kuitit.filter"

    /// Opened from a figure (a report, ALV, Koti) the list shows exactly those rows and leaves the
    /// owner's remembered Kuitit filters alone; opened plainly, it restores and keeps them.
    private let remembers: Bool

    /// With a month or a tab the screen opens on exactly that; otherwise on the filters of the last visit.
    init(month: String = "", tab: ReceiptTab = .all, category: String = "", missingVat: Bool = false, drilled: Bool = false) {
        var initial: ReceiptListQuery
        remembers = !drilled
        if drilled || !month.isEmpty || tab != .all || !category.isEmpty {
            initial = ReceiptListQuery()
            initial.month = month
            initial.tab = tab
            initial.category = category
            initial.missingVat = missingVat
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
            QueuedReceiptsCard()
            if !selecting {
                ReviewQueueSection(
                    pending: pending.filter { !app.removedIds.contains($0.id) },
                    rejected: rejected.filter { !app.removedIds.contains($0.id) },
                    rejectedTotal: rejectedTotal,
                    pendingHasMore: pendingTruncated,
                    rejectedHasMore: rejectedTruncated,
                    loadingPending: loadingMorePending,
                    loadingRejected: loadingMoreRejected,
                    busy: busy,
                    approve: { ids in await review(ids) },
                    restore: { id in await restore(id) },
                    loadMorePending: { await loadMorePending() },
                    loadMoreRejected: {
                        await loadMoreRejected()
                        return rejected.count
                    }
                )
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
            if let notice { Text(notice).foregroundStyle(Theme.ink2) }
            Section {
                tabChips
                if query.isFiltered && (!query.month.isEmpty || !query.category.isEmpty || query.source != .all || query.amountLabel != nil || query.missingVat) {
                    activeFilters
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

            if receipts.value != nil {
                if let banner = receipts.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                let all = shownReceipts
                Section {
                    if all.isEmpty {
                        Text(query.isFiltered ? "Ei hakua vastaavia kuitteja." : "Ei kuitteja.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(all.prefix(limit.visible(all.count))) { receipt in row(receipt) }
                    // Ten at a time; the next server page is asked for only by the button, never on scroll.
                    PagedShowMoreButton(limit: $limit, loaded: all.count, total: total, serverHasMore: truncated, loading: loadingMore) {
                        await loadMore()
                        return shownReceipts.count
                    }
                } header: {
                    if !all.isEmpty { Text("\(total) kuittia") }
                }
            } else {
                ScreenStateView(state: receipts, retry: load) { (_: [Receipt]) in EmptyView() }.listRowBackground(Color.clear)
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
            TextField("Vähintään €", text: $minDraft).moneyInput()
            TextField("Enintään €", text: $maxDraft).moneyInput()
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
            if remembers { UserDefaults.standard.set(next.remembered, forKey: Self.filterKey) }
            limit.reset()
        }
        .animation(.snappy, value: pending.map(\.id))
        .animation(.snappy, value: rejected.map(\.id))
        // Photos kept while offline are sent from here too, not only from the capture screen.
        .task { OfflineReceiptQueueModel.shared.start(app: app) }
    }

    // MARK: Pieces

    /// The loaded rows minus the ones deleted a moment ago (`app.removedIds`).
    private var shownReceipts: [Receipt] { (receipts.value ?? []).filter { !app.removedIds.contains($0.id) } }

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
                    .buttonStyle(.pressable)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var activeFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if query.missingVat {
                    filterChip("Ilman ALV-erittelyä") { query.missingVat = false }
                }
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
        .buttonStyle(.pressable)
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
        receipts.begin()
        let api = app.api
        // A slow answer for filters the owner already changed must not replace the newer list.
        let asked = query
        let listQuery = asked.listQuery()
        let countsQuery = asked.countsQuery()
        async let countsResponse: ReceiptCounts? = try? api.get("/api/receipts/counts", query: countsQuery)
        async let queue: ReceiptList? = try? api.get("/api/receipts", query: ["reviewStatus": "pending"])
        async let rejectedResponse: ReceiptList? = try? api.get("/api/receipts", query: ["reviewStatus": "rejected"])
        do {
            let list: ReceiptList = try await api.get("/api/receipts", query: listQuery)
            guard asked == query else {
                if let q = await queue { applyPending(q) }
                if let r = await rejectedResponse { applyRejected(r) }
                return
            }
            receipts.succeed(list.receipts)
            total = list.count ?? list.receipts.count
            truncated = list.truncated ?? false
            failure = nil
            // Rows that left the list (deleted elsewhere, filtered out) are no longer selected.
            selected.formIntersection(list.receipts.map(\.id))
        } catch is CancellationError {
            return
        } catch {
            guard asked == query else { return }
            receipts.fail(error)
        }
        if let c = await countsResponse, asked == query { counts = c.counts }
        if let q = await queue { applyPending(q) }
        if let r = await rejectedResponse { applyRejected(r) }
    }

    private func applyPending(_ list: ReceiptList) {
        pending = list.receipts
        pendingTruncated = list.truncated ?? false
    }

    private func applyRejected(_ list: ReceiptList) {
        rejected = list.receipts
        rejectedTotal = list.count ?? list.receipts.count
        rejectedTruncated = list.truncated ?? false
    }

    /// "Lataa lisää tarkastettavia": the next 200 of the review queue.
    private func loadMorePending() async {
        guard pendingTruncated, !loadingMorePending else { return }
        loadingMorePending = true
        defer { loadingMorePending = false }
        do {
            let page: ReceiptList = try await app.api.get("/api/receipts", query: ["reviewStatus": "pending", "offset": String(pending.count)])
            pending = ReceiptPaging.append(pending, page.receipts)
            pendingTruncated = page.truncated ?? false
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }

    private func loadMoreRejected() async {
        guard rejectedTruncated, !loadingMoreRejected else { return }
        loadingMoreRejected = true
        defer { loadingMoreRejected = false }
        do {
            let page: ReceiptList = try await app.api.get("/api/receipts", query: ["reviewStatus": "rejected", "offset": String(rejected.count)])
            rejected = ReceiptPaging.append(rejected, page.receipts)
            rejectedTotal = page.count ?? rejectedTotal
            rejectedTruncated = page.truncated ?? false
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
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
            receipts.update { $0 = ReceiptPaging.append(loaded, page.receipts) }
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
            let refusals = (result.failed ?? []).map { $0.error ?? "" }
            // The refusal is named (F15): what went and why the rest did not.
            let outcome = ReviewQueue.approvalOutcome(approved: result.approvedCount, failures: refusals)
            if !refusals.isEmpty {
                failure = outcome
                Haptics.error()
                await load()
                return
            }
            if ids.count > 1 { notice = outcome }
            Haptics.success()
            withAnimation { pending.removeAll { ids.contains($0.id) } }
            await load()
        } catch {
            failure = error.userMessage
        }
    }

    /// "Palauta": a rejected receipt goes back to the review queue (`PATCH …/review`).
    private func restore(_ id: String) async {
        guard !busy, let index = rejected.firstIndex(where: { $0.id == id }) else { return }
        busy = true
        failure = nil
        notice = nil
        defer { busy = false }
        let row = rejected[index]
        withAnimation {
            rejected.remove(at: index)
            rejectedTotal = max(0, rejectedTotal - 1)
        }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/receipts/\(id)/review", body: ReviewStatusBody.restore)
            Haptics.success()
            notice = "Kuitti palautettiin tarkastettavaksi"
            await load()
        } catch is CancellationError {
        } catch {
            withAnimation {
                rejected.insert(row, at: min(index, rejected.count))
                rejectedTotal += 1
            }
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func delete(_ ids: [String]) async {
        struct Body: Encodable { let receiptIds: [String] }
        guard !ids.isEmpty else { return }
        busy = true
        failure = nil
        notice = nil
        defer { busy = false }
        // Gone from the list at once; the ones the server refuses come back.
        withAnimation { app.hide(ids) }
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
                receipts.update { rows in rows.removeAll { deleted.contains($0.id) } }
                total = max(0, total - deleted.count)
            }
            app.dataVersion += 1
        }
        withAnimation { app.unhide(refused) }
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

/// The "Näytä enemmän" row of a list the server pages (`PagedShowMore`): reveals ten loaded rows,
/// and asks for the next page only once every loaded row is on screen. `fetch` returns the new row count.
struct PagedShowMoreButton: View {
    @Binding var limit: ShowMore
    let loaded: Int
    let total: Int
    let serverHasMore: Bool
    let loading: Bool
    let fetch: () async -> Int

    var body: some View {
        if let title = PagedShowMore.title(limit, loaded: loaded, total: total, serverHasMore: serverHasMore, loading: loading) {
            Button {
                Haptics.selection()
                switch PagedShowMore.step(limit, loaded: loaded, serverHasMore: serverHasMore) {
                case .fetch:
                    let before = loaded
                    Task {
                        let after = await fetch()
                        withAnimation(.snappy) { PagedShowMore.revealFetched(&limit, before: before, after: after) }
                    }
                case .reveal, .fold:
                    withAnimation(.snappy) { limit.more(total: loaded) }
                case nil:
                    break
                }
            } label: {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                    Spacer()
                    if loading {
                        ProgressView()
                    } else {
                        Image(systemName: limit.visible(loaded) >= loaded && !serverHasMore ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                    }
                }
                .foregroundStyle(Theme.accent)
            }
            .disabled(loading)
        }
    }
}
