import SwiftUI
import LashKirjaCore

/// Kuitit: the approved receipts with search, tabs, month/category filters,
/// sorting and paging (50 rows a page by cursor from a server that pages, else 200 by offset),
/// the review queue on top, and multi-select delete. Every answer goes through the app's cache:
/// coming back paints the last list at once and asks again only when it is stale.
struct ReceiptsView: View {
    @Environment(AppModel.self) private var app
    @State private var receipts = ScreenLoad<[Receipt]>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var total = 0
    @State private var paging = ReceiptListPaging()
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
    /// "Ei kohdistettu": the sure pairs "Kohdista varmat (N)" links in one tap (owner 2026-10-15).
    @State private var sure: SureMatchList?
    @State private var sureBusy = false
    /// One key per batch: a retry after a lost answer is the same batch, not a second one.
    @State private var sureKey = UUID().uuidString
    @State private var toast: Toast?
    @State private var toastAction: (() async -> Void)?
    @State private var toastTask: Task<Void, Never>?
    /// False while a pushed screen or a cover hides Kuitit.
    @State private var onScreen = false

    private var visibility: HiddenListMotion { HiddenListMotion(onScreen: onScreen) }
    private var listMotion: Animation? { visibility.animation(.snappy) }

    /// Month, tab, category, source and sort are kept between visits (as the purchase invoices' filter).
    /// Also read by the launch prefetch, so it asks for the list this screen opens on.
    static let filterKey = "kuitit.filter"

    /// The receipts about to be deleted; deleting starts from the main list only.
    private var deleting: [Receipt] {
        (receipts.value ?? []).filter { deleteIds.contains($0.id) }
    }

    /// The dialog names the receipt so the owner sees which one goes.
    private var deleteTitle: String {
        if deleteIds.count == 1, let receipt = deleting.first {
            return "Poistetaanko kuitti · \(receipt.title)?"
        }
        return deleteIds.count == 1 ? "Poistetaanko kuitti?" : "Poistetaanko \(deleteIds.count) kuittia?"
    }

