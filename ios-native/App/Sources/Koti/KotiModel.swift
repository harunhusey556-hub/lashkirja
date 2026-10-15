import SwiftUI
import Observation
import LashKirjaCore

@MainActor
@Observable
final class KotiModel {
    private let api: APIClient
    /// The app's cache: Koti paints the last dashboard of the month at once (a cold launch: the
    /// previous run's), then the server's. Nil only where no app is around (previews, tests).
    @ObservationIgnored private weak var app: AppModel?
    /// The owner's profile, kept by AppModel: its ALV-verokausi picks the return the status card names.
    private let profile: () async -> Profile?
    /// The month on screen. A step to another month changes it only when that month's dashboard
    /// is there: the title, the cards and the tasks switch together, never October's tasks under
    /// a September title (motion audit koti-prev-month).
    private(set) var month: String = MonthKey.current()
    /// The month asked for while its dashboard loads.
    private var pendingMonth: String?
    private var targetMonth: String { pendingMonth ?? month }
    private(set) var state = ScreenLoad<Dashboard>()
    /// Rows the owner just acted on: gone from the list at once, back if undone or failed,
    /// and not brought back by a reload while the action is still waiting or on its way.
    private(set) var hidden = KotiHiddenRows()
    /// Failed imports and fetches: Koti shows a "Tuonnit ja virheet" row only while there are some.
    private(set) var failedJobs = 0
    /// The ALV-ilmoitus row: the return due and, once `/api/alv` answers, its figures.
    private(set) var vatDue: KotiVatDue?
    private(set) var vatFigures: VatDueFigures?
    /// Only the latest load writes the screen: stepping months quickly, an older month's
    /// slower answer is dropped.
    private var loads = LoadGeneration()
    var toast: Toast?
    private var pendingCommit: (() async -> Void)?
    private var toastTask: Task<Void, Never>?

    init(api: APIClient, profile: @escaping () async -> Profile?, app: AppModel? = nil) {
        self.api = api
        self.profile = profile
        self.app = app
    }

    var visibleItems: [DashboardItem] { state.value?.items.filter { !hidden.contains($0.id) } ?? [] }
    var atCurrentMonth: Bool { month >= MonthKey.current() }

    func load() async {
        let generation = loads.next()
        let month = self.targetMonth
        let timing = ScreenTiming("Koti")
        let query = ["month": month]
        if state.value?.month != month, let app, let cached: Dashboard = await app.cachedValue("/api/dashboard", query: query),
           loads.isCurrent(generation), month == self.targetMonth {
            show(month, cached)
            timing.painted(fromCache: true)
        }
        state.begin()
        // The job list loads beside the dashboard; it only decides whether the failures row shows.
        let api = self.api
        async let jobsList: JobsList? = try? api.get("/api/jobs")
        async let connections = JobDismissals.connections(api: api)
        do {
            let dashboard: Dashboard
            if let app {
                // Only the current month is kept on disk: it is what a launch opens on.
                dashboard = try await app.cachedGet("/api/dashboard", query: query, persist: month == MonthKey.current())
            } else {
                dashboard = try await api.get("/api/dashboard", query: query)
            }
            guard loads.isCurrent(generation), month == self.targetMonth else { return }
            hidden.reloaded(present: dashboard.items.map(\.id), loadGeneration: generation)
            show(month, dashboard)
            timing.dataReady()
            if let jobs = await jobsList, loads.isCurrent(generation) {
                failedJobs = JobsQueue.failedCount(jobs.jobs, connections: await connections, dismissedLocally: JobDismissals.ids)
            }
            await loadVatDue(dashboard, generation: generation)
        } catch is CancellationError {
            return
        } catch {
            guard loads.isCurrent(generation), month == self.targetMonth else { return }
            // The month asked for is the one whose failure shows.
            if self.month != month {
                self.month = month
                pendingMonth = nil
                state.restart()
            }
            // With a dashboard shown it stays, under a banner saying the refresh failed.
            state.fail(error)
        }
    }

    /// The month and its dashboard in one update.
    private func show(_ month: String, _ dashboard: Dashboard) {
        if self.month != month { self.month = month }
        if pendingMonth == month { pendingMonth = nil }
        state.succeed(dashboard)
    }

