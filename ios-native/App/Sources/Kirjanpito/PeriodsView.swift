import SwiftUI
import LashKirjaCore

/// Kuukauden sulkeminen (/kirjanpito/kuukausi) and Suljetut kaudet (/kirjanpito/kaudet):
/// one month's checklist with its close action, and the lock over all months.
struct PeriodsView: View {
    @Environment(AppModel.self) private var app
    @State private var month: String
    @State private var status = ScreenLoad<PeriodMonthStatus>()
    @State private var vat: (key: String, facts: PeriodClose.Vat, report: AlvReport)?
    @State private var confirmClose = false
    @State private var closing = false
    @State private var closeError: String?

    @State private var lockedThrough = ScreenLoad<PeriodLockState>()
    @State private var choice: String??
    @State private var precheck: PeriodPrecheck?
    @State private var checking = false
    @State private var lockError: String?
    @State private var lockNote: String?
    @State private var pendingLock: PendingLock?
    /// The checklist step whose rows are on screen (one at a time); nil = the first one still open.
    @State private var stepKey: String?
    @State private var stepLimit = ShowMore()
    /// The precheck list on screen (Puuttuvat kuitit / Kohdistamattomat / Luonnoslaskut).
    @State private var precheckKind: String?
    @State private var precheckLimit = ShowMore()
    /// The bank row a receipt is being photographed for (a row's "Kuvaa kuitti").
    @State private var captureFor: CaptureTarget?
    /// A row's "Täydennä": the receipt to complete, pushed over this screen.
    @State private var pushed: Route?

    struct CaptureTarget: Identifiable { let id = UUID(); let transactionId: String? }

    struct PendingLock: Identifiable {
        let id = UUID()
        let month: String?
        let reopen: Bool
        let previous: String?
        let confirmation: PeriodLock.Confirmation
    }

    /// `month` opens the checklist on that month (Koti's status card); none opens on last month.
    init(month: String? = nil) {
        _month = State(initialValue: PeriodClose.startMonth(month, current: MonthKey.current()))
    }