    private var deleteNote: String {
        let named = deleting
        guard !named.isEmpty else { return "" }
        // One receipt: the title already names the vendor, so the line under it adds the amount and day.
        if deleteIds.count == 1, let receipt = named.first {
            let parts: [String?] = [receipt.totalAmount.map { Money.format($0) }, receipt.date.map { APIDate.displayDay($0) }]
            return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        let shown = named.prefix(3).map { receipt -> String in
            guard let amount = receipt.totalAmount else { return receipt.title }
            return "\(receipt.title) \(Money.format(amount))"
        }
        let more = deleteIds.count - shown.count
        return "Poistettavat: " + shown.joined(separator: ", ") + (more > 0 ? " ja \(more) muuta." : ".")
    }

    /// Opened from a figure (a report, ALV, Koti) the list shows exactly those rows and leaves the
    /// owner's remembered Kuitit filters alone; opened plainly, it restores and keeps them.
    private let remembers: Bool

    /// With a month or a tab the screen opens on exactly that; otherwise on the filters of the last visit.
    /// `preview` (the app's `receiptsPreview` for the same filters) is on screen in the first frame:
    /// painted from `load` instead, after the awaits on the cache, a drill from Raportit pushed grey
    /// rows and its rows replaced them ~0.7 s after the push had settled (motion audit raportit-drill-open).
    init(month: String = "", tab: ReceiptTab = .all, category: String = "", missingVat: Bool = false, drilled: Bool = false,
         preview: ReceiptsPreview? = nil) {
        var initial: ReceiptListQuery
        remembers = !drilled
        if drilled || !month.isEmpty || tab != .all || !category.isEmpty {
            // The query Raportit warms the cache with (ReportDrill.receiptQuery).
            initial = .drilled(month: month, tab: tab, category: category, missingVat: missingVat)
        } else {
            initial = ReceiptListQuery(remembered: UserDefaults.standard.string(forKey: Self.filterKey) ?? "")
        }
        _query = State(initialValue: initial)
        guard let preview else { return }
        var shown = ScreenLoad<[Receipt]>()
        shown.succeed(preview.list.receipts)
        _receipts = State(initialValue: shown)
        var firstPage = ReceiptListPaging()
        firstPage.firstPage(preview.list)
        _paging = State(initialValue: firstPage)
        _counts = State(initialValue: preview.counts?.counts)
        _total = State(initialValue: ReceiptListPaging.total(preview.list, tab: initial.tab, counts: preview.counts?.counts))
        _pending = State(initialValue: preview.pending.receipts)
        _pendingTruncated = State(initialValue: preview.pending.truncated ?? false)
        _rejected = State(initialValue: preview.rejected.receipts)
        _rejectedTotal = State(initialValue: preview.rejected.count ?? preview.rejected.receipts.count)
        _rejectedTruncated = State(initialValue: preview.rejected.truncated ?? false)
    }

    private struct ReloadKey: Hashable {
        let query: ReceiptListQuery
        let version: Int
    }

    private struct SureKey: Hashable {
        let tab: ReceiptTab
        let version: Int
    }

    var body: some View {
        List {
            QueuedReceiptsCard()
            // Kept in place while picking, dimmed and inert: taken away, it pulled the chips and
            // every row up by its height (X040, owner 2026-10-18).
            ReviewQueueSection(
                pending: pending.filter { !app.removedIds.contains($0.id) },
                rejected: rejected.filter { !app.removedIds.contains($0.id) },
                rejectedTotal: rejectedTotal,
                pendingHasMore: pendingTruncated,
                rejectedHasMore: rejectedTruncated,
                loadingPending: loadingMorePending,
                loadingRejected: loadingMoreRejected,
                busy: busy,
                dimmed: selecting,
                approve: { ids in await review(ids) },
                restore: { id in await restore(id) },
                loadMorePending: { await loadMorePending() },
                loadMoreRejected: {
                    await loadMoreRejected()
                    return rejected.count
                }
            )
            Section {
                tabChips
                if query.isFiltered && (!query.month.isEmpty || !query.category.isEmpty || query.source != .all || query.amountLabel != nil || query.missingVat) {
                    activeFilters.transition(.opacity)
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .chipRowSection()

            if receipts.value != nil {
                if let banner = receipts.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: { await load() }) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                let all = shownReceipts
                Section {
                    if all.isEmpty {
                        Text(query.emptyText).foregroundStyle(Theme.ink2)
                    }
                    ForEach(all.prefix(limit.visible(all.count))) { receipt in row(receipt) }
                    // Ten at a time; the next server page is asked for only by the button, never on scroll.
                    PagedShowMoreButton(limit: $limit, loaded: all.count, total: shownTotal, serverHasMore: paging.hasMore, loading: loadingMore) {
                        await loadMore()
                        return shownReceipts.count
                    }
                } header: {
                    if !all.isEmpty { Text(query.countHeader(shownTotal)) }
                }
            } else if case .failed = receipts.display {
                ScreenStateView(state: receipts, retry: { await load() }) { (_: [Receipt]) in EmptyView() }.listRowBackground(Color.clear)
            } else {
                skeletonSection
            }
        }
        // Hidden under a receipt, the queue sections, the sure-matches count and the rows settle
        // without animation, also when the change was animated elsewhere (the receipt's own
        // delete): back on Kuitit the list is already as it ends up.
        .transaction { visibility.settle(&$0) }
        .environment(\.listMotion, visibility)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .failureToast($failure)
        .noticeToast($notice)
        .searchable(text: $searchText, prompt: "Hae kuitteja")
        .navigationTitle("Kuitit")
        .toolbar { toolbar }
        .bottomBar {
            // The web BulkBar's actions: Hyväksy (only the ready pending ones) and Poista. The
            // toolbar's Valmis ends the mode.
            let picked = selectedVisible
            if selecting && !picked.isEmpty {
                let approvable = ReceiptBulk.approvable(picked)
                BulkBar(count: picked.count, busy: busy) {
                    if !approvable.isEmpty {
                        BulkBarButton(title: ReceiptBulk.approveLabel(ready: approvable.count, notReady: picked.count - approvable.count)) {
                            Task { await approveSelected(approvable.map(\.id)) }
                        }
                    }
                    BulkBarButton(title: "Poista", destructive: true) {
                        deleteIds = picked.map(\.id)
                        confirmDelete = true
                    }
                }
            } else if !selecting, query.tab == .unlinked, let count = sure?.count, count > 0, toast == nil, !app.receiptDelete.isWaiting {
                // Under the list, not above it: the rows never move when the count arrives.
                sureBar(count)
            }
        }
        .overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast) { runToastAction() }.padding(.bottom, 8)
            }
        }
        .confirmSheet(isPresented: $confirmDelete, title: deleteTitle, message: deleteNote, confirmTitle: "Poista") {
            delete(deleteIds)
        }
        .fullScreenCover(isPresented: $capture, onDismiss: {
            Task {
                let version = app.dataVersion
                await load()
                if !Task.isCancelled { gate.mark(key: String(describing: query), version: version) }
            }
        }) {
            // "Näytä tarkistettavat": the review queue is on top before the cover goes (unanimated,
            // as hidden), not inserted above the rows once it has gone.
            CaptureFlow(transactionId: nil, onReviewQueue: { queue in
                var hidden = Transaction()
                hidden.disablesAnimations = true
                withTransaction(hidden) { applyPending(queue) }
            })
        }
        .alert("Summarajaus", isPresented: $editingAmount) {
            TextField("Vähintään €", text: $minDraft).moneyInput()
            TextField("Enintään €", text: $maxDraft).moneyInput()
            Button("Käytä") { applyAmount() }
            Button("Peruuta", role: .cancel) {}
        } message: {
            Text("Jätä kenttä tyhjäksi, jos rajaa ei tarvita.")
        }
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(key: String(describing: query), version: app.refreshEverything())
            await load(force: true)
        }
        .perfReady("kuitit", receipts.value != nil)
        .task(id: ReloadKey(query: query, version: app.dataVersion)) {
            guard receipts.value == nil || gate.isDue(key: String(describing: query), version: app.dataVersion) else { return }
            // Each save under the capture cover bumps the version: the list stays as it was behind
            // the cover and is asked once, when the cover has gone (the audit saw 103 layers move
            // 163 pt back here, and the owner came back to a moved list).
            guard !capture || receipts.value == nil else { return }
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
        .task(id: SureKey(tab: query.tab, version: app.dataVersion)) {
            // Only "Ei kohdistettu" offers it; a failed count just leaves the bar away.
            guard query.tab == .unlinked else { sure = nil; return }
            let list: SureMatchList? = try? await app.api.get("/api/matching/sure")
            guard !Task.isCancelled else { return }
            withMotion(listMotion) { sure = list }
        }
        .onAppear { onScreen = true }
        .onDisappear {
            onScreen = false
            toastTask?.cancel()
        }
        .motion(listMotion, value: pending.map(\.id))
        .motion(listMotion, value: rejected.map(\.id))
        // A changed list, a notice, a filter chip or the bulk bar eases in and out: the rows below
        // glide to their new place instead of jumping there. Only while Kuitit is on screen: an
        // answer landing under a pushed receipt just takes its place (animating there kept the
        // receipt's delete sheet from closing on Peruuta in CI).
        .motion(listMotion, value: visibleIds)
        .motion(listMotion, value: failure)
        .motion(listMotion, value: notice)
        .motion(listMotion, value: query)
        .motion(listMotion, value: selected.isEmpty)
        // Photos kept while offline are sent from here too, not only from the capture screen.
        .task { OfflineReceiptQueueModel.shared.start(app: app) }
    }

    // MARK: Pieces

    /// Grey rows where the receipts will be, until the first answer (cached or the server's) arrives.
    private var skeletonSection: some View {
        Section {
            ForEach(0..<6, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.surface).frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Kuitin myyjä").foregroundStyle(Theme.ink)
                        Text("12.10.2026 · Kategoria").font(.caption).foregroundStyle(Theme.ink2)
                    }
                    Spacer()
                    Text("-10,00 €").font(.subheadline.weight(.semibold))
                }
                .redacted(reason: .placeholder)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ladataan kuitteja")
            }
        }
    }

    /// The loaded rows minus the ones deleted a moment ago (`app.removedIds`).
    private var shownReceipts: [Receipt] { (receipts.value ?? []).filter { !app.removedIds.contains($0.id) } }

    /// The server's count less the loaded rows hidden by a delete: while "Kumoa" is up the server
    /// still counts them, and the header and "Näytä enemmän (N)" would be one too many.
    private var shownTotal: Int { max(0, total - ((receipts.value ?? []).count - shownReceipts.count)) }

    /// The ids of the rows on screen, in order: a new answer that changes them is animated.
    private var visibleIds: [String] {
        let all = shownReceipts
        return all.prefix(limit.visible(all.count)).map(\.id)
    }

    /// The picked rows that are on screen: a folded list never acts on hidden receipts (web BOOKS-12).
    private var selectedVisible: [Receipt] {
        let all = shownReceipts
        return all.prefix(limit.visible(all.count)).filter { selected.contains($0.id) }
    }

    @ViewBuilder private func row(_ receipt: Receipt) -> some View {
        if selecting {
            Button {
                if selected.contains(receipt.id) { selected.remove(receipt.id) } else { selected.insert(receipt.id) }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selected.contains(receipt.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected.contains(receipt.id) ? Theme.accent : Theme.ink2)
                        .imageScale(.large)
                        .accessibilityHidden(true)
                    ReceiptRow(receipt: receipt, thumbnail: true).equatable()
                }
            }
            .foregroundStyle(Theme.ink)
            .accessibilityAddTraits(selected.contains(receipt.id) ? .isSelected : [])
        } else {
            NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt, thumbnail: true).equatable() }
                // Not a destructive role: the list takes such a row off at the tap, before the
                // question is answered (F009). The fill is the one it had.
                .swipeActions(edge: .trailing) {
                    Button {
                        deleteIds = [receipt.id]
                        confirmDelete = true
                    } label: { Label("Poista", systemImage: "trash") }
                    .tint(Theme.accentFill)
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
                            // Laid out before the counts arrive, only faded in: the chips keep their place.
                            Text(counts.map { "\(tab.count(in: $0))" } ?? "0")
                                .foregroundStyle(active ? Theme.onInk : Theme.ink2)
                                .opacity(counts == nil ? 0 : 1)
                                .contentTransition(.numericText())
                                .accessibilityHidden(counts == nil)
                        }
                        .chipFont(selected: active)
                        .foregroundStyle(active ? Theme.onInk : Theme.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(active ? Theme.ink : Theme.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: active ? 0 : 1))
                    }
                    .buttonStyle(.pressable)
                    .accessibilityAddTraits(active ? .isSelected : [])
                    .accessibilityIdentifier("receipt-tab-\(tab.rawValue)")
                }
            }
            .padding(.horizontal, ChipRow.inset)
        }
        .accessibilityIdentifier("receipt-chips")
        .chipRowScroll()
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
            .padding(.horizontal, ChipRow.inset)
        }
        .chipRowScroll()
    }

    private func filterChip(_ title: String, clear: @escaping () -> Void) -> some View {
        Button(action: clear) {
            HStack(spacing: 4) {
                Text(title)
                Image(systemName: "xmark").font(.caption2.bold()).accessibilityHidden(true)
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

    private var filtered: Bool {
        !(query.month.isEmpty && query.category.isEmpty && query.source == .all && query.amountLabel == nil)
    }

    // MARK: Kohdista varmat

    private func sureBar(_ count: Int) -> some View {
        Button { Task { await linkSure() } } label: {
            // The spinner fades into a fixed slot mirrored on the other side, so the title stays
            // centred and still when the linking starts.
            HStack(spacing: 8) {
                ZStack {
                    if sureBusy { ProgressView().tint(Theme.onInk).transition(.opacity) }
                }
                .frame(width: 20, height: 20)
                Text(SureMatchText.buttonTitle(count)).font(.headline)
                Color.clear.frame(width: 20, height: 20)
            }
            .motion(.easeOut(duration: 0.15), value: sureBusy)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.primary)
        .disabled(sureBusy)
        .accessibilityHint(SureMatchText.explanation)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .bottomBarBacking()
        .transition(.opacity)
    }

    private func linkSure() async {
        guard !sureBusy else { return }
        sureBusy = true
        failure = nil
        defer { sureBusy = false }
        do {
            let batch: SureMatchBatch = try await app.api.send("POST", "/api/matching/sure", body: EmptyBody(), idempotencyKey: sureKey)
            sureKey = UUID().uuidString
            Haptics.success()
            withMotion(.snappy) { sure = nil }
            app.dataVersion += 1
            if let batchId = batch.batchId {
                // A run that ran out of time still linked part of the backlog: that part stays undoable.
                let text = batch.stoppedEarly ? SureMatchText.linkedPartly(batch.linked.count) : SureMatchText.linked(batch.linked.count)
                showToast(text, action: "Kumoa") { await undoSure(batchId) }
            }
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func undoSure(_ batchId: String) async {
        do {
            let result: SureMatchUndone = try await app.api.send("POST", "/api/matching/sure/undo", body: SureMatchUndo(batchId: batchId))
            Haptics.success()
            app.dataVersion += 1
            showToast(SureMatchText.restored(result.restored), action: nil, run: nil)
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func showToast(_ text: String, action: String?, run: (() async -> Void)?) {
        toastTask?.cancel()
        toastAction = run
        withMotion(.snappy) { toast = Toast(text: text, actionLabel: action) }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withMotion { toast = nil }
            toastAction = nil
        }
    }

    private func runToastAction() {
        let action = toastAction
        toastTask?.cancel()
        toastAction = nil
        withMotion { toast = nil }
        if let action { Task { await action() } }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if selecting {
                let all = shownReceipts
                let onScreen = all.prefix(limit.visible(all.count)).map(\.id)
                let allPicked = !onScreen.isEmpty && onScreen.allSatisfy(selected.contains)
                Button(allPicked ? "Poista valinnat" : "Valitse kaikki") {
                    if allPicked { selected.subtract(onScreen) } else { selected.formUnion(onScreen) }
                }
                Button("Valmis") {
                    withMotion(.snappy) {
                        selecting = false
                        selected = []
                    }
                }
            } else {
                // One primary, the camera, and Toiminnot for the rest (U030, U098): the filter and
                // "Valitse" were two more circled icons of the camera's weight.
                Menu {
                    Menu {
                        filterPickers
                    } label: {
                        Label("Suodata", systemImage: "line.3.horizontal.decrease.circle")
                    }
                    // Always here, so the menu keeps its shape when the list arrives.
                    Button { withMotion(.snappy) { selecting = true } } label: {
                        Label("Valitse kuitteja", systemImage: "checkmark.circle")
                    }
                    // The checkmark symbol made VoiceOver call the action "selected" (U032).
                    .accessibilityRemoveTraits(.isSelected)
                    .disabled(receipts.value?.isEmpty ?? true)
                } label: {
                    // An active filter fills it; the chips under the tabs say which one.
                    Image(systemName: filtered ? "ellipsis.circle.fill" : "ellipsis.circle")
                        .tapTarget()
                }
                .accessibilityLabel(filtered ? "Toiminnot, suodatin käytössä" : "Toiminnot")
                Button { capture = true } label: { Image(systemName: "camera.circle").tapTarget() }
                    .accessibilityLabel("Kuvaa kuitti")
            }
        }
    }

    /// Toiminnot > Suodata: month, category, source, amount and order.
    @ViewBuilder private var filterPickers: some View {
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
    }

    // MARK: Loading

    /// The cached answers for these filters go on screen at once (a cold launch: the previous
    /// run's), then the server's; `force` (pull-to-refresh) asks the server even while fresh.
    private func load(force: Bool = false) async {
        let timing = ScreenTiming("Kuitit")
        // A slow answer for filters the owner already changed must not replace the newer list.
        let asked = query
        let listQuery = ReceiptListPaging.firstQuery(asked, loadedRows: receipts.value?.count ?? 0)
        let countsQuery = asked.countsQuery()
        // The four answers as last painted, in memory: no await before the first rows (w41 perf
        // walk: the four awaits on the cache below took 0.35-0.85 s before anything showed).
        if receipts.value == nil, let cached: ReceiptList = app.lastPainted("/api/receipts", query: listQuery),
           let q: ReceiptList = app.lastPainted("/api/receipts", query: ReceiptListQuery.pendingQueue()),
           let r: ReceiptList = app.lastPainted("/api/receipts", query: ReceiptListQuery.rejectedQueue()) {
            if let c: ReceiptCounts = app.lastPainted("/api/receipts/counts", query: countsQuery) { counts = c.counts }
            applyPending(q)
            applyRejected(r)
            applyList(cached, tab: asked.tab)
            timing.painted(fromCache: true)
        } else if receipts.value == nil, let cached: ReceiptList = await app.cachedValue("/api/receipts", query: listQuery), asked == query {
            if let c: ReceiptCounts = await app.cachedValue("/api/receipts/counts", query: countsQuery) { counts = c.counts }
            if let q: ReceiptList = await app.cachedValue("/api/receipts", query: ReceiptListQuery.pendingQueue()) { applyPending(q) }
            if let r: ReceiptList = await app.cachedValue("/api/receipts", query: ReceiptListQuery.rejectedQueue()) { applyRejected(r) }
            guard asked == query else { return }
            applyList(cached, tab: asked.tab)
            timing.painted(fromCache: true)
        }
        receipts.begin()
        async let countsResponse: ReceiptCounts? = try? app.cachedGet("/api/receipts/counts", query: countsQuery, force: force, persist: true)
        async let queue: ReceiptList? = try? app.cachedGet("/api/receipts", query: ReceiptListQuery.pendingQueue(), force: force, persist: true)
        async let rejectedResponse: ReceiptList? = try? app.cachedGet("/api/receipts", query: ReceiptListQuery.rejectedQueue(), force: force, persist: true)
        let list: ReceiptList
        do {
            list = try await app.cachedGet("/api/receipts", query: listQuery, force: force, persist: true)
        } catch is CancellationError {
            return
        } catch {
            guard asked == query else { return }
            receipts.fail(error)
            if let q = await queue { applyPending(q) }
            if let r = await rejectedResponse { applyRejected(r) }
            return
        }
        // The four answers go on screen together: the review queue arriving after the list
        // was inserted above the rows and pushed every one of them down.
        let pendingList = await queue
        let rejectedList = await rejectedResponse
        let countsList = await countsResponse
        if let pendingList { applyPending(pendingList) }
        if let rejectedList { applyRejected(rejectedList) }
        guard asked == query else { return }
        if let countsList { counts = countsList.counts }
        applyList(list, tab: asked.tab)
        app.rememberPainted(list, "/api/receipts", query: listQuery)
        if let pendingList { app.rememberPainted(pendingList, "/api/receipts", query: ReceiptListQuery.pendingQueue()) }
        if let rejectedList { app.rememberPainted(rejectedList, "/api/receipts", query: ReceiptListQuery.rejectedQueue()) }
        if let countsList { app.rememberPainted(countsList, "/api/receipts/counts", query: countsQuery) }
        failure = nil
        timing.dataReady()
    }

    private func applyList(_ list: ReceiptList, tab: ReceiptTab) {
        receipts.succeed(list.receipts)
        paging.firstPage(list)
        total = ReceiptListPaging.total(list, tab: tab, counts: counts)
        // Rows that left the list (deleted elsewhere, filtered out) are no longer selected.
        selected.formIntersection(list.receipts.map(\.id))
        app.rememberReceiptRows(list.receipts)
    }

    private func applyPending(_ list: ReceiptList) {
        pending = list.receipts
        pendingTruncated = list.truncated ?? false
        app.rememberReceiptRows(list.receipts)
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
            let page: ReceiptList = try await app.api.get("/api/receipts", query: ReceiptListQuery.pendingQueue(offset: pending.count))
            pending = ReceiptPaging.append(pending, page.receipts)
            pendingTruncated = page.truncated ?? false
            app.rememberReceiptRows(page.receipts)
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
            let page: ReceiptList = try await app.api.get("/api/receipts", query: ReceiptListQuery.rejectedQueue(offset: rejected.count))
            rejected = ReceiptPaging.append(rejected, page.receipts)
            rejectedTotal = page.count ?? rejectedTotal
            rejectedTruncated = page.truncated ?? false
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }

    /// The page after the loaded rows: by cursor from a paging server, by offset from an older one.
    private func loadMore() async {
        let asked = query
        guard !loadingMore, let loaded = receipts.value, let next = paging.nextQuery(asked, loaded: loaded.count) else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page: ReceiptList = try await app.api.get("/api/receipts", query: next)
            // The filters changed while this page was on its way: the fresh load wins.
            guard asked == query else { return }
            receipts.update { $0 = ReceiptPaging.append(loaded, page.receipts) }
            total = page.count ?? total
            paging.nextPage(page)
            app.rememberReceiptRows(page.receipts)
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
            withMotion(visibility.animation(.default)) { pending.removeAll { ids.contains($0.id) } }
            await load()
        } catch {
            failure = error.userMessage
        }
    }

    /// The bulk bar's "Hyväksy": the picked ready pending receipts (`POST /api/receipts/batch-approve`,
    /// at most 200 per call). What the server refused stays picked, named by its reason (web F15).
    private func approveSelected(_ ids: [String]) async {
        guard !ids.isEmpty, !busy else { return }
        busy = true
        failure = nil
        notice = nil
        defer { busy = false }
        var approved = 0
        var refusedIds: [String] = []
        var refusals: [String] = []
        for chunk in BulkBatch.chunks(ids, size: BulkBatch.approveLimit) {
            do {
                let result: BatchApproveResult = try await app.api.send("POST", "/api/receipts/batch-approve", body: ReceiptIdsBody(receiptIds: chunk))
                approved += result.approvedCount
                refusedIds += (result.failed ?? []).map(\.id)
                refusals += (result.failed ?? []).map { $0.error ?? "" }
            } catch is CancellationError {
                return
            } catch {
                // One reason per receipt, so the count in the sentence is the receipts'.
                let reason = error.userMessage
                refusedIds += chunk
                refusals += chunk.map { _ in reason }
            }
        }
        let outcome = ReviewQueue.approvalOutcome(approved: approved, failures: refusals)
        if refusals.isEmpty {
            notice = outcome
            Haptics.success()
        } else {
            failure = outcome
            Haptics.error()
        }
        selected = Set(refusedIds)
        if selected.isEmpty { selecting = false }
        if approved > 0 { app.dataVersion += 1 }
        await load()
    }

    /// "Palauta": a rejected receipt goes back to the review queue (`PATCH …/review`).
    private func restore(_ id: String) async {
        guard !busy, let index = rejected.firstIndex(where: { $0.id == id }) else { return }
        busy = true
        failure = nil
        notice = nil
        defer { busy = false }
        let row = rejected[index]
        withMotion {
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
            withMotion(visibility.animation(.default)) {
                rejected.insert(row, at: min(index, rejected.count))
                rejectedTotal += 1
            }
            failure = error.userMessage
            Haptics.error()
        }
    }

    /// Gone from the list at once, with "Kumoa" over the tabs; the server is asked when that ends
    /// (`AppModel.deleteReceipts`), and the rows it refuses come back there with the reason.
    private func delete(_ ids: [String]) {
        guard !ids.isEmpty, !busy else { return }
        failure = nil
        notice = nil
        app.deleteReceipts(ids)
        if selecting {
            withMotion(.snappy) {
                selecting = false
                selected = []
            }
        }
    }
}

struct ReceiptRow<Accessory: View>: View, Equatable {
    let receipt: Receipt
    /// Kuitit shows a small picture of the file; the review queue and mail list stay text only.
    let thumbnail: Bool
    /// The review queue's rows: the name may take two lines and the line under it one, so a long
    /// vendor shows whole next to the pill under the amount.
    let wrapsTitle: Bool
    /// The row's words, made once when the row is made instead of on every redraw.
    private let text: ReceiptRowText
    /// Under the amount (the queue's "Tarkista" or "Palauta" pill), as on Koti's task rows.
    private let accessory: Accessory

    init(receipt: Receipt, thumbnail: Bool = false, wrapsTitle: Bool = false, @ViewBuilder accessory: () -> Accessory) {
        self.receipt = receipt
        self.thumbnail = thumbnail
        self.wrapsTitle = wrapsTitle
        text = ReceiptRowText(receipt)
        self.accessory = accessory()
    }

    /// A row whose words and picture did not change is not drawn again (`.equatable()`). Only the
    /// list rows use it, and they have no accessory.
    static func == (lhs: ReceiptRow, rhs: ReceiptRow) -> Bool {
        lhs.receipt.id == rhs.receipt.id && lhs.text == rhs.text && lhs.thumbnail == rhs.thumbnail
            && lhs.wrapsTitle == rhs.wrapsTitle && lhs.receipt.hasOriginalFile == rhs.receipt.hasOriginalFile
    }

    var body: some View {
        HStack {
            if thumbnail { ReceiptThumbnail(receipt: receipt) }
            VStack(alignment: .leading, spacing: 2) {
                Text(text.title).lineLimitUnlessLarge(wrapsTitle ? 2 : 1)
                HStack(spacing: 4) {
                    if let tag = text.kindTag {
                        // Fixed size: a long detail wraps beside it, the tag itself never breaks.
                        Text(tag)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Theme.ink2.opacity(0.12), in: Capsule())
                            .fixedSize()
                    }
                    Text(text.detail)
                    if text.linked {
                        Image(systemName: "link").accessibilityLabel("Kohdistettu")
                    }
                }
                .font(.caption).foregroundStyle(Theme.ink2)
                .lineLimitUnlessLarge(wrapsTitle ? 1 : nil)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if let amount = text.amount {
                    MoneyText(amount: text.isIncome ? amount : -amount, signed: text.isIncome)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(text.isIncome ? Theme.success : Theme.ink)
                }
                accessory
            }
        }
    }
}

extension ReceiptRow where Accessory == EmptyView {
    init(receipt: Receipt, thumbnail: Bool = false) {
        self.init(receipt: receipt, thumbnail: thumbnail) { EmptyView() }
    }
}

/// The "Näytä enemmän" row of a list the server pages (`PagedShowMore`): reveals ten loaded rows,
/// and asks for the next page only once every loaded row is on screen. `fetch` returns the new row count.
struct PagedShowMoreButton: View {
    @Environment(\.listMotion) private var listMotion
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
                        withMotion(.snappy) { PagedShowMore.revealFetched(&limit, before: before, after: after) }
                    }
                case .reveal, .fold:
                    withMotion(.snappy) { limit.more(total: loaded) }
                case nil:
                    break
                }
            } label: {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold))
                        .contentTransition(.opacity)
                    Spacer()
                    // One fixed slot for the chevron and the spinner: the row keeps its size when a
                    // page starts or ends loading. The spinner is there only while loading (one
                    // spinning unseen keeps the app from going idle).
                    ZStack {
                        Image(systemName: limit.visible(loaded) >= loaded && !serverHasMore ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .opacity(loading ? 0 : 1)
                            .accessibilityHidden(true)
                        if loading { ProgressView().transition(.opacity) }
                    }
                    .frame(width: 20, height: 20)
                }
                .foregroundStyle(Theme.accent)
                .motion(listMotion.animation(.snappy), value: loading)
            }
            .disabled(loading)
        }
    }
}