    /// The status card's ALV-ilmoitus row (web `useVatDue`): the period from the profile's
    /// verokausi, the figures from `/api/alv`. A failed fetch keeps the row without its state.
    private func loadVatDue(_ dashboard: Dashboard, generation: Int) async {
        let profile = await self.profile()
        let registered = dashboard.vat?.registered ?? profile?.vatRegistered ?? false
        let due = Koti.vatDue(registered: registered, atCurrentMonth: dashboard.month >= MonthKey.current(),
                              month: dashboard.month, today: APIDate.dayString(Date()), kind: profile?.vatPeriod,
                              accountCreatedMonth: dashboard.accountCreatedMonth)
        guard loads.isCurrent(generation) else { return }
        if due?.key != vatDue?.key { vatFigures = nil }
        vatDue = due
        guard let due else { return }
        // Through the app's cache: the ALV screen opens on this return and finds it there.
        let figures: VatDueFigures?
        if let app {
            figures = try? await app.cachedGet("/api/alv", query: ["period": due.key])
        } else {
            figures = try? await api.get("/api/alv", query: ["period": due.key])
        }
        guard loads.isCurrent(generation), vatDue?.key == due.key, let figures else { return }
        vatFigures = figures
    }

    /// A passing message (a reminder sent, a failure) without an undo.
    func say(_ text: String) {
        flushPending()
        withMotion(.snappy) { toast = Toast(text: text, actionLabel: nil) }
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withMotion { self?.toast = nil }
        }
    }

    func step(_ delta: Int) async {
        let next = MonthKey.shift(targetMonth, by: delta)
        guard next <= MonthKey.current() else { return }
        pendingMonth = next
        Haptics.selection()
        await load()
    }

    /// A bar of Tulot ja menot: that month on Koti (the chart's months end at the current one).
    func show(month next: String) async {
        guard next != targetMonth, next <= MonthKey.current() else { return }
        pendingMonth = next
        Haptics.selection()
        await load()
    }

    /// Hyväksy: the row leaves at once; the approval is sent when the toast
    /// closes without "Kumoa" (the web app's undo pattern).
    func approve(_ item: DashboardItem) {
        guard let receiptId = item.receiptId else { return }
        hide(item.id)
        Haptics.success()
        offerUndo("\(item.party) hyväksyttiin", itemId: item.id) { [api] in
            struct Body: Encodable { let reviewStatus = "approved" }
            let _: Ignored = try await api.send("PATCH", "/api/receipts/\(receiptId)/review", body: Body())
        }
    }

    /// Kohdista: books the bank row as the invoice's payment.
    func confirmMatch(_ item: DashboardItem) {
        guard let invoiceId = item.invoiceId, let transactionId = item.transactionId, let amount = item.amount, let paidDate = item.paidDate else { return }
        hide(item.id)
        Haptics.success()
        let key = UUID().uuidString
        offerUndo("Maksu kirjattiin laskulle \(item.number.map(String.init) ?? "")", itemId: item.id) { [api] in
            struct Body: Encodable { let amount: Decimal; let paidDate: String; let transactionId: String }
            let _: Ignored = try await api.send("POST", "/api/invoices/\(invoiceId)/payments",
                                                body: Body(amount: amount, paidDate: paidDate, transactionId: transactionId),
                                                idempotencyKey: key)
        }
    }

    func undo() {
        toastTask?.cancel()
        pendingCommit = nil
        if let id = undoItemId { withMotion { hidden.unhide(id) } }
        undoItemId = nil
        withMotion { toast = nil }
    }

    private var undoItemId: String?

    private func hide(_ id: String) {
        withMotion(.snappy) { hidden.hide(id) }
    }

    private func offerUndo(_ text: String, itemId: String, commit: @escaping () async throws -> Void) {
        flushPending()
        undoItemId = itemId
        pendingCommit = { [weak self] in
            do {
                try await commit()
                await MainActor.run {
                    guard let self else { return }
                    self.hidden.settled(itemId, loadGeneration: self.loads.current)
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    withMotion { self.hidden.unhide(itemId) }
                    self.toast = Toast(text: error.userMessage, actionLabel: nil)
                }
            }
        }
        withMotion(.snappy) { toast = Toast(text: text, actionLabel: "Kumoa") }
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.flushPending()
        }
    }

    /// Sends the waiting action now (a new action, or the toast timing out).
    private func flushPending() {
        toastTask?.cancel()
        guard let commit = pendingCommit else { return }
        pendingCommit = nil
        undoItemId = nil
        withMotion { toast = nil }
        Task { await commit() }
    }
}
