import SwiftUI
import LashKirjaCore

/// Kuukauden sulkeminen (/kirjanpito/kuukausi) and Suljetut kaudet (/kirjanpito/kaudet):
/// one month's checklist with its close action, and the lock over all months.
struct PeriodsView: View {
    @Environment(AppModel.self) private var app
    @State private var month = PeriodClose.defaultMonth(current: MonthKey.current())
    @State private var status: Loadable<PeriodMonthStatus> = .idle
    @State private var vat: (key: String, facts: PeriodClose.Vat, report: AlvReport)?
    @State private var confirmClose = false
    @State private var closing = false
    @State private var closeError: String?

    @State private var lockedThrough: Loadable<String?> = .idle
    @State private var choice: String??
    @State private var precheck: PeriodPrecheck?
    @State private var checking = false
    @State private var lockError: String?
    @State private var lockNote: String?
    @State private var pendingLock: PendingLock?

    struct PendingLock: Identifiable {
        let id = UUID()
        let month: String?
        let reopen: Bool
        let previous: String?
        let confirmation: PeriodLock.Confirmation
    }

    var body: some View {
        List {
            monthPicker
            if let data = status.value, data.month == month {
                monthSections(data)
            } else {
                LoadState(state: status, retry: loadMonth) { (_: PeriodMonthStatus) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
            lockSections
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Kaudet")
        .refreshable {
            await loadMonth()
            await loadLock()
        }
        .task(id: "\(month)|\(app.dataVersion)") { await loadMonth() }
        .task(id: app.dataVersion) { await loadLock() }
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
                Button { month = MonthKey.shift(month, by: -1) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Edellinen kuukausi")
                Spacer()
                Text("\(MonthKey.name(month)) \(String(month.prefix(4)))").font(.headline)
                Spacer()
                Button { month = MonthKey.shift(month, by: 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(month >= MonthKey.current())
                    .accessibilityLabel("Seuraava kuukausi")
            }
            .buttonStyle(.borderless)
        }
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
                    Image(systemName: "checkmark.circle").font(.system(size: 40)).foregroundStyle(Theme.success)
                    Text(done).font(.headline).foregroundStyle(Theme.ink)
                    Text("Kirjanpitäjä saa kaiken tarvittavan.").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                Text(PeriodClose.subtitle(f)).font(.subheadline).foregroundStyle(Theme.ink2)
            }
        }
        ForEach(PeriodClose.steps(data)) { step in
            Section {
                Label {
                    Text(step.text).foregroundStyle(Theme.ink)
                } icon: {
                    Image(systemName: step.state == .done ? "checkmark.circle.fill" : step.state == .none ? "circle.dashed" : "circle")
                        .foregroundStyle(step.state == .done ? Theme.success : Theme.ink2)
                }
                ForEach(step.items) { item in
                    itemRow(item)
                }
                if step.key == "bank" && !data.hasStatement {
                    NavigationLink(value: Route.bankFeed) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Tuo kuukauden tiliote").foregroundStyle(Theme.ink)
                            Text("Ilman tiliotetta puuttuvia kuitteja ei näe").font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                }
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
                Text(item.party.isEmpty ? "–" : item.party).foregroundStyle(Theme.ink).lineLimit(1)
                Text(PeriodClose.secondary(item)).font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer(minLength: 8)
            if let amount = item.amount {
                MoneyText(amount: item.kind == .missingReceipt || item.kind == .receiptMatch ? abs(amount) : amount)
                    .font(.subheadline)
            }
        }
        if let route = route(for: item) {
            NavigationLink(value: route) { content }
        } else {
            content
        }
    }

    private func route(for item: DashboardItem) -> Route? {
        switch item.kind {
        case .pendingReceipt, .vatGap: item.receiptId.map(Route.receipt)
        case .missingReceipt, .receiptMatch: .bankFeed
        case .invoiceMatch, .paymentDuplicate, .draftInvoice, .overdueInvoice: item.invoiceId.map(Route.invoice)
        case .unknown: nil
        }
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
        do {
            let data: PeriodMonthStatus = try await app.api.get("/api/dashboard/month", query: ["month": key])
            try Task.checkCancellation()
            status = .loaded(data)
            if data.vatRegistered, let period = PeriodClose.vatPeriodEnding(in: key, kind: data.vatPeriod) {
                if let report: AlvReport = try? await app.api.get("/api/alv", query: ["period": period]) {
                    let facts = PeriodClose.vat(filedAt: report.filing?.filedAt, paidAt: report.filing?.paidAt,
                                                amount: report.field308.amount, isRefund: report.field308.isRefund)
                    vat = (period, facts, report)
                }
            } else {
                vat = nil
            }
        } catch is CancellationError {
        } catch {
            status = .failed(error.userMessage)
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
            lockedThrough = .loaded(state.lockedThrough)
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
        switch lockedThrough {
        case .loaded(let current):
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
                precheckSection("Puuttuvat kuitit", precheck.missingDocuments, empty: "Ei puuttuvia kuitteja.",
                                header: "Avoinna ennen lukitusta (\(PeriodLock.formatMonth(precheck.month)))")
                precheckSection("Kohdistamattomat tapahtumat", precheck.unmatchedTransactions, empty: "Ei kohdistettavia tapahtumia.", header: nil)
                precheckSection("Luonnoslaskut", precheck.draftInvoices, empty: "Ei luonnoslaskuja.", header: nil)
            }
        case .failed(let message):
            Section {
                Text("Lukituksen haku epäonnistui").foregroundStyle(Theme.danger)
                Text(message).font(.footnote).foregroundStyle(Theme.ink2)
                Button("Yritä uudelleen") { Task { await loadLock() } }
            } header: {
                Text("Suljetut kaudet")
            }
        case .idle, .loading:
            Section {
                ProgressView().frame(maxWidth: .infinity)
            } header: {
                Text("Suljetut kaudet")
            }
        }
    }

    private func precheckSection(_ title: String, _ items: [PeriodPrecheck.Item], empty: String, header: String?) -> some View {
        Section {
            if items.isEmpty {
                Text(empty).foregroundStyle(Theme.ink2)
            }
            ForEach(items) { item in
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
        } header: {
            VStack(alignment: .leading, spacing: 4) {
                if let header { Text(header).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).textCase(nil) }
                Text(title)
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
            lockedThrough = .loaded(state.lockedThrough)
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
        do {
            let state: PeriodLockState = try await app.api.get("/api/period-lock")
            lockedThrough = .loaded(state.lockedThrough)
        } catch is CancellationError {
        } catch {
            if lockedThrough.value == nil { lockedThrough = .failed(error.userMessage) }
        }
    }
}