/// What a Kuitit list last painted for one set of filters: its first page, chip counts and both
/// review queues.
struct ReceiptsPreview {
    let list: ReceiptList
    let counts: ReceiptCounts?
    let pending: ReceiptList
    let rejected: ReceiptList
}

extension AppModel {
    /// The first page, counts and review queues last painted for `query`; nil without the page or a
    /// queue (a queue arriving after the rows would push every one of them down, as `load` says).
    func receiptsPreview(_ query: ReceiptListQuery) -> ReceiptsPreview? {
        guard let list: ReceiptList = lastPainted("/api/receipts", query: ReceiptListPaging.firstQuery(query)),
              let pending: ReceiptList = lastPainted("/api/receipts", query: ReceiptListQuery.pendingQueue()),
              let rejected: ReceiptList = lastPainted("/api/receipts", query: ReceiptListQuery.rejectedQueue()) else { return nil }
        return ReceiptsPreview(list: list, counts: lastPainted("/api/receipts/counts", query: query.countsQuery()),
                               pending: pending, rejected: rejected)
    }

    /// One of Raportit's drill warms (`ReportDrillWarm`), from the cache or, with `fetch`, asked
    /// through it. The answer also goes into `lastPainted`, with the review queues the cache holds,
    /// so the drilled Kuitit takes it in its first frame (`receiptsPreview`). False when there is none.
    func warmReceiptsDrill(_ request: ReportDrillWarm.Request, fetch: Bool) async -> Bool {
        switch request.kind {
        case .list:
            let list: ReceiptList?
            if fetch {
                list = try? await cachedGet(request.path, query: request.query)
            } else {
                list = await cachedValue(request.path, query: request.query)
            }
            guard let list else { return false }
            rememberPainted(list, request.path, query: request.query)
            for queue in [ReceiptListQuery.pendingQueue(), ReceiptListQuery.rejectedQueue()] {
                let shown: ReceiptList? = lastPainted("/api/receipts", query: queue)
                guard shown == nil, let cached: ReceiptList = await cachedValue("/api/receipts", query: queue) else { continue }
                rememberPainted(cached, "/api/receipts", query: queue)
            }
            return true
        case .counts:
            let counts: ReceiptCounts?
            if fetch {
                counts = try? await cachedGet(request.path, query: request.query)
            } else {
                counts = await cachedValue(request.path, query: request.query)
            }
            guard let counts else { return false }
            rememberPainted(counts, request.path, query: request.query)
            return true
        }
    }
}
