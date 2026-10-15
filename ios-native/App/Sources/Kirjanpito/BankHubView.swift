import SwiftUI
import LashKirjaCore

/// Pankki: balances, the month's money in and out, what needs the owner and the latest rows on
/// one page. Everything else (the row sheets, accounts, statement files) opens through routes.
struct BankHubView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<[Statement]>()
    @State private var position: BankHubPosition?
    @State private var positionFailed = false
    @State private var openRows = 0
    @State private var month = MonthKey.current()
    /// Set once the owner steps the month; until then a load may move it to the latest month with rows.
    @State private var monthChosen = false
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    /// The empty state's buttons: two in one list row need their own taps, so they push here.
    @State private var pushed: Route?
    /// The rows come a page at a time from a server that pages (`?cursor=`); the rest load behind.
    @State private var paging = CursorPaging()
    /// The figures of the previous visit are put on screen once, before the first load.
    @State private var restored = false

    var body: some View {
        List {
            if let statements = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: { await load() }) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                // Unknown balances are not "no bank": the empty state waits for the accounts answer.
                if !positionFailed && !paging.hasMore && BankHub.isEmpty(position, statements: statements) {
                    emptyState
                } else {
                    balanceSection(statements)
                    monthSection(statements)
                    actionSection
                    recentSection(statements)
                }
                links
            } else if case .failed = state.display {
                ScreenStateView(state: state, retry: { await load() }) { (_: [Statement]) in EmptyView() }
                    .listRowBackground(Color.clear)
            } else {
                // The page's shape at once: the balances fill in as soon as they arrive (they load
                // beside the rows), the rows a moment later.
                balanceSection([])
                // The month and the action row too, as placeholders of their real size: without
                // them the page grew by both when the rows arrived.
                Group {
                    monthSection([])
                    actionSection
                }
                .redacted(reason: .placeholder)
                .disabled(true)
                skeletonSection
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Pankki")
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(version: app.refreshEverything())
            await load()
        }
        .task(id: app.dataVersion) {
            await restoreOnce()
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled or failed one must not count as fresh.
            let version = app.dataVersion
            if await load(), !Task.isCancelled { gate.mark(version: version) }
        }
        // The month figures need every row: further pages load behind the first while the hub is open.
        .task(id: paging.nextCursor) { await loadNextPage() }
    }

    // MARK: Sections

    /// Grey rows where the latest rows will be, until the first page arrives.
    private var skeletonSection: some View {
        Section {
            ForEach(0..<5, id: \.self) { _ in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pankkitapahtuma").foregroundStyle(Theme.ink)
                        Text("12.10.2026 · Kohdistettu").font(.caption).foregroundStyle(Theme.ink2)
                    }
                    Spacer()
                    Text("-100,00 €").font(.subheadline.weight(.semibold))
                }
                .redacted(reason: .placeholder)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ladataan tapahtumia")
            }
        } header: {
            Text("Viimeisimmät tapahtumat")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Ei vielä pankkitietoja", systemImage: "building.columns")
        } description: {
            Text("Yhdistä pankki, niin saldot ja tapahtumat tulevat itsestään, tai tuo tiliote tiedostona.")
        } actions: {
            Button("Yhdistä pankki") { pushed = .bankAccounts }
                .buttonStyle(.borderless)
            Button("Tuo tiliote") { pushed = .statements }
                .buttonStyle(.borderless)
        }
        .listRowBackground(Color.clear)
    }

    @ViewBuilder private func balanceSection(_ statements: [Statement]) -> some View {
        Section {
            if let position {
                let lines = BankHub.accountLines(position, statements: statements)
                // A sync's balances show at once, before the accounts are asked again.
                let fresh = app.versions.balances
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saldo yhteensä").font(.caption).foregroundStyle(Theme.ink2)
                    MoneyText(amount: fresh.total(BankHub.total(position), lines: lines.map { (id: $0.id, balance: $0.balance) }))
                        .font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let excluded = position.combined?.excludedCurrencies, !excluded.isEmpty {
                        Text("Ei sisällä tilejä valuutoissa \(excluded.joined(separator: ", "))").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                .padding(.vertical, 4)
                if let notice = BankHub.connectionNotice(position) {
                    NavigationLink(value: Route.bankAccounts) {
                        Label(notice, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Theme.danger)
                    }
                }
                if lines.isEmpty {
                    Text("Ei vielä tilejä. Saldo näkyy, kun yhdistät pankin tai lisäät tilin.").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                ForEach(lines) { line in
                    NavigationLink(value: Route.bankAccounts) { AccountLineRow(line: line, balance: fresh.balance(line.id, shown: line.balance)) }
                }
            } else if positionFailed {
                Text("Saldoja ei saatu ladattua.").foregroundStyle(Theme.ink2)
                Button("Yritä uudelleen") { Task { await load() } }
            } else {
                // The figures' own shape while they load (a total and one account), not a spinner
                // row a third of their height: the sections below stayed put only in the spinner's
                // place and jumped when the balances came (motion audit pankki-hub-open).
                Group {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Saldo yhteensä").font(.caption)
                        Text("0 000,00 €").font(.title2.weight(.semibold))
                    }
                    .padding(.vertical, 4)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Käyttötili")
                        Text("Pankki · päivitetty 1.1.2026").font(.caption)
                        Text("0 000,00 €").font(.subheadline.weight(.semibold))
                    }
                }
                .redacted(reason: .placeholder)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ladataan saldoja")
            }
        } header: {
            HStack {
                Text("Saldot")
                Spacer()
                // Figures from the previous visit stay while fresh ones load; it says so.
                if state.isRefreshing {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("Päivitetään…")
                    }
                }
            }
        }
    }

    private func monthSection(_ statements: [Statement]) -> some View {
        let totals = BankHub.totals(statements, month: month)
        let oldest = BankHub.oldestMonth(statements)
        return Section {
            HStack {
                Button { step(-1) } label: { Image(systemName: "chevron.left").tapTarget() }
                    .disabled(!BankHub.canStepBack(month, oldest: oldest))
                    .accessibilityLabel("Edellinen kuukausi")
                Spacer()
                Text(StatementText.month(month)).font(.headline)
                Spacer()
                Button { step(1) } label: { Image(systemName: "chevron.right").tapTarget() }
                    .disabled(!BankHub.canStepForward(month))
                    .accessibilityLabel("Seuraava kuukausi")
            }
            .buttonStyle(.borderless)
            NavigationLink(value: Route.bankFeedFiltered(month: month, onlyOpen: false, focus: nil)) {
                VStack(alignment: .leading, spacing: 8) {
                    // Three columns while they fit; at large text sizes or long amounts, one per line.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) {
                            figure("Tulot", totals.income, color: Theme.success)
                            Spacer()
                            figure("Menot", totals.expenses, color: Theme.ink)
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("Netto").font(.caption).foregroundStyle(Theme.ink2)
                                MoneyText(amount: totals.net, signed: true)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(totals.net > 0 ? Theme.success : Theme.ink)
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            LabeledContent("Tulot") { MoneyText(amount: totals.income).foregroundStyle(Theme.success) }
                            LabeledContent("Menot") { MoneyText(amount: totals.expenses) }
                            LabeledContent("Netto") {
                                MoneyText(amount: totals.net, signed: true)
                                    .foregroundStyle(totals.net > 0 ? Theme.success : Theme.ink)
                            }
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                    Text(totals.count == 0 ? "Ei tapahtumia tässä kuussa" : "\(totals.count) tapahtumaa")
                        .font(.caption)
                        .foregroundStyle(Theme.ink2)
                }
                .padding(.vertical, 2)
            }
            // Own transfers and salaries are outside Tulot and Menot, as on the tiliote.
            if totals.transfers != 0 {
                NavigationLink(value: Route.bankFeedFiltered(month: month, onlyOpen: false, focus: nil)) {
                    LabeledContent("Siirrot ja palkat") { MoneyText(amount: totals.transfers, signed: true) }
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink2)
                }
            }
        } header: {
            Text("Kuukausi")
        }
    }

    private var actionSection: some View {
        Section {
            NavigationLink(value: Route.bankFeedFiltered(month: nil, onlyOpen: true, focus: nil)) {
                HStack {
                    HubRow(
                        title: "Vaatii toimia",
                        subtitle: openRows > 0 ? "Tapahtumat, joilta puuttuu kuitti tai kohdistus" : "Kaikki tapahtumat on käsitelty",
                        symbol: openRows > 0 ? "exclamationmark.circle" : "checkmark.circle"
                    )
                    Spacer()
                    if openRows > 0 {
                        Text("\(openRows)").font(.headline).monospacedDigit().foregroundStyle(Theme.accent)
                    }
                }
            }
        }
    }

    private func recentSection(_ statements: [Statement]) -> some View {
        // The hub orients and hands over: filtering belongs to Pankkitapahtumat ("Näytä kaikki").
        let rows = BankHub.recent(statements, filter: .all, limit: 5)
        return Section {
            if rows.isEmpty {
                Text("Ei tapahtumia.").foregroundStyle(Theme.ink2)
            }
            ForEach(rows) { recent in
                // Opens the feed on the row's month with its sheet up, so Back lands in the feed.
                NavigationLink(value: Route.bankFeedFiltered(month: recent.month.isEmpty ? nil : recent.month, onlyOpen: false, focus: recent.id)) {
                    BankRow(row: recent.row)
                }
            }
            NavigationLink(value: Route.bankFeed) {
                Text("Näytä kaikki").foregroundStyle(Theme.accent)
            }
        } header: {
            Text("Viimeisimmät tapahtumat")
        }
    }

    private var links: some View {
        Section {
            NavigationLink(value: Route.statements) {
                HubRow(title: "Tiliotteet", subtitle: "Tuo tiliote ja selaa tiedostoja", symbol: "doc.plaintext")
            }
            NavigationLink(value: Route.bankAccounts) {
                HubRow(title: "Pankkiyhteys ja tilit", subtitle: "Tilit, saldot ja pankkiyhteys", symbol: "building.columns")
            }
        }
    }

    private func figure(_ title: String, _ amount: Decimal, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(Theme.ink2)
            MoneyText(amount: amount).font(.subheadline.weight(.semibold)).foregroundStyle(color)
        }
    }

    private func step(_ by: Int) {
        monthChosen = true
        month = MonthKey.shift(month, by: by)
        Haptics.selection()
    }

    // MARK: Loading

    /// The previous visit's figures, shown at once; the first load then refreshes them behind.
    /// On the first visit after a launch they come from the cache (prefetched, or the previous
    /// run's from disk).
    private func restoreOnce() async {
        guard !restored else { return }
        restored = true
        guard state.value == nil else { return }
        if let memory = app.bankHubMemory {
            state.succeed(memory.statements)
            position = memory.position
            openRows = memory.openRows
            paging = memory.paging
            if !monthChosen { month = BankHub.startMonth(memory.statements) }
            return
        }
        guard let list: StatementList = await app.cachedValue("/api/statements"), state.value == nil else { return }
        let cachedPosition: BankHubPosition? = await app.cachedValue("/api/bank-accounts")
        let cachedCount: StatementOpenCount? = await app.cachedValue("/api/statements/counts")
        guard state.value == nil else { return }
        state.succeed(list.statements)
        if position == nil { position = cachedPosition }
        openRows = cachedCount?.open ?? BankFeed.months(list.statements).reduce(0) { $0 + $1.open }
        paging.firstPage(next: list.nextCursor)
        if !monthChosen { month = BankHub.startMonth(list.statements) }
    }

    private func remember() {
        guard let statements = state.value else { return }
        app.bankHubMemory = BankHubMemory(statements: statements, position: position, openRows: openRows, paging: paging)
    }

    /// The rows, the balances and the open count load side by side; only the rows are required.
    /// The balances go on screen as soon as they arrive. Returns whether the rows loaded.
    @discardableResult
    private func load() async -> Bool {
        let timing = ScreenTiming("Pankki")
        state.begin()
        let app = self.app
        let startedAt = Date()
        // Through the app's cache: a launch prefetched them, and an unchanged visit asks nothing.
        async let listResult = Result<StatementList, Error>(asyncCatching: { try await app.cachedGet("/api/statements", persist: true) })
        async let positionResult = Result<BankHubPosition, Error>(asyncCatching: { try await app.cachedGet("/api/bank-accounts", persist: true) })
        async let countResult: StatementOpenCount? = try? app.cachedGet("/api/statements/counts", persist: true)
        let balances = await positionResult
        if Task.isCancelled { return false }
        switch balances {
        case .success(let value):
            position = value
            positionFailed = false
            app.versions.settleBalances(loadStartedAt: startedAt)
        case .failure(let error):
            // A stale figure stays on screen; only a first failure shows the retry.
            if !(error is CancellationError) && position == nil { positionFailed = true }
        }
        let (list, count) = await (listResult, countResult)
        if Task.isCancelled { return false }
        switch list {
        case .success(let value):
            state.succeed(value.statements)
            paging.firstPage(next: value.nextCursor)
            if !monthChosen { month = BankHub.startMonth(value.statements) }
            // A server without the count route: counted from the rows, as Kirjanpito does.
            openRows = count?.open ?? BankFeed.months(value.statements).reduce(0) { $0 + $1.open }
            remember()
            timing.dataReady()
            return true
        case .failure(let error):
            if error is CancellationError { return false }
            state.fail(error)
            return false
        }
    }

    /// The page after the loaded rows, merged in (a row is never shown twice). A failure leaves
    /// the rows shown; the next load starts the paging again.
    private func loadNextPage() async {
        guard state.value != nil, let cursor = paging.nextCursor, let query = paging.nextQuery() else { return }
        guard let page: StatementList = try? await app.api.get("/api/statements", query: query),
              !Task.isCancelled, paging.nextCursor == cursor else { return }
        state.update { $0 = StatementPaging.merge($0, page.statements) }
        paging.nextPage(next: page.nextCursor)
        if !monthChosen, let rows = state.value { month = BankHub.startMonth(rows) }
        remember()
    }
}

/// What the hub showed last (`AppModel.bankHubMemory`).
struct BankHubMemory {
    let statements: [Statement]
    let position: BankHubPosition?
    let openRows: Int
    let paging: CursorPaging
}

/// One account on the balance card: name, bank and when the balance is from, and the balance.
private struct AccountLineRow: View {
    let line: BankHub.AccountLine
    /// The line's balance, or the one a sync just returned.
    let balance: Decimal?

    var body: some View {
        // Name and balance side by side while they fit; the balance moves under the name otherwise.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) { description; Spacer(); amount }
            VStack(alignment: .leading, spacing: 4) { description; amount }
        }
        .padding(.vertical, 2)
    }

    private var description: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(line.name).foregroundStyle(Theme.ink).lineLimitUnlessLarge()
            let detail = [line.bank, line.asOf].compactMap { $0 }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(Theme.ink2).lineLimit(2)
            }
            if line.needsCheck {
                Text("Saldo vaatii tarkistusta").font(.caption).foregroundStyle(Theme.danger)
            }
        }
    }

    @ViewBuilder private var amount: some View {
        if let balance {
            MoneyText(amount: balance).foregroundStyle(Theme.ink)
        } else {
            Text("–").foregroundStyle(Theme.ink2)
        }
    }
}