    var body: some View {
        List {
            monthPicker
            if let data = status.value, data.month == month {
                if let banner = status.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: loadMonth) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                monthSections(data)
            } else {
                ScreenStateView(state: status, retry: loadMonth) { (_: PeriodMonthStatus) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
            lockSections
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kuukauden sulku")
        .refreshable {
            await loadMonth()
            await loadLock()
        }
        .task(id: "\(month)|\(app.dataVersion)") { await loadMonth() }
        .task(id: app.dataVersion) { await loadLock() }
        .fullScreenCover(item: $captureFor, onDismiss: { Task { await loadMonth() } }) { target in
            CaptureFlow(transactionId: target.transactionId)
        }
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
        .alert(closeTitle, isPresented: $confirmClose) {
            Button("Merkitse valmiiksi") { Task { await closeMonth() } }
            Button("Peru", role: .cancel) {}
        } message: {
            Text(closeMessage)
        }
        .alert(pendingLock?.confirmation.title ?? "", isPresented: Binding(get: { pendingLock != nil }, set: { if !$0 { pendingLock = nil } }), presenting: pendingLock) { pending in
            Button(pending.confirmation.action, role: pending.confirmation.destructive ? .destructive : nil) {
                Task { await commit(pending) }
            }
            Button("Peru", role: .cancel) {}
        } message: { pending in
            Text(pending.confirmation.message)
        }
    }

    // MARK: Month close

    private var monthPicker: some View {
        Section {
            HStack {
                Button { changeMonth(by: -1) } label: { Image(systemName: "chevron.left").tapTarget() }
                    .accessibilityLabel("Edellinen kuukausi")
                Spacer()
                Text("\(MonthKey.name(month)) \(String(month.prefix(4)))").font(.headline)
                Spacer()
                Button { changeMonth(by: 1) } label: { Image(systemName: "chevron.right").tapTarget() }
                    .disabled(month >= MonthKey.current())
                    .accessibilityLabel("Seuraava kuukausi")
            }
            .buttonStyle(.borderless)
        }
    }

    private func changeMonth(by delta: Int) {
        month = MonthKey.shift(month, by: delta)
        stepKey = nil
        stepLimit.reset()
    }

    /// A row of chips that shows one list at a time.
    private struct ChipOption: Identifiable {
        let id: String
        let title: String
        let count: Int
    }

    private func chipRow(_ options: [ChipOption], selected: String, pick: @escaping (String) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(options) { option in
                    SectionChip(title: option.title, count: option.count, selected: option.id == selected) { pick(option.id) }
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    private func facts(_ data: PeriodMonthStatus) -> PeriodClose.Facts {
        PeriodClose.Facts(ended: data.ended, locked: data.locked, blocking: data.blockingTotal,
                          hasContent: data.hasContent, hasStatement: data.hasStatement,
                          vat: vat?.key == PeriodClose.vatPeriodEnding(in: data.month, kind: data.vatPeriod) ? vat?.facts : nil)
    }

    @ViewBuilder private func monthSections(_ data: PeriodMonthStatus) -> some View {
        let f = facts(data)
        Section {
            if PeriodClose.complete(f) {
                let done = "\(MonthKey.name(data.month)) on valmis."
                VStack(spacing: 6) {
                    Image(systemName: "checkmark.circle").scaledFont(size: 40, relativeTo: .largeTitle).foregroundStyle(Theme.success).accessibilityHidden(true)
                    Text(done).font(.headline).foregroundStyle(Theme.ink)
                    Text("Kirjanpitäjä saa kaiken tarvittavan.").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                NavigationLink(value: Route.reports) {
                    Label("Lataa kirjanpitopaketti", systemImage: "arrow.down.doc")
                }
            } else {
                Text(PeriodClose.subtitle(f)).font(.subheadline).foregroundStyle(Theme.ink2)
            }
        }
        // The steps as one short checklist; the rows of one step at a time below it, picked by chip,
        // instead of every step's rows stacked.
        let steps = PeriodClose.steps(data)
        Section {
            ForEach(steps) { step in
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.title).foregroundStyle(Theme.ink)
                        Text(step.text).font(.caption).foregroundStyle(Theme.ink2)
                    }
                } icon: {
                    Image(systemName: step.state == .done ? "checkmark.circle.fill" : step.state == .none ? "circle.dashed" : "circle")
                        .foregroundStyle(step.state == .done ? Theme.success : Theme.ink2)
                        .accessibilityLabel(step.state == .done ? "Valmis" : "Kesken")
                }
            }
            if !data.hasStatement && steps.contains(where: { $0.key == "bank" }) {
                NavigationLink(value: Route.statements) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tuo kuukauden tiliote").foregroundStyle(Theme.ink)
                        Text("Ilman tiliotetta puuttuvia kuitteja ei näe").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
            }
        } header: {
            Text("Tarkistuslista")
        }
        let withRows = steps.filter { !$0.items.isEmpty }
        if let key = GroupChoice.pick(stepKey, available: withRows.map(\.key), preferred: withRows.first(where: { $0.state == .open })?.key),
           let step = withRows.first(where: { $0.key == key }) {
            Section {
                if withRows.count > 1 {
                    chipRow(withRows.map { ChipOption(id: $0.key, title: $0.title, count: $0.items.count) }, selected: key) { picked in
                        stepKey = picked
                        stepLimit.reset()
                    }
                }
                ForEach(step.items.prefix(stepLimit.visible(step.items.count))) { item in
                    itemRow(item)
                }
                ShowMoreButton(limit: $stepLimit, total: step.items.count)
            } header: {
                Text(step.title)
            }
        }
        if let key = PeriodClose.vatPeriodEnding(in: data.month, kind: data.vatPeriod), data.vatRegistered {
            Section {
                NavigationLink(value: Route.alv(key)) {
                    HStack {
                        Image(systemName: f.vat?.done == true ? "checkmark.circle.fill" : "percent")
                            .foregroundStyle(f.vat?.done == true ? Theme.success : Theme.accent)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("ALV-ilmoitus").foregroundStyle(Theme.ink)
                            Text(vatLine(f.vat)).font(.caption).foregroundStyle(Theme.ink2)
                        }
                        Spacer()
                        if let report = vat?.report, vat?.key == key {
                            MoneyText(amount: report.field308.amount).font(.subheadline)
                        }
                    }
                }
                if f.vat?.changedSinceFiling == true, let report = vat?.report, let filed = report.filing?.filedAmount {
                    // F66: the figures moved after filing; the return may need correcting.
                    Label(PeriodClose.vatChangedNote(filedAmount: filed, amount: report.field308.amount, isRefund: report.field308.isRefund),
                          systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Theme.warning)
                }
            } header: {
                Text("ALV")
            } footer: {
                if f.vat?.done != true { Text("Ilmoita ja maksa OmaVerossa. Ohjeet ja merkintä ALV-sivulla.") }
            }
        }
        Section {
            if data.locked {
                Text("Suljetun kuukauden kuitteja, laskuja ja tapahtumia ei voi muuttaa.")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
            } else {
                Button {
                    closeError = nil
                    confirmClose = true
                } label: {
                    ZStack {
                        Text("Merkitse \(MonthKey.name(data.month).lowercased()) valmiiksi").opacity(closing ? 0 : 1)
                        if closing { ProgressView().tint(Theme.onInk) }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(closing || PeriodClose.button(f) != nil)
                .listRowBackground(Color.clear)
            }
        } footer: {
            if let closeError {
                Text(closeError).foregroundStyle(Theme.danger)
            } else if !data.locked, let reason = PeriodClose.button(f) {
                Text(reason)
            }
        }
    }

    @ViewBuilder private func itemRow(_ item: DashboardItem) -> some View {
        let content = HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.party.isEmpty ? "–" : item.party).foregroundStyle(Theme.ink).lineLimitUnlessLarge()
                Text(PeriodClose.secondary(item)).font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let amount = item.amount {
                    MoneyText(amount: item.kind == .missingReceipt || item.kind == .receiptMatch ? abs(amount) : amount)
                        .font(.subheadline)
                }
                rowAction(item)
            }
        }
        if let route = route(for: item) {
            NavigationLink(value: route) { content }
        } else {
            content
        }
    }

