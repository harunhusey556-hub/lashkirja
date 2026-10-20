import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

struct BankFeedView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openRoute) private var openRoute
    @State private var state = ScreenLoad<[BankFeed.Month]>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var statements: [Statement] = []
    /// Each loaded month's "Tulot · Menot" line and whether all its rows are in, added up when the
    /// rows or their paging change (`groupRows`) so the month header only reads it.
    @State private var monthLines: [String: BankFeed.MonthLine] = [:]
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
    /// "Hyväksy kuittiehdotukset" shows what it links before it does (count, money, mismatches).
    @State private var confirmPreview: BankFeed.ConfirmPreview?
    /// A screen the row sheet asked for ("Avaa kuitti"): pushed here once the sheet has closed,
    /// so it lands on this tab's stack and Back returns to the feed. On the stack's path: an invoice
    /// pushed beside it opened its customer under itself (G005).
    @State private var openAfterSheet: Route?
    @State private var pushed: Route?
    /// The month group on screen (one at a time); nil follows `GroupChoice` (the newest month).
    /// The chips and Toiminnot's Kuukausi both set it: one month control, not two (X096).
    @State private var shownMonth: String?
    @State private var limit = ShowMore()
    /// The bank connections, for "Päivitä" in the menu and the first row's consent line.
    @State private var bankLinks: [BankConnection] = []
    /// The connections have answered (or failed) once: until then the consent line is greyed.
    @State private var linksLoaded = false
    /// Saldo yhteensä in the first row (`GET /api/bank-accounts`, which the launch prefetch keeps).
    @State private var position: BankHubPosition?
    @State private var positionFailed = false
    @State private var syncingBank: String?
    /// The server finishes the sync as a job: "Päivitetään…" until its rows are in.
    @State private var syncWaiting = false
    /// The rows come a page at a time from a server that pages (`?cursor=`); the next page loads
    /// when the end of the list comes into view.
    @State private var paging = CursorPaging()
    @State private var loadingPage = false
    /// "Valitse": rows picked for a bulk action.
    @State private var selection = BulkSelection()
    /// The confirmation preview is for the picked rows, not every suggestion.
    @State private var previewForSelection = false
    @State private var bulkConfirm: BankBulkAction?

    /// The bulk actions that ask first.
    enum BankBulkAction: Identifiable {
        case reject, ignore
        var id: Self { self }
    }

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
        // The motion gate's timeline (audit builds only): whether Pankki redraws while the walk
        // scrolls it. N2's pankki-feed-scroll stalled mid-swipe; this and the first row's mark
        // below tell the next run what the stall follows.
        let _ = MotionProbe.shared.mark("bankFeed-update")
        // The month on screen, picked once per update: the list, its chips and Toiminnot's
        // Kuukausi read this, instead of each filtering every row again.
        let groups = state.value.map { visibleGroups($0) } ?? []
        let shownKey = GroupChoice.pick(shownMonth, available: groups.map(\.month))
        List {
            balanceRow
            Section {
                Picker("Näytä", selection: Binding(get: { onlyOpen }, set: { onlyOpen = $0; limit.reset() })) {
                    Text("Kaikki").tag(false)
                    Text("Vaatii toimia").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            // Tiliotteet stays in Toiminnot; the row here only repeated it.
            if let month {
                Section {
                    Button { showAllMonths() } label: {
                        Label("\(StatementText.month(month)) · näytä kaikki kuukaudet", systemImage: "xmark.circle")
                    }
                }
            }
            if syncingBank != nil {
                HStack(spacing: 8) { ProgressView(); Text(syncWaiting ? "Päivitetään…" : "Haetaan tapahtumia pankista…").foregroundStyle(Theme.ink2) }
                    .font(.footnote)
            }
            if let notice { Text(notice).font(.footnote).foregroundStyle(noticeFailed ? Theme.danger : Theme.success) }
            if confirmable > 0 {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Kuittien kohdistus").font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                        Text("\(confirmable) valmista ehdotusta").font(.caption).foregroundStyle(Theme.ink2)
                        Button { confirmPreview = BankFeed.confirmPreview(statements.flatMap(\.transactions)) } label: {
                            if bulkBusy { ProgressView() } else { Text(BankFeed.confirmAllLabel(confirmable)) }
                        }
                        .buttonStyle(.primary)
                        .disabled(bulkBusy)
                    }
                    .padding(.vertical, 4)
                }
            }
            if let months = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if months.isEmpty {
                    ContentUnavailableView {
                        Label(month == nil ? "Ei pankkitapahtumia vielä" : "Ei tapahtumia tässä kuussa", systemImage: "building.columns")
                    } description: { Text("Tuo tiliote tai yhdistä pankki.") } actions: {
                        // Borderless: two buttons in one list row each keep their own tap.
                        Button("Tuo tiliote") { importing = true }.buttonStyle(.borderless)
                        Button("Yhdistä pankki") { pushed = .bankAccounts }.buttonStyle(.borderless)
                    }
                }
                // One month at a time, picked from a chip row (or Toiminnot's Kuukausi), instead of
                // every month stacked.
                if let key = shownKey, let group = groups.first(where: { $0.month == key }) {
                    if groups.count > 1 {
                        Section {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(groups) { option in
                                        SectionChip(title: monthTitle(option.month), count: option.rows.count, selected: option.month == key) {
                                            shownMonth = option.month
                                            limit.reset()
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                                .padding(.horizontal, ChipRow.inset)
                            }
                            .chipRowScroll()
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                        }
                        .chipRowSection()
                    }
                    Section {
                        ForEach(group.rows.prefix(limit.visible(group.rows.count))) { row in
                            Button {
                                if selection.isActive { selection.toggle(row.id) } else { selected = row }
                            } label: {
                                HStack(spacing: 12) {
                                    if selection.isActive { BulkCheckmark(selected: selection.contains(row.id)) }
                                    BankRow(row: row)
                                }
                            }
                            .buttonStyle(.pressable)
                            .accessibilityAddTraits(selection.contains(row.id) ? .isSelected : [])
                        }
                        ShowMoreButton(limit: $limit, total: group.rows.count)
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(monthTitle(group.month))
                                Spacer()
                                if group.open > 0 { Text("\(group.open) avoinna").foregroundStyle(Theme.accent) }
                            }
                            monthTotals(group.month)
                        }
                    }
                } else if !months.isEmpty {
                    Text(search.isEmpty ? "Kaikilla tapahtumilla on kuitti tai merkintä." : "Ei osumia.").foregroundStyle(Theme.ink2)
                }
                if paging.hasMore {
                    // Reaching the end of the list asks for the next page (infinite scroll).
                    HStack(spacing: 8) { ProgressView(); Text("Ladataan lisää tapahtumia…").foregroundStyle(Theme.ink2) }
                        .font(.footnote)
                        .task(id: paging.nextCursor) { await loadNextPage() }
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: [BankFeed.Month]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: Binding(get: { search }, set: { search = $0; limit.reset() }), prompt: "Hae…")
        .navigationTitle("Pankki")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if selection.isActive {
                    Button(selection.allSelected(shownRows().map(\.id)) ? "Poista valinnat" : "Valitse kaikki") {
                        selection.toggleAll(shownRows().map(\.id))
                    }
                }
            }
            // One item from the first frame: four crowded the title out of the bar (U014), and a
            // Valitse that came with the rows changed the bar under the owner's thumb.
            ToolbarItem(placement: .topBarTrailing) {
                if selection.isActive {
                    Button("Valmis") { selection.end() }
                } else {
                    // The asked month while its rows load.
                    actionsMenu(shown: state.value == nil ? month : shownKey ?? month)
                }
            }
        }
        .sheet(item: $confirmPreview, onDismiss: { previewForSelection = false }) { preview in
            ConfirmAllPreviewSheet(preview: preview) {
                // The picked rows' pairs only, or every suggestion of the month.
                let forSelection = previewForSelection
                confirmPreview = nil
                Task { if forSelection { await confirmSelected() } else { await confirmAll() } }
            }
            .presentationDetents([.medium, .large])
        }
        .confirmSheet(presenting: $bulkConfirm) { action in
            switch action {
            case .reject:
                return ConfirmRequest(title: bulkConfirmTitle(action),
                                      message: "Kuitit jäävät tallennetuiksi; vain ehdotettu kohdistus poistuu.",
                                      confirmTitle: "Hylkää") { Task { await rejectSelected() } }
            case .ignore:
                return ConfirmRequest(title: bulkConfirmTitle(action),
                                      message: "Tapahtumat eivät enää näy kohdassa Vaatii toimia.",
                                      confirmTitle: "Merkitse", isDestructive: false) { Task { await ignoreSelected() } }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if selection.isActive && !selectedRows.isEmpty {
                let rows = selectedRows
                let pairs = BankBulk.pairs(rows).count
                let ignorable = BankBulk.ignorable(rows).count
                BulkBar(count: rows.count, busy: bulkBusy) {
                    if pairs > 0 {
                        BulkBarButton(title: BankBulk.acceptLabel(pairs)) {
                            previewForSelection = true
                            confirmPreview = BankFeed.confirmPreview(rows)
                        }
                        BulkBarButton(title: BankBulk.rejectLabel(pairs), destructive: true) { bulkConfirm = .reject }
                    }
                    if ignorable > 0 {
                        BulkBarButton(title: BankBulk.ignoreLabel(ignorable)) { bulkConfirm = .ignore }
                    }
                }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.commaSeparatedText, .plainText, .xml, .pdf, .spreadsheet, .data]) { result in
            if case .success(let url) = result { Task { await upload(url) } }
        }
        .sheet(item: $selected, onDismiss: {
            if let route = openAfterSheet {
                openAfterSheet = nil
                openRoute(route)
            }
            Task { await load() }
        }) { row in
            BankRowSheet(row: row, onOpen: { openAfterSheet = $0 })
        }
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(key: month ?? "", version: app.refreshEverything())
            async let links: Void = loadBankLinks()
            async let balances: Void = loadPosition()
            await load()
            await links
            await balances
        }
        .perfReady("pankkiFeed", state.value != nil)
        .task(id: loadKey) {
            await restore()
            await restoreBalance()
            guard state.value == nil || gate.isDue(key: month ?? "", version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            // The bank links and the balances only fill the menu and the first row: they load
            // beside the rows, not after them.
            async let links: Void = loadBankLinks()
            async let balances: Void = loadPosition()
            await load()
            await links
            await balances
            if !Task.isCancelled { gate.mark(key: month ?? "", version: version) }
        }
        .motion(.snappy, value: onlyOpen)
    }

    /// The month groups with the rows the filter and search leave, empty months dropped.
    private func visibleGroups(_ months: [BankFeed.Month]) -> [BankFeed.Month] {
        BankFeed.shownMonths(months, onlyOpen: onlyOpen, search: search)
    }

    private func monthTitle(_ key: String) -> String {
        key.isEmpty ? "Päiväämättömät" : MonthKey.title(key, currentYear: String(MonthKey.current().prefix(4)))
    }

    private func showAllMonths() {
        month = nil
        shownMonth = nil
        limit.reset()
    }

    // MARK: First row, month header and Toiminnot

    /// Saldo yhteensä and the consent on one row of one height: the hub's balance card and the
    /// reconnect line folded into the screen that has the rows (O2). It opens Pankkiyhteys ja
    /// tilit. Until the cached figures are read, a greyed copy of the same size holds its place.
    private var balanceRow: some View {
        Section {
            NavigationLink(value: Route.bankAccounts) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Saldo yhteensä").foregroundStyle(Theme.ink)
                        Spacer(minLength: 8)
                        balanceAmount
                    }
                    consentLine
                }
                .padding(.vertical, 2)
            }
            // Audit builds only: the motion gate's pankki-feed-scroll stalled mid-swipe as this row,
            // the list's one link row, left the top; the mark puts that moment on its timeline.
            .onDisappear { MotionProbe.shared.mark("bankFeed-first-row-gone") }
        }
    }

    @ViewBuilder private var balanceAmount: some View {
        // The accounts' balances only: the rows give a line its latest day, which the total does
        // not use, and walking them here ran on every update of the screen.
        let lines = position.map(BankHub.balanceLines) ?? []
        if let position, !lines.isEmpty {
            // A sync's balances show at once, before the accounts are asked again.
            let fresh = app.versions.balances
            MoneyText(amount: fresh.total(BankHub.total(position), lines: lines))
                .fontWeight(.semibold)
                .foregroundStyle(Theme.ink)
        } else if position != nil || positionFailed {
            // No account yet, or no figure to trust: a dash, not a total of zero.
            Text("–").fontWeight(.semibold).foregroundStyle(Theme.ink2)
        } else {
            Text("0 000,00 €").fontWeight(.semibold).redacted(reason: .placeholder).accessibilityHidden(true)
        }
    }

    /// One line under the total: an ended consent (the web's compact card on Tapahtumat), else how
    /// long the working one lasts, in the warning colour a fortnight ahead (`BankConsent.validity`).
    @ViewBuilder private var consentLine: some View {
        let validities = bankLinks.compactMap { BankConsent.validity($0) }
        Group {
            if let ended = bankLinks.first(where: { BankConsent.reconnect($0) != nil }) {
                Label("\(ended.aspspName): vaatii uuden vahvistuksen", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
            } else if let validity = validities.first(where: \.warning) ?? validities.first {
                Text(validity.text).foregroundStyle(validity.warning ? Theme.warning : Theme.ink2)
            } else if let excluded = position?.combined?.excludedCurrencies, !excluded.isEmpty {
                Text("Ei sisällä tilejä valuutoissa \(excluded.joined(separator: ", "))").foregroundStyle(Theme.ink2)
            } else if linksLoaded && (position != nil || positionFailed) {
                Text("Tilit, saldot ja pankkiyhteys").foregroundStyle(Theme.ink2)
            } else {
                Text("Lupa voimassa 1.1.2026 asti").redacted(reason: .placeholder).accessibilityHidden(true)
            }
        }
        .font(.caption)
        .lineLimitUnlessLarge()
    }

    /// "Tulot X · Menot Y" under the month's name, once every row of the month is in: part of a
    /// month would show part of its money. The line is there from the first frame, unseen until
    /// then, so nothing below it moves when it shows. Read from `monthLines`, added up when the
    /// rows change, not here on every update.
    private func monthTotals(_ key: String) -> some View {
        let line = monthLines[key]
        let complete = line?.complete ?? false
        let totals = line?.totals ?? BankHub.MonthTotals()
        return Text("Tulot \(Money.format(totals.income)) · Menot \(Money.format(totals.expenses))")
            .monospacedDigit()
            .opacity(complete ? 1 : 0)
            .accessibilityHidden(!complete)
            .motion(.easeOut(duration: 0.2), value: complete)
    }

    /// Toiminnot: Valitse, the month, Tiliotteet, then the bank's own actions. "Hyväksy
    /// kuittiehdotukset" is the Kuittien kohdistus card's button only (one primary). `shown` is the
    /// month on screen, as `body` picked it.
    private func actionsMenu(shown: String?) -> some View {
        Menu {
            // Always here, so the menu keeps its shape when the rows arrive; nothing to pick without them.
            Button { selection.begin() } label: { Label("Valitse", systemImage: "checkmark.circle") }
                .disabled(state.value?.isEmpty != false)
            monthMenu(shown)
            Button { openRoute(.statements) } label: { Label("Tiliotteet", systemImage: "doc.plaintext") }
            // Web Tapahtumat: a refresh per connected bank.
            ForEach(BankConsent.syncable(bankLinks)) { connection in
                Button { Task { await syncBank(connection) } } label: {
                    Label("Päivitä \(connection.aspspName)", systemImage: "arrow.clockwise")
                }
                .disabled(syncingBank != nil)
            }
            Button { importing = true } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
            Button { Task { await rerunMatching() } } label: { Label("Etsi kuitteja uudelleen", systemImage: "arrow.triangle.2.circlepath") }
                .disabled(bulkBusy)
            Button { pushed = .bankAccounts } label: { Label("Pankkiyhteys ja tilit", systemImage: "building.columns") }
        } label: {
            Image(systemName: "ellipsis.circle").tapTarget()
        }
        .accessibilityLabel("Toiminnot")
    }

    /// Kuukausi: the month the chips show, named in its label. The second month control it
    /// replaces said "Kaikki kuukaudet" while one month showed (X096).
    private func monthMenu(_ shown: String?) -> some View {
        Menu {
            Picker("Kuukausi", selection: Binding(get: { shown }, set: { if let key = $0 { pickMonth(key) } })) {
                ForEach(monthOptions(shown), id: \.self) { key in
                    Text(StatementText.month(key)).tag(String?.some(key))
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label(shown.map { "Kuukausi · \($0.isEmpty ? monthTitle($0) : StatementText.month($0))" } ?? "Kuukausi", systemImage: "calendar")
        }
        .disabled(shown == nil)
    }

    /// The last twelve months (`BankFeed.monthChoices`), and the shown one when it is older.
    private func monthOptions(_ shown: String?) -> [String] {
        let recent = BankFeed.monthChoices()
        guard let shown, !shown.isEmpty, !recent.contains(shown) else { return recent }
        return recent + [shown]
    }

    private func pickMonth(_ key: String) {
        shownMonth = key
        limit.reset()
        // Its rows are not loaded (an older month, or one on a later page): asked for that month,
        // as a drill to it does.
        if state.value?.contains(where: { $0.month == key }) != true { month = key }
    }

    private func load() async {
        state.begin()
        // A slow answer for a month the owner already left must not replace the newer one.
        let requested = month
        // The first page (50 rows, or as many as were loaded); a server that does not page sends all.
        let loadedRows = statements.reduce(0) { $0 + $1.transactions.count }
        let query = CursorPaging.firstQuery(BankFeed.query(month: requested), loadedRows: loadedRows)
        do {
            // The first page goes through the app's cache (Kirjanpito warms it); a reload of more
            // rows than one page asks the server.
            let list: StatementList = loadedRows <= CursorPaging.pageSize
                ? try await app.cachedGet("/api/statements", query: query)
                : try await app.api.get("/api/statements", query: query)
            guard requested == month else { return }
            statements = list.statements
            paging.firstPage(next: list.nextCursor)
            state.succeed(groupRows())
            remember()
            openPendingFocus()
            // A row asked for from Koti may be further down: the pages are read until it is found.
            while pendingFocus != nil, paging.hasMore, !Task.isCancelled, await loadNextPage() {
                openPendingFocus()
            }
        } catch is CancellationError {
        } catch {
            guard requested == month else { return }
            state.fail(error)
        }
    }

    /// The page after the loaded rows, merged in (a row is never shown twice). A failure leaves
    /// the rows shown; the end-of-list row asks again when it next comes into view. Returns
    /// whether a page was added.
    @discardableResult
    private func loadNextPage() async -> Bool {
        guard !loadingPage, let cursor = paging.nextCursor, let query = paging.nextQuery(BankFeed.query(month: month)) else { return false }
        let requested = month
        loadingPage = true
        defer { loadingPage = false }
        guard let page: StatementList = try? await app.api.get("/api/statements", query: query),
              !Task.isCancelled, requested == month, paging.nextCursor == cursor else { return false }
        statements = StatementPaging.merge(statements, page.statements)
        paging.nextPage(next: page.nextCursor)
        let months = groupRows()
        state.update { $0 = months }
        remember()
        return true
    }

    /// The previous visit's rows for this month filter, shown at once; the load refreshes them behind.
    /// No visit yet: the cached first page (Kirjanpito warms it), so the screen opens with rows.
    private func restore() async {
        guard state.value == nil else { return }
        if let memory = app.bankFeedMemory[month ?? ""] {
            statements = memory.statements
            paging = memory.paging
            state.succeed(groupRows())
            return
        }
        let requested = month
        guard let list: StatementList = await app.cachedValue("/api/statements", query: CursorPaging.firstQuery(BankFeed.query(month: requested))),
              requested == month, state.value == nil else { return }
        statements = list.statements
        paging.firstPage(next: list.nextCursor)
        state.succeed(groupRows())
    }

    /// `statements` by month, as they and `paging` now stand, with each month's line under its name
    /// (`monthLines`): added up here, once per change of the rows, so the month header does not
    /// walk every row on each update of the screen.
    private func groupRows() -> [BankFeed.Month] {
        let months = BankFeed.months(statements)
        monthLines = BankFeed.monthLines(statements, months: months, hasMore: paging.hasMore)
        return months
    }

    private func remember() {
        app.bankFeedMemory[month ?? ""] = BankFeedMemory(statements: statements, paging: paging)
    }

    /// The first row's balances and consent from the cache (the launch keeps the balances,
    /// Kirjanpito warms the connections), on screen before they are asked again.
    private func restoreBalance() async {
        if position == nil, let cached: BankHubPosition = await app.cachedValue("/api/bank-accounts") { position = cached }
        if !linksLoaded, let cached: BankConnections = await app.cachedValue("/api/bank/connections") {
            bankLinks = cached.connections
            linksLoaded = true
        }
    }

    /// Saldo yhteensä, beside the rows. A figure already on screen stays when the answer fails;
    /// only a first failure shows the dash.
    private func loadPosition() async {
        let app = self.app
        let startedAt = Date()
        let result = await Result<BankHubPosition, Error>(asyncCatching: { try await app.cachedGet("/api/bank-accounts", persist: true) })
        if Task.isCancelled { return }
        switch result {
        case .success(let value):
            position = value
            positionFailed = false
            app.versions.settleBalances(loadStartedAt: startedAt)
        case .failure(let error):
            if !(error is CancellationError) && position == nil { positionFailed = true }
        }
    }

    /// The rows on screen: the shown month's group, as far as "Näytä lisää" has opened it. Bulk
    /// actions take only these (web BOOKS-12), never rows a filter or a fold hides.
    private func shownRows() -> [BankTransaction] {
        guard let months = state.value else { return [] }
        let groups = visibleGroups(months)
        guard let key = GroupChoice.pick(shownMonth, available: groups.map(\.month)),
              let group = groups.first(where: { $0.month == key }) else { return [] }
        return Array(group.rows.prefix(limit.visible(group.rows.count)))
    }

    private var selectedRows: [BankTransaction] {
        guard selection.isActive else { return [] }
        return shownRows().filter { selection.contains($0.id) }
    }

    private func bulkConfirmTitle(_ action: BankBulkAction) -> String {
        let rows = selectedRows
        switch action {
        case .reject: return BankBulk.rejectTitle(BankBulk.pairs(rows).count)
        case .ignore: return BankBulk.ignoreTitle(BankBulk.ignorable(rows).count)
        }
    }

    // MARK: Bulk actions

    /// "Hyväksy ehdotukset": exactly the picked rows' pairs (`POST /api/matching/confirm-all` with
    /// `pairs`), at most 500 per call.
    private func confirmSelected() async {
        await confirmPairs(BankBulk.pairs(selectedRows))
    }

    /// Links exactly `pairs`, what the preview showed; a pair that changed meanwhile is skipped.
    private func confirmPairs(_ pairs: [BulkMatchPairsBody.Pair]) async {
        guard !pairs.isEmpty, !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        var confirmed = 0
        var skipped = 0
        for chunk in BulkBatch.chunks(pairs, size: BulkBatch.pairsLimit) {
            do {
                let result: BulkMatchConfirmResult = try await app.api.send("POST", "/api/matching/confirm-all", body: BulkMatchPairsBody(pairs: chunk))
                confirmed += result.confirmed + result.alreadyConfirmed
                skipped += result.skipped
            } catch is CancellationError {
                return
            } catch {
                notice = BulkBatch.outcome("Kohdistettiin", done: confirmed, failures: [error.userMessage])
                noticeFailed = true
                Haptics.error()
                if confirmed > 0 { app.dataVersion += 1 }
                return
            }
        }
        // A pair that changed meanwhile is skipped, not linked to something else.
        notice = skipped > 0 ? "Kohdistettiin \(confirmed). \(skipped) ehdotusta oli muuttunut, eikä niitä kohdistettu." : "Kohdistettiin \(confirmed)."
        noticeFailed = skipped > 0
        if skipped > 0 { Haptics.error() } else { Haptics.success() }
        selection.finish(failed: [])
        app.dataVersion += 1
    }

    /// "Hylkää ehdotukset": `POST /api/matching/reject` for each picked suggestion.
    private func rejectSelected() async {
        let rejections = BankBulk.rejections(selectedRows)
        await runEach("Hylättiin", rejections.map(\.transactionId)) { index in
            let _: Ignored = try await app.api.send("POST", "/api/matching/reject", body: rejections[index])
        }
    }

    /// "Ei vaadi kuittia": `POST /api/matching/ignore` for each picked row that can take it.
    private func ignoreSelected() async {
        let rows = BankBulk.ignorable(selectedRows)
        await runEach("Merkittiin", rows.map(\.id)) { index in
            let _: Ignored = try await app.api.send("POST", "/api/matching/ignore", body: BulkIgnoreBody(transactionId: rows[index].id))
        }
    }

    /// One call per row, one after another; what failed stays picked, named by its first reason.
    private func runEach(_ verb: String, _ ids: [String], _ work: (Int) async throws -> Void) async {
        guard !ids.isEmpty, !bulkBusy else { return }
        bulkBusy = true
        defer { bulkBusy = false }
        var failed: [String] = []
        var reasons: [String] = []
        for index in ids.indices {
            do {
                try await work(index)
            } catch is CancellationError {
                return
            } catch {
                failed.append(ids[index])
                reasons.append(error.userMessage)
            }
        }
        let done = ids.count - failed.count
        notice = BulkBatch.outcome(verb, done: done, failures: reasons)
        noticeFailed = !failed.isEmpty
        if failed.isEmpty { Haptics.success() } else { Haptics.error() }
        selection.finish(failed: failed)
        if done > 0 { app.dataVersion += 1 }
    }

    /// Opens the asked-for row once: from the loaded months, else from all months.
    private func openPendingFocus() {
        guard let id = pendingFocus else { return }
        if let row = statements.flatMap({ $0.transactions }).first(where: { $0.id == id }) {
            pendingFocus = nil
            reveal(row)
            selected = row
        } else if paging.hasMore {
            // A later page may hold it: `load()` reads on until it turns up.
            return
        } else if month != nil {
            // Not in this month: look in every month (the month change reloads).
            month = nil
        } else {
            pendingFocus = nil
        }
    }

    /// The focused row stays visible under its sheet: its month's chip, the filter let go if it hides
    /// the row, and the list opened down to it.
    private func reveal(_ row: BankTransaction) {
        guard let months = state.value,
              let group = months.first(where: { $0.rows.contains(where: { $0.id == row.id }) }) else { return }
        if onlyOpen && !BankFeed.needsAction(row) { onlyOpen = false }
        if !search.isEmpty && !row.title.localizedCaseInsensitiveContains(search) { search = "" }
        shownMonth = group.month
        let rows = visibleGroups(months).first(where: { $0.month == group.month })?.rows ?? []
        var next = ShowMore()
        if let index = rows.firstIndex(where: { $0.id == row.id }) { next.expand(toInclude: index, total: rows.count) }
        limit = next
    }

    /// Best effort: without the connections the menu simply has no "Päivitä", and the first row
    /// names the screen it opens instead of a consent.
    private func loadBankLinks() async {
        defer { if !Task.isCancelled { linksLoaded = true } }
        guard let list: BankConnections = try? await app.cachedGet("/api/bank/connections") else { return }
        bankLinks = list.connections
    }

    /// `POST /api/bank/connections/[id]/sync`, told as "Haettiin N tapahtumaa." The balances it
    /// returned show at once and every screen is asked again (BankSyncFlow).
    private func syncBank(_ connection: BankConnection) async {
        guard syncingBank == nil else { return }
        syncingBank = connection.id
        syncWaiting = false
        notice = nil
        defer {
            syncingBank = nil
            syncWaiting = false
        }
        do {
            switch try await BankSyncFlow.run(app, connectionId: connection.id, waiting: { syncWaiting = true }) {
            case .done(let result):
                notice = result.summary
                Haptics.success()
            case .stillRunning:
                notice = BankSyncFlow.stillRunningNotice
            }
            noticeFailed = false
        } catch is CancellationError {
        } catch {
            notice = error.userMessage
            noticeFailed = true
            Haptics.error()
            // A sync that failed may have ended the consent: the reconnect line shows it.
            await loadBankLinks()
        }
    }

    /// "Hyväksy kuittiehdotukset": the pairs the preview listed. With the rows read a page at a time,
    /// "every suggestion of the month" on the server could link rows the owner never saw listed.
    private func confirmAll() async {
        let pairs = BankBulk.pairs(statements.flatMap(\.transactions))
        guard !pairs.isEmpty else {
            notice = "Ei kohdistettavia ehdotuksia."
            noticeFailed = false
            return
        }
        await confirmPairs(pairs)
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

/// What Pankki showed last for one month filter (`AppModel.bankFeedMemory`).
struct BankFeedMemory {
    let statements: [Statement]
    let paging: CursorPaging
}

struct BankRow: View {
    let row: BankTransaction
    var body: some View {
        let state = BankFeed.state(of: row)
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).lineLimitUnlessLarge().foregroundStyle(Theme.ink)
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
    /// Confirm, reject, ignore, approve, unlink: one at a time, a second tap sends nothing.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var capture = false
    @State private var captured = false
    @State private var candidates = ScreenLoad<[BankMatchCandidate]>()
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
                            .scaledFont(size: 30, weight: .bold, design: .rounded, relativeTo: .largeTitle).moneyHero()
                            .foregroundStyle(row.amount > 0 ? Theme.success : Theme.ink)
                    }
                    .listRowBackground(Color.clear)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                Section { actions }
                if purchaseLinkable {
                    Section {
                        // Pushed on this sheet's stack; a confirmed link closes the sheet like the other actions.
                        NavigationLink {
                            PurchaseRowLinkView(row: row) { dismiss() }
                        } label: {
                            Label("Kohdista ostolaskuun", systemImage: "doc.text.magnifyingglass")
                        }
                    } footer: {
                        Text("Maksoiko tämä ostolaskun? Kohdista se laskuun, niin lasku merkitään maksetuksi.")
                    }
                }
                if searchable { candidateSection }
                if showStatementLink {
                    Section {
                        openLink(.statement(row.statementId), "Avaa tiliote", symbol: "doc.plaintext")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
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
                    candidates = ScreenLoad()
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
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ehdotus: \(suggested.vendor ?? "kuitti")").foregroundStyle(Theme.ink2)
                    if let why = BankFeed.matchWhy(row) {
                        Text(why).font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
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
            } else if let purchase = row.paidPurchase {
                Text("Maksu ostolaskulle: \(purchase.supplierName)").foregroundStyle(Theme.ink2)
                openLink(.purchaseInvoice(purchase.id), "Avaa ostolasku", symbol: "doc.text")
                Button(role: .destructive) { Task { await unlinkPurchase(purchase) } } label: {
                    Label("Irrota ostolaskusta", systemImage: "link")
                }
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

    /// "Kohdista ostolaskuun": a payment out that waits for a kuitti, has a suggestion, or was set aside.
    private var purchaseLinkable: Bool {
        let state = BankFeed.state(of: row)
        return (state == .missing || state == .suggested || state == .ignored) && PurchaseBankLink.canLink(row)
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
            if candidates.phase == .idle && candidates.value == nil {
                Button { Task { await loadCandidates() } } label: { Label("Etsi kuitti", systemImage: "magnifyingglass") }
            } else {
                switch candidates.display {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity)
                case .failed(let failure):
                    LoadFailureView(failure: failure, retry: loadCandidates)
                case .content(let list):
                    if let banner = candidates.banner {
                        RefreshFailureBanner(failure: banner, retry: loadCandidates)
                    }
                    if list.isEmpty {
                        Text("Ei sopivia kuitteja. Lisää ensin uusi kuitti Kuitit-näkymässä.").foregroundStyle(Theme.ink2)
                    } else {
                        ForEach(list, id: \.self) { candidate in candidateButton(candidate) }
                    }
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
                    VStack(alignment: .leading, spacing: 2) {
                        Text(BankMatchText.receiptLabel(receipt)).foregroundStyle(Theme.ink).lineLimit(2)
                        if let why = candidate.why {
                            Text(why).font(.caption).foregroundStyle(Theme.ink2).lineLimit(3)
                        }
                    }
                    Spacer()
                    Text("\(candidate.percent) %").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
        }
    }

    private func loadCandidates() async {
        candidates.begin()
        do {
            let response: BankMatchCandidates = try await app.api.get("/api/matching/candidates", query: ["transactionId": row.id])
            candidates.succeed(response.usable)
        } catch {
            // A cancelled load puts the "Etsi kuitti" button back; any other failure is told in Finnish.
            candidates.fail(error)
        }
    }

    private func run(_ work: () async throws -> Void) async {
        guard submit.begin() != nil else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do { try await work(); succeeded = true; Haptics.success(); dismiss() }
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

    /// Removes the purchase payment that holds this row: the invoice reopens if no longer paid, the row is free again.
    private func unlinkPurchase(_ purchase: BankTransaction.PurchaseBrief) async {
        await run {
            let _: Ignored = try await app.api.send(
                "DELETE", "/api/purchase-invoices/\(purchase.id)/payments", query: ["paymentId": purchase.paymentId], body: Optional<EmptyBody>.none
            )
            // The Ostolaskut screens show the invoice open again.
            app.dataVersion += 1
        }
    }

    private func unlink() async {
        struct Body: Encodable { let transactionId: String }
        await run { let _: Ignored = try await app.api.send("POST", "/api/matching/unlink", body: Body(transactionId: row.id)) }
    }
}

/// Before "Hyväksy kuittiehdotukset" links many rows at once: how many, how much money, which
/// ones disagree on the amount. One button confirms them all; Peruuta changes nothing.
private struct ConfirmAllPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let preview: BankFeed.ConfirmPreview
    let confirm: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Kohdistuksia", value: "\(preview.count)")
                    LabeledContent("Pankkitapahtumien summa") { MoneyText(amount: preview.total) }
                    if preview.mismatched > 0 {
                        Text("\(preview.mismatched) ehdotuksessa summa poikkeaa kuitista. Tarkista ne ennen hyväksymistä.")
                            .font(.footnote).foregroundStyle(Theme.warning)
                    }
                }
                Section("Ehdotukset") {
                    ForEach(preview.pairs) { pair in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(pair.counterparty).lineLimit(1)
                                Spacer()
                                MoneyText(amount: pair.amount, signed: true)
                            }
                            Text("→ \(pair.receiptVendor)\(pair.receiptTotal.map { " · " + Money.format($0) } ?? "")")
                                .font(.caption).foregroundStyle(Theme.ink2)
                            if let gap = pair.gap {
                                Text(ReceiptMatchText.gapTitle(gap)).font(.caption).foregroundStyle(Theme.warning)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Hyväksy ehdotukset")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: confirm) {
                    Text("Vahvista \(preview.count) kohdistusta").frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                }
                .buttonStyle(.primary)
                .padding(16)
                .background(Theme.surface)
            }
        }
    }
}
