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
    @State private var filter: BankHub.Filter = .all
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    /// The empty state's buttons: two in one list row need their own taps, so they push here.
    @State private var pushed: Route?

    var body: some View {
        List {
            if let statements = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: { await load() }) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                // Unknown balances are not "no bank": the empty state waits for the accounts answer.
                if !positionFailed && BankHub.isEmpty(position, statements: statements) {
                    emptyState
                } else {
                    balanceSection(statements)
                    monthSection(statements)
                    actionSection
                    recentSection(statements)
                }
                links
            } else {
                ScreenStateView(state: state, retry: { await load() }) { (_: [Statement]) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Pankki")
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled or failed one must not count as fresh.
            let version = app.dataVersion
            if await load(), !Task.isCancelled { gate.mark(version: version) }
        }
    }

    // MARK: Sections

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
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saldo yhteensä").font(.caption).foregroundStyle(Theme.ink2)
                    MoneyText(amount: BankHub.total(position)).font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
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
                let lines = BankHub.accountLines(position, statements: statements)
                if lines.isEmpty {
                    Text("Ei vielä tilejä. Saldo näkyy, kun yhdistät pankin tai lisäät tilin.").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                ForEach(lines) { line in
                    NavigationLink(value: Route.bankAccounts) { AccountLineRow(line: line) }
                }
            } else if positionFailed {
                Text("Saldoja ei saatu ladattua.").foregroundStyle(Theme.ink2)
                Button("Yritä uudelleen") { Task { await load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            Text("Saldot")
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
        let rows = BankHub.recent(statements, filter: filter)
        return Section {
            chips
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
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

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(BankHub.Filter.allCases) { chip in
                    let selected = chip == filter
                    Button {
                        filter = chip
                        Haptics.selection()
                    } label: {
                        Text(chip.title)
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

    /// The rows, the balances and the open count load side by side; only the rows are required.
    /// Returns whether the rows loaded.
    @discardableResult
    private func load() async -> Bool {
        state.begin()
        let api = app.api
        async let listResult = Result<StatementList, Error>(asyncCatching: { try await api.get("/api/statements") })
        async let positionResult = Result<BankHubPosition, Error>(asyncCatching: { try await api.get("/api/bank-accounts") })
        async let countResult: StatementOpenCount? = try? api.get("/api/statements/counts")
        let (list, balances, count) = await (listResult, positionResult, countResult)
        if Task.isCancelled { return false }
        switch balances {
        case .success(let value):
            position = value
            positionFailed = false
        case .failure(let error):
            // A stale figure stays on screen; only a first failure shows the retry.
            if !(error is CancellationError) && position == nil { positionFailed = true }
        }
        switch list {
        case .success(let value):
            state.succeed(value.statements)
            if !monthChosen { month = BankHub.startMonth(value.statements) }
            // A server without the count route: counted from the rows, as Kirjanpito does.
            openRows = count?.open ?? BankFeed.months(value.statements).reduce(0) { $0 + $1.open }
            return true
        case .failure(let error):
            if error is CancellationError { return false }
            state.fail(error)
            return false
        }
    }
}

/// One account on the balance card: name, bank and when the balance is from, and the balance.
private struct AccountLineRow: View {
    let line: BankHub.AccountLine

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
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
            Spacer()
            if let balance = line.balance {
                MoneyText(amount: balance).foregroundStyle(Theme.ink)
            } else {
                Text("–").foregroundStyle(Theme.ink2)
            }
        }
        .padding(.vertical, 2)
    }
}