    /// The row's own action, as on the web: photograph the missing receipt, or complete the
    /// receipt's VAT breakdown. Borderless, so it is its own tap target inside the row's link.
    @ViewBuilder private func rowAction(_ item: DashboardItem) -> some View {
        switch item.kind {
        case .missingReceipt where item.transactionId != nil:
            pill("Kuvaa kuitti", label: "Kuvaa kuitti: \(item.party)") { captureFor = CaptureTarget(transactionId: item.transactionId) }
        case .vatGap:
            if let id = item.receiptId {
                pill("Täydennä", label: "Täydennä: \(item.party)") { pushed = .receipt(id) }
            }
        default:
            EmptyView()
        }
    }

    private func pill(_ title: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 5)
                .foregroundStyle(Theme.onInk)
                .background(Theme.ink, in: Capsule())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    /// The row's own screen: a missing receipt opens that bank row, not the whole feed.
    private func route(for item: DashboardItem) -> Route? {
        Route.forItem(item, month: status.value?.month)
    }

    private func vatLine(_ vat: PeriodClose.Vat?) -> String {
        guard let vat else { return "Tarkista ALV-sivulla" }
        switch vat.state {
        case .paid: return "Maksettu"
        case .filed: return vat.nothingToPay ? "Ilmoitettu" : "Ilmoitettu · maksamatta"
        case .open: return "Ilmoittamatta"
        }
    }

    private var closeTitle: String { "Merkitäänkö \(MonthKey.name(month).lowercased()) valmiiksi?" }

    private var closeMessage: String {
        guard let data = status.value else { return "" }
        let earlierOpen = (data.lockedThrough ?? "") < MonthKey.shift(data.month, by: -1)
        return PeriodClose.confirmMessage(facts(data), earlierOpen: earlierOpen)
    }

    private func loadMonth() async {
        let key = month
        // Another month's figures must not stay under this month's heading while it loads.
        if status.value?.month != key { status.restart() }
        status.begin()
        do {
            let data: PeriodMonthStatus = try await app.api.get("/api/dashboard/month", query: ["month": key])
            try Task.checkCancellation()
            status.succeed(data)
            if data.vatRegistered, let period = PeriodClose.vatPeriodEnding(in: key, kind: data.vatPeriod) {
                if let report: AlvReport = try? await app.api.get("/api/alv", query: ["period": period]) {
                    let facts = PeriodClose.vat(filedAt: report.filing?.filedAt, paidAt: report.filing?.paidAt,
                                                filedAmount: report.filing?.filedAmount,
                                                amount: report.field308.amount, isRefund: report.field308.isRefund)
                    vat = (period, facts, report)
                }
            } else {
                vat = nil
            }
        } catch is CancellationError {
        } catch {
            status.fail(error)
        }
    }

    private func closeMonth() async {
        guard let data = status.value, !closing else { return }
        closing = true
        defer { closing = false }
        do {
            let state: PeriodLockState = try await app.api.send("PUT", "/api/period-lock",
                body: PeriodLockBody(month: data.month, reopen: false, expectedLockedThrough: data.lockedThrough))
            Haptics.success()
            lockedThrough.succeed(state)
            lockNote = "\(MonthKey.name(data.month)) on merkitty valmiiksi."
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            Haptics.error()
            closeError = error.userMessage
            // The screen may be showing an old lock; load the real one again.
            await loadMonth()
            await loadLock()
        }
    }

    // MARK: Lock

    @ViewBuilder private var lockSections: some View {
        switch lockedThrough.display {
        case .content(let lock):
            let current = lock.lockedThrough
            let selected: String? = choice ?? current
            let change = PeriodLock.change(current: current, selected: selected)
            let acknowledged = selected != nil && precheck?.month == selected && (precheck?.count ?? 0) > 0
            Section {
                Text(current.map { "Lukittu \(PeriodLock.formatMonth($0)) asti" } ?? "Kaikki kaudet ovat auki")
                    .font(.headline)
                    .foregroundStyle(Theme.ink)
                Picker("Lukitse asti", selection: Binding<String?>(get: { selected }, set: { choice = .some($0); precheck = nil; lockError = nil })) {
                    Text("Ei lukitusta").tag(String?.none)
                    ForEach(PeriodLock.options(current: MonthKey.current(), lockedThrough: current), id: \.self) { option in
                        Text(PeriodLock.formatMonth(option)).tag(String?.some(option))
                    }
                }
                Button {
                    Task { await requestLock(current: current, selected: selected, change: change, acknowledged: acknowledged) }
                } label: {
                    HStack {
                        Text(checking ? "Tarkistetaan…" : selected == nil ? "Poista lukitus" : change == .reopen ? "Avaa kaudet" : acknowledged ? "Lukitse silti" : "Lukitse")
                        if checking { Spacer(); ProgressView() }
                    }
                }
                .disabled(change == .none || checking)
                if current != nil && change == .none {
                    Button("Avaa kirjanpito uudelleen", role: .destructive) {
                        ask(month: nil, reopen: true, current: current)
                    }
                }
            } header: {
                Text("Suljetut kaudet")
            } footer: {
                if let lockError {
                    Text(lockError).foregroundStyle(Theme.danger)
                } else if let lockNote {
                    Text(lockNote).foregroundStyle(Theme.success)
                } else {
                    Text("Valittu kuukausi ja sitä vanhemmat lukitaan. Lukittuja kuukausia ei voi muuttaa.")
                }
            }
            if let precheck, precheck.count > 0 {
                precheckSection(precheck)
            }
            if let banner = lockedThrough.banner {
                Section { RefreshFailureBanner(failure: banner, retry: loadLock) }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
        case .failed(let failure):
            Section {
                LoadFailureView(failure: failure, retry: loadLock)
                    .listRowBackground(Color.clear)
            } header: {
                Text("Suljetut kaudet")
            }
        case .loading:
            Section {
                ProgressView().frame(maxWidth: .infinity)
            } header: {
                Text("Suljetut kaudet")
            }
        }
    }

    /// What is still open before the lock, one list at a time (only the lists that have rows).
    @ViewBuilder private func precheckSection(_ precheck: PeriodPrecheck) -> some View {
        let all: [(key: String, title: String, items: [PeriodPrecheck.Item])] = [
            ("missing", "Puuttuvat kuitit", precheck.missingDocuments),
            ("unmatched", "Kohdistamattomat tapahtumat", precheck.unmatchedTransactions),
            ("drafts", "Luonnoslaskut", precheck.draftInvoices),
        ]
        let lists = all.filter { !$0.items.isEmpty }
        if let key = GroupChoice.pick(precheckKind, available: lists.map { $0.key }),
           let list = lists.first(where: { $0.key == key }) {
            let items = list.items
            Section {
                if lists.count > 1 {
                    chipRow(lists.map { ChipOption(id: $0.key, title: $0.title, count: $0.items.count) }, selected: key) { picked in
                        precheckKind = picked
                        precheckLimit.reset()
                    }
                }
                ForEach(items.prefix(precheckLimit.visible(items.count))) { item in
                    let label = VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).foregroundStyle(Theme.ink)
                        Text(item.detail).font(.caption).foregroundStyle(Theme.ink2)
                    }
                    if let route = Route.fromHref(item.href) {
                        NavigationLink(value: route) { label }
                    } else {
                        label
                    }
                }
                ShowMoreButton(limit: $precheckLimit, total: items.count)
            } header: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Avoinna ennen lukitusta (\(PeriodLock.formatMonth(precheck.month)))")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).textCase(nil)
                    Text(list.title)
                }
            }
        }
    }

    private func ask(month: String?, reopen: Bool, current: String?) {
        let range = reopen ? current.map { PeriodLock.reopenedRange(selected: month, lockedThrough: $0) } : nil
        pendingLock = PendingLock(month: month, reopen: reopen, previous: current,
                                  confirmation: PeriodLock.confirmation(month: month, reopen: reopen, range: range))
    }

    /// Lock: list what is still open first; a clean month goes straight to the confirm.
    private func requestLock(current: String?, selected: String?, change: PeriodLock.Change, acknowledged: Bool) async {
        lockNote = nil
        guard let selected else { ask(month: nil, reopen: true, current: current); return }
        if change == .reopen { ask(month: selected, reopen: true, current: current); return }
        if acknowledged { ask(month: selected, reopen: false, current: current); return }
        checking = true
        lockError = nil
        defer { checking = false }
        do {
            let listed: PeriodPrecheck = try await app.api.get("/api/period-lock/precheck", query: ["month": selected])
            precheck = listed
            precheckKind = nil
            precheckLimit.reset()
            if listed.count == 0 { ask(month: selected, reopen: false, current: current) }
        } catch is CancellationError {
        } catch {
            lockError = error.userMessage
        }
    }

    private func commit(_ pending: PendingLock) async {
        do {
            let state: PeriodLockState = try await app.api.send("PUT", "/api/period-lock",
                body: PeriodLockBody(month: pending.month, reopen: pending.reopen, expectedLockedThrough: pending.previous))
            Haptics.success()
            lockedThrough.succeed(state)
            choice = nil
            precheck = nil
            lockError = nil
            lockNote = PeriodLock.toast(previous: pending.previous, now: state.lockedThrough, reopen: pending.reopen)
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            Haptics.error()
            lockError = error.userMessage
            // Show the real lock, whatever the refusal was.
            await loadLock()
        }
    }

    private func loadLock() async {
        lockedThrough.begin()
        do {
            let state: PeriodLockState = try await app.api.get("/api/period-lock")
            lockedThrough.succeed(state)
        } catch is CancellationError {
        } catch {
            lockedThrough.fail(error)
        }
    }
}
