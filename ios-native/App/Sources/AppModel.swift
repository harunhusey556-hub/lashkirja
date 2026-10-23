import SwiftUI
import Observation
import LashKirjaCore

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut(notice: String?)
        case signedIn(AuthUser)
    }

    private(set) var phase: Phase = .launching
    /// The one record of how fresh the screens are: bumped by every write the server accepted,
    /// every pull-to-refresh, coming back to the app, and `/api/sync/version` answering
    /// differently than before (polled every 30 s in the foreground).
    let versions = DataVersionStore()
    /// What the screens that show money reload on (`.task(id: app.dataVersion)` + `ReloadGate`).
    /// Every caller writes `dataVersion += 1`: any write is one bump of `versions`.
    var dataVersion: Int {
        get { versions.version }
        set { versions.bump() }
    }
    /// The last loaded Pankki rows per month filter ("" = every month), kept across visits: coming
    /// back shows them at once while they refresh behind (Pankki is a pushed screen, so its own
    /// state goes with it).
    var bankFeedMemory: [String: BankFeedMemory] = [:]
    /// Every screen's GET answers: a screen paints the cached answer at once and asks the server
    /// only when it is stale (`dataVersion` moved or older than 60 s). The main lists are kept on
    /// disk per account, so a cold launch paints the last known Koti, Kuitit and Pankki.
    let resources: ResourceCache
    /// The Kuitit rows last listed, by id: a receipt opens showing its row at once while the
    /// detail loads. Not observed: no screen redraws when it changes.
    @ObservationIgnored private var receiptRows: [String: Receipt] = [:]
    /// Invoice details as last loaded (Myynti warms its first rows), by id, with the `dataVersion`
    /// they were loaded at: an invoice opens on them in its first frame, before any await. Not
    /// observed, like `receiptRows`.
    @ObservationIgnored private var invoiceDetails: [String: (version: Int, preview: InvoicePreview)] = [:]
    /// What a list screen showed last, by `ResourceKey.id`: the screen seeds its state from it before
    /// any await, so its first frame is the list and not a spinner the cache's answer replaces a moment
    /// later (motion audit myynti-recurring-open, offline-tab-myynti). Filled from the cache at launch
    /// (the previous run's from disk) and by each load. Not observed, like `receiptRows`.
    @ObservationIgnored private var lastPainted: [String: Any] = [:]
    /// Ids deleted but not yet confirmed by the server: lists leave them out at once, so a delete
    /// does not wait on the server's answer (removing a tiliote can take seconds).
    private(set) var removedIds: Set<String> = []
    /// A delete that failed after its screen had closed; the tab view shows it.
    var removalFailure: String?
    /// The receipts the owner just deleted, off every list while "Kumoa" is on offer. The server is
    /// asked when the toast ends, the app leaves the foreground, or another delete takes the toast
    /// (`deleteWithUndo`). Here and not on a screen: the receipt's own screen closes at once, and
    /// Kuitit may be left before the toast ends.
    private(set) var receiptDelete = PendingReceiptDelete()
    /// A delete the server refused once its window had ended (a closed month, no connection), said
    /// in a failure toast over the tabs. The rows are back.
    var receiptDeleteFailure: String?
    @ObservationIgnored private var receiptDeleteTimer: Task<Void, Never>?
    @ObservationIgnored private var receiptDeleteSend: (@MainActor () async -> Void)?
    /// The owner's profile, loaded once and kept: forms and the ALV screen read VAT settings from
    /// it instead of asking the server each time. Settings screens hand back what they save.
    private(set) var profile: Profile?
    /// The assistant's conversation outlives its sheet: closing with "Valmis" and opening again
    /// returns to the same conversation (a new, still empty one included), not the latest stored one.
    var chat: ChatModel?
    /// A screen to open from outside its tab (a new invoice made from "+"): MainTabView
    /// switches to the tab, pushes the route and clears this.
    var pendingRoute: PendingRoute?
    /// "Kuvaa kuitti" on a notification: MainTabView opens the camera for this bank row.
    var pendingCapture: PendingCapture?
    /// A password reset link handed to the app (`lashkirja://…?token=…`), waiting for the
    /// sign-in screen to open the reset form with it.
    var pendingResetLink: String?
    /// A Home Screen quick action or App Intent (`lashkirja://capture`, `invoice/new`, `assistant`),
    /// waiting for MainTabView to open its sheet. Cleared on sign-out so it never runs for
    /// someone else.
    var pendingQuickAction: QuickAction?
    /// When the app went to the background: coming back after a while reloads the screens.
    private var backgroundedAt: Date?
    /// Bumped whenever the signed-in session starts or ends: an answer that arrives for an earlier
    /// session (a profile, `/api/auth/me`, a failed delete) is dropped, not shown to the next one.
    private var session = LoadGeneration()
    let auth: AuthService
    let api: APIClient
    /// Sends unexpected server failures and MetricKit diagnostics to /api/observe, signed in only.
    let observer: ObserveReporter
    /// Sends the debugging trail (EventLog: screens, requests, problem reports) to /api/observe/events.
    let eventUploader: EventLogUploader
    private var eventFlushLoop: Task<Void, Never>?
    private var versionPoll: Task<Void, Never>?
    private var prefetchTask: Task<Void, Never>?
    private var nextPrefetchTask: Task<Void, Never>?
    @ObservationIgnored private var profileLoad: Task<Profile?, Never>?
    /// A server without `/api/bootstrap` (404) is not asked again this session.
    private var bootstrapMissing = false
    private var versionSettle: Task<Void, Never>?
    /// A server without `/api/sync/version` (404) is not asked again this session.
    private var versionRouteMissing = false

    init(baseURL: URL = AppConfig.apiBaseURL, store: TokenStore = KeychainTokenStore(),
         resources: ResourceCache = ResourceCache(store: .standard()), signer: DeviceKeySigner? = DeviceKey(),
         lastActive: Date? = UsageClock.lastActive) {
        self.resources = resources
        self.launchLastActive = lastActive
        let auth = AuthService(store: store, signer: signer)
        self.auth = auth
        let api = APIClient(baseURL: baseURL, transport: URLSessionTransport(), tokens: auth)
        self.api = api
        self.observer = ObserveReporter(
            app: ObserveAppInfo.current,
            isSignedIn: { await auth.currentToken() != nil },
            send: { payload in let _: Ignored = try await api.send("POST", "/api/observe", body: payload) })
        self.eventUploader = EventLogUploader(
            log: EventLog.shared,
            app: ObserveAppInfo.current,
            isSignedIn: { await auth.currentToken() != nil },
            send: { batch in let _: Ignored = try await api.send("POST", "/api/observe/events", body: batch) })
        openStoredSession(store, lastActive: lastActive)
    }

    /// Now, for a problem report or a trip to the background; otherwise every 30 s.
    func flushEvents() async { await eventUploader.flush() }

    /// The client's handlers, set from `init` before any screen can ask for anything: a launch's
    /// first 401 signs out like any other.
    @ObservationIgnored private var clientConnected: Task<Void, Never>?
    /// The stored session this device opened at launch without asking the server (`TrustedSession`);
    /// nil when the launch went to the sign-in screen or the store cannot be read before the first frame.
    @ObservationIgnored private var launchUser: AuthUser?
    /// The opened session's `/api/auth/me`, sent from `init` off the main thread: nothing waits on
    /// it, but its 401 is known while the first frame is still being built. Sent from `start()`
    /// (after that frame and the tabs) it went out only once the main thread was free, and a
    /// revoked session reached the sign-in screen 1.7–4.5 s after the first frame (CI, w67).
    @ObservationIgnored private var launchMe: Task<MeResponse?, Never>?
    /// A stored session found past its idle or absolute limit at launch: `start()` ends it, and has
    /// the server revoke it, behind the sign-in screen.
    @ObservationIgnored private var launchExpired = false
    /// When the app was last in use before this launch (`UsageClock`): the Face ID lock's idle
    /// time and the usage-gap histogram read it before `start()` moves the clock on.
    let launchLastActive: Date?
    /// What the sign-in screen says when the server refused the session.
    static let expiredNotice = "Istunto vanheni. Kirjaudu uudelleen."
    /// Set off the main thread as soon as a 401 has cleared the session's token. The main thread
    /// may be busy building a frame when the launch's 401 comes back (CI, w56): that frame shows
    /// the sign-in screen at once instead of the tabs and one more frame later.
    nonisolated let refusal = Refusal()

    /// What RootView shows: the phase, or the sign-in screen for a refusal the main actor has not
    /// yet handled (`sessionCleared` then sets the same phase, so nothing is rebuilt).
    var shownPhase: Phase {
        if case .signedOut = phase { return phase }
        return refusal.isSet ? .signedOut(notice: Self.expiredNotice) : phase
    }

    /// From `init`, before the first frame: a stored session that is valid on this device (not past
    /// its idle or absolute limit) opens on Koti's cached figures at once (owner, w67). No request
    /// is held for a session check: the screens' own loads verify it, and their first 401 signs out
    /// with the notice. A launch that cannot read the store this early (tests) stays `.launching`
    /// and `start()` restores the session the slow way.
    private func openStoredSession(_ store: TokenStore, lastActive: Date?) {
        let auth = self.auth, api = self.api, observer = self.observer
        clientConnected = Task.detached { [weak self] in
            await AppModel.connect(api, auth: auth, observer: observer, to: self)
        }
        guard let launchStore = store as? LaunchTokenReading else { return }
        let stored = launchStore.loadAtLaunch()
        switch TrustedSession.decide(stored, lastActive: lastActive, now: Date()) {
        case .open:
            guard let stored else { return }
            let user = AuthUser(userId: stored.userId, email: "", firstName: nil)
            primeKotiFromDisk(user: user.userId)
            launchUser = user
            let connected = clientConnected
            launchMe = Task.detached { [api] in
                await connected?.value
                return try? await api.get("/api/auth/me") as MeResponse
            }
            phase = .signedIn(user)
        case .signIn(let expired):
            launchExpired = expired
            phase = .signedOut(notice: expired ? Self.expiredNotice : nil)
        }
    }

    /// The client's handlers, set once per launch before its first request.
    private nonisolated static func connect(_ api: APIClient, auth: AuthService, observer: ObserveReporter, to model: AppModel?) async {
        await auth.bind(api)
        // Every write the server accepts marks what the screens show as out of date, so a list
        // reloads when the owner comes back to it after acting on a detail screen or a sheet.
        // Sign-in, chat housekeeping and the app's own diagnostics change no bookkeeping data.
        // /api/observe above all: an event upload that marked the screens stale made them
        // reload, the reloads logged new events, and the next upload reloaded them again.
        await api.setOnWrite { [weak model] path in
            guard !path.hasPrefix("/api/auth"), !path.hasPrefix("/api/ai/"), !path.hasPrefix("/api/observe"), let model else { return }
            // Bound strongly first: the hop below is concurrently-executing code, which may not capture the weak var.
            await MainActor.run {
                model.dataVersion += 1
                model.settleVersionSoon()
            }
        }
        await api.setOnUnauthorized { [weak model] sentToken in
            // Here, off the main actor: the token is cleared and the refusal known while the main
            // thread still builds the first frame.
            UITestHooks.mark("refused")
            guard await auth.handleUnauthorized(sentToken: sentToken) else { return }
            model?.refusal.set()
            await model?.sessionCleared()
        }
        await api.setOnUnexpectedFailure { method, path, status, decodeError in
            await observer.reportAPIFailure(method: method, path: path, status: status, decodeError: decodeError)
        }
        await api.setOnRequestFinished { trace in await EventLog.shared.record(.request(trace)) }
        // The offline banner also covers a server that does not answer while the phone has a network.
        // Not awaited: the client calls this before it handles a 401, and a launch's main thread is
        // busy building the tabs. Waiting on it held a revoked session's sign-out ~1.3 s (CI, w67).
        await api.setOnReachability { reached in
            Task { @MainActor in Connectivity.shared.requestFinished(reached: reached) }
        }
    }

    func start() async {
        EventLog.shared.log(.lifecycle("launch"))
        noteUsageGap(since: launchLastActive, trigger: "launch")
        let uploader = eventUploader
        eventFlushLoop = Task {
            // What the previous run left on the phone (a freeze, a crash) goes first, soon after
            // launch; then every 30 s.
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            while !Task.isCancelled {
                await uploader.flush()
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        Connectivity.shared.attach { [api] in let _: Ignored? = try? await api.get("/api/auth/me") }
        await clientConnected?.value
        let auth = self.auth
        if launchExpired {
            launchExpired = false
            // Past its idle or absolute limit on this device: the token goes, and the revoke below
            // tells the server.
            await auth.endSession()
        }
        // The revoke of an earlier sign-out is a network call: it must not hold up opening the app.
        Task { await auth.revokePending() }
        let user: AuthUser
        if let opened = launchUser {
            launchUser = nil
            // A load's 401 may already have signed out (with its notice).
            guard case .signedIn(let current) = phase, current == opened else { return Perf.dropLaunch() }
            user = opened
        } else if case .launching = phase, let restored = await auth.restore() {
            await primeKoti(user: restored.userId)
            phase = .signedIn(restored)
            user = restored
        } else {
            Perf.dropLaunch()
            if case .launching = phase { phase = .signedOut(notice: nil) }
            return
        }
        // A lock set up before its owner was recorded belongs to this session's account.
        AppLock.shared.adoptOwnerIfUnknown(user.userId)
        AppLock.shared.keepOnly(for: user.userId)
        let started = session.current
        // Already out since `init` for a session opened there; nothing waits on it.
        let me = launchMe ?? Task { [api] in try? await api.get("/api/auth/me") as MeResponse }
        launchMe = nil
        await auth.refreshIfDue()
        // A refused refresh already signed out (with the notice): stop here.
        guard await auth.currentToken() != nil else {
            if case .signedIn = phase { phase = .signedOut(notice: Self.expiredNotice) }
            return
        }
        // After the refresh: the first look at the version goes out with a current token.
        startVersionPolling()
        prefetch()
        // Only for the account it was asked for: a sign-out (and maybe another sign-in) can
        // happen while it loads.
        if let me = await me.value, session.isCurrent(started),
           case .signedIn(let current) = phase, current.userId == me.user.userId {
            phase = .signedIn(me.user)
        }
    }

    /// Opens the app for a session AuthService already stored (password or passkey sign-in).
    /// The sign-in screen holds this back while it offers a passkey after a password sign-in.
    func enter(_ user: AuthUser) {
        // The sign-in field still holds the keyboard: it would stay up over the app.
        Keyboard.dismiss()
        // After an expired session someone else may sign in: they are not locked behind the
        // previous owner's PIN (the same policy as signing out).
        AppLock.shared.keepOnly(for: user.userId)
        Haptics.success()
        refusal.clear()
        AppLock.shared.endIdleLock()
        session.next()
        phase = .signedIn(user)
        startVersionPolling()
        prefetch()
        Task { await auth.revokePending() }
    }

    /// The token is gone from this device before the sign-in screen shows; the server revoke
    /// runs behind (it may take the full timeout when the server is unreachable, and then
    /// retries next launch).
    func logout() async {
        // The lock belongs to the signed-in owner; the next account sets its own.
        AppLock.shared.disable()
        AppLock.shared.idleLockEnabled = false
        // Receipt photos waiting for a connection belong to this owner: they leave with them.
        OfflineReceiptQueueModel.shared.clearForSignOut()
        endLocalSession()
        await api.endSessionRequests()
        await auth.endSession()
        phase = .signedOut(notice: nil)
        let auth = self.auth
        Task { await auth.revokePending() }
    }

    /// The server refused the session (a 401, or a refused refresh). Waiting receipt photos stay
    /// on the device for when the same owner signs in again; nothing else of theirs stays.
    /// A 401 for an earlier session (sent before a sign-in) leaves the current one alone.
    func sessionExpired(sentToken: String) async {
        UITestHooks.mark("refused")
        guard await auth.handleUnauthorized(sentToken: sentToken) else { return }
        await sessionCleared()
    }

    /// The refused session's token is already gone (`AuthService.handleUnauthorized` said so):
    /// the rest of the session ends here.
    func sessionCleared() async {
        UITestHooks.mark("cleared")
        OfflineReceiptQueueModel.shared.detach()
        endLocalSession()
        UITestHooks.mark("ended")
        // Before the hop below: the sign-in screen does not wait on the client actor.
        phase = .signedOut(notice: Self.expiredNotice)
        // A 401 seen outside `api` (the assistant's stream, a receipt upload): its loads still out
        // end here too, quietly, instead of each answering 401 behind the sign-in screen.
        await api.endSessionRequests()
    }

    /// A 401 to a request made outside `api` (the assistant's stream and receipt upload): it ends
    /// the session only if it was sent with the token still in use, as `APIClient` does.
    func unauthorized(sentToken: String?) async {
        guard let sentToken else { return }
        await sessionExpired(sentToken: sentToken)
    }

    /// The time since `last` as a usage-gap bucket in the debugging trail (anonymous on the server),
    /// then the clock moves on: the app is in use now, unless it opened locked.
    private func noteUsageGap(since last: Date?, trigger: String) {
        let now = Date()
        if let last, now > last { EventLog.shared.log(UsageGap.event(now.timeIntervalSince(last), trigger: trigger)) }
        UsageClock.touchUnlessLocked(now)
    }

    func background() {
        backgroundedAt = Date()
        // The app may be suspended before the toast ends: the delete goes now.
        flushReceiptDelete()
        UsageClock.touchUnlessLocked()
        // Nothing to keep fresh while the app is not on screen; `foreground()` asks at once.
        stopVersionPolling()
        EventLog.shared.log(.lifecycle("background"))
        let uploader = eventUploader
        Task { await uploader.flush() }
    }

    func foreground() async {
        EventLog.shared.log(.lifecycle("foreground"))
        // Only a return from the background this process saw (the launch's own `.active` is not one).
        if let backgroundedAt {
            if case .signedIn = phase { AppLock.shared.lockIfIdle(lastActive: backgroundedAt) }
            noteUsageGap(since: backgroundedAt, trigger: "foreground")
            // Away for a while: the session is asked about again, without holding anything up;
            // a 401 signs out as usual.
            if Date().timeIntervalSince(backgroundedAt) > TrustedSession.reverifyAfterBackground, case .signedIn = phase {
                Task { [api] in let _: Ignored? = try? await api.get("/api/auth/me") }
            }
        }
        // Back after more than five minutes: what the screens show may be out of date.
        let stale = ForegroundRefresh.isStale(backgroundedAt: backgroundedAt, now: Date())
        if stale, case .signedIn = phase {
            dataVersion += 1
        }
        backgroundedAt = nil
        await auth.refreshIfDue()
        startVersionPolling()
        // Back after a while: the first screens are asked again before the owner taps them.
        if stale { prefetch() }
    }

    // MARK: Cache

    /// A GET through `resources`: the cached answer while it is fresh (unless `force`), otherwise
    /// the server's, shared with any other screen asking for the same at the same time. Decoded
    /// off the main actor. `persist` keeps it on disk for the next launch (the main lists only).
    func cachedGet<T: Decodable>(_ path: String, query: [String: String] = [:], force: Bool = false, persist: Bool = false) async throws -> T {
        guard case .signedIn(let user) = phase else { throw CancellationError() }
        let api = self.api
        let key = ResourceKey(user: user.userId, path: path, query: query)
        return try await resources.load(key, version: dataVersion, force: force, persist: persist, as: T.self) {
            try await api.raw("GET", path, query: query, body: nil, contentType: nil).body
        }
    }

    /// The cached answer, fresh or not, to paint before the server answers; nil when there is none.
    func cachedValue<T: Decodable>(_ path: String, query: [String: String] = [:]) async -> T? {
        guard case .signedIn(let user) = phase else { return nil }
        let key = ResourceKey(user: user.userId, path: path, query: query)
        return await resources.cached(key, version: dataVersion, as: T.self)?.value
    }

    /// The rows a list showed, for `receiptPreview`. Bounded: a long session never grows it past a thousand.
    func rememberReceiptRows(_ rows: [Receipt]) {
        if receiptRows.count + rows.count > 1_000 { receiptRows.removeAll() }
        for row in rows { receiptRows[row.id] = row }
    }

    func receiptPreview(_ id: String) -> Receipt? { receiptRows[id] }

    /// A detail as `cachedGet` answered it (with an overdue one's reminder), for `invoicePreview`.
    /// Bounded like `receiptRows`.
    func rememberInvoiceDetail(_ detail: InvoiceDetailResponse, reminder: ReminderPreview?) {
        if invoiceDetails.count >= 200 { invoiceDetails.removeAll() }
        invoiceDetails[detail.invoice.id] = (dataVersion, InvoicePreview(detail: detail, reminder: reminder))
    }

    /// Nil once anything changed in the app since it was loaded: the cache's answer is newer then.
    func invoicePreview(_ id: String) -> InvoicePreview? {
        guard let entry = invoiceDetails[id], entry.version == dataVersion else { return nil }
        return entry.preview
    }

    /// The answer a screen last painted for this GET (`lastPainted`), fresh or not; nil when there is none.
    func lastPainted<T>(_ path: String, query: [String: String] = [:]) -> T? {
        guard case .signedIn(let user) = phase else { return nil }
        return lastPainted[ResourceKey(user: user.userId, path: path, query: query).id] as? T
    }

    func rememberPainted<T>(_ value: T, _ path: String, query: [String: String] = [:]) {
        guard case .signedIn(let user) = phase else { return }
        lastPainted[ResourceKey(user: user.userId, path: path, query: query).id] = value
    }

    /// Koti's month as last painted, for its first frame (`KotiView`); nil when there is none.
    func kotiPreview() -> Dashboard? {
        lastPainted("/api/dashboard", query: ["month": MonthKey.current()])
    }

    /// Raportit's year as last painted, for its first frame (`RaportitView`); nil when there is none.
    func raportitPreview() -> ProfitLoss? {
        lastPainted("/api/reports/profit-loss", query: RaportitView.query(year: RaportitView.currentYear))
    }

    /// Koti's last dashboard of the month from the previous run's disk cache, read and decoded on the
    /// cache's actor before the tabs appear: Koti's first frame after a launch is the figures, not a
    /// spinner that two more hops later the same figures replaced (w44, launch → Koti).
    /// The same from the file the previous run left, read in `init` so the first frame has it.
    private func primeKotiFromDisk(user: String) {
        let key = ResourceKey(user: user, path: "/api/dashboard", query: ["month": MonthKey.current()])
        guard let entry = resources.disk?.read(user: user)[key.id],
              let dashboard = try? JSONDecoder().decode(Dashboard.self, from: entry.data) else { return }
        lastPainted[key.id] = dashboard
    }

    private func primeKoti(user: String) async {
        let query = ["month": MonthKey.current()]
        let key = ResourceKey(user: user, path: "/api/dashboard", query: query)
        guard let hit = await resources.cached(key, version: dataVersion, as: Dashboard.self) else { return }
        lastPainted[key.id] = hit.value
    }

    /// Myynti's first screen (list and chip counts), Toistuvat laskut, the new-invoice form's
    /// customers and catalog, and Kuitit's first screen (list, counts and both review queues, for
    /// the filters the owner left), from the cache into `lastPainted`. At launch (`replacing` false) a screen that already painted something keeps it;
    /// after a prefetch the cache holds the newest answer, as every load goes through it.
    private func primePainted(replacing: Bool) async {
        let list = SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: "")
        let counts = InvoiceScope().query
        if let value: InvoiceList = await cachedValue("/api/invoices", query: list) {
            primePainted(value, "/api/invoices", query: list, replacing: replacing)
        }
        if let value: InvoiceCounts = await cachedValue("/api/invoices/counts", query: counts) {
            primePainted(value.counts, "/api/invoices/counts", query: counts, replacing: replacing)
        }
        if let value: RecurringList = await cachedValue("/api/recurring-invoices") {
            primePainted(value, "/api/recurring-invoices", replacing: replacing)
        }
        if let value: CustomerList = await cachedValue("/api/customers") {
            primePainted(value, "/api/customers", replacing: replacing)
        }
        if let value: CatalogList = await cachedValue("/api/catalog") {
            primePainted(value, "/api/catalog", replacing: replacing)
        }
        let kuitit = ReceiptListQuery(remembered: UserDefaults.standard.string(forKey: ReceiptsView.filterKey) ?? "")
        for query in [ReceiptListPaging.firstQuery(kuitit), ReceiptListQuery.pendingQueue(), ReceiptListQuery.rejectedQueue()] {
            if let value: ReceiptList = await cachedValue("/api/receipts", query: query) {
                primePainted(value, "/api/receipts", query: query, replacing: replacing)
            }
        }
        if let value: ReceiptCounts = await cachedValue("/api/receipts/counts", query: kuitit.countsQuery()) {
            primePainted(value, "/api/receipts/counts", query: kuitit.countsQuery(), replacing: replacing)
        }
        // Raportit's year (warmed after Koti), so its tab opens on the figures, not a spinner.
        let report = RaportitView.query(year: RaportitView.currentYear)
        if let value: ProfitLoss = await cachedValue("/api/reports/profit-loss", query: report) {
            primePainted(value, "/api/reports/profit-loss", query: report, replacing: replacing)
        }
    }

    /// Kuukauden sulku's month (the one it opens on) with its VAT row, from the cache into
    /// `lastPainted` once Kirjanpito has warmed them.
    private func primePeriods() async {
        let month = PeriodClose.startMonth(nil, current: MonthKey.current())
        guard let status: PeriodMonthStatus = await cachedValue("/api/dashboard/month", query: ["month": month]) else { return }
        var vat: (key: String, facts: PeriodClose.Vat, report: AlvReport)?
        if status.vatRegistered, let period = PeriodClose.vatPeriodEnding(in: month, kind: status.vatPeriod) {
            // The return due next (warmed above) is not always the one this month closes: asked for here.
            guard let report: AlvReport = try? await cachedGet("/api/alv", query: ["period": period]) else { return }
            vat = (period, PeriodsPreview.facts(report), report)
        }
        rememberPeriods(PeriodsPreview(status: status, vat: vat))
    }

    private func primePainted<T>(_ value: T, _ path: String, query: [String: String] = [:], replacing: Bool) {
        let shown: T? = lastPainted(path, query: query)
        if replacing || shown == nil { rememberPainted(value, path, query: query) }
    }

    /// After sign-in and on coming back after a while: Koti, Kuitit page 1 with its counts and
    /// queues, and Pankki's balances load side by side with exactly the screens' queries, so the tab
    /// the owner opens paints from the cache. `/api/bootstrap` first, where the server has it.
    func prefetch() {
        guard case .signedIn = phase else { return }
        prefetchTask?.cancel()
        let filter = UserDefaults.standard.string(forKey: ReceiptsView.filterKey) ?? ""
        let requests = LaunchPrefetch.requests(month: MonthKey.current(), kuititFilter: filter)
        prefetchTask = Task { [weak self] in
            guard let self else { return }
            // Side by side: the bootstrap's counts stand in for the counts request if it is first.
            // The profile too: Koti's ALV row and the ALV screen wait on it.
            async let booted: Void = self.bootstrap(kuititFilter: filter)
            async let profile = self.cachedProfile()
            // The previous run's lists from disk at once: offline, or before the server answers,
            // Myynti still opens on them.
            async let painted: Void = self.primePainted(replacing: false)
            await self.warmAll(requests)
            await booted
            _ = await profile
            await painted
            // Koti is painted: the other tabs' first screens next, before the owner taps them.
            guard !Task.isCancelled else { return }
            await self.warmAll(NextPrefetch.afterKoti(month: MonthKey.current()))
            // For a walk that opens one of these screens on its cache (P4Tests: the assistant).
            UITestHooks.mark("afterKoti")
            await self.primePainted(replacing: true)
        }
    }

    /// A tab was chosen: the screens one tap away from it start loading now. Fills the cache only.
    func warmNext(from tab: AppTab) {
        guard case .signedIn = phase else { return }
        nextPrefetchTask?.cancel()
        nextPrefetchTask = Task { [weak self] in
            // After the chosen tab's first frame. Offline these requests fail at once, and the
            // cache reads and `lastPainted` writes behind them landed in the middle of a first
            // visit's build, holding its content back (w60 motion gate, offline-tab-myynti).
            await RunLoopIdle.afterFrame()
            guard let self, !Task.isCancelled else { return }
            switch tab {
            case .kirjanpito:
                let kind = VatKind(profile: await self.cachedProfile()?.vatPeriod)
                let alv = VatDue.nextDueKey(today: APIDate.dayString(Date()), kind: kind)
                await self.warmAll(NextPrefetch.kirjanpito(month: MonthKey.current(), alvPeriod: alv))
                await self.primePeriods()
            case .myynti:
                await self.warmAll(NextPrefetch.myynti())
                await self.primePainted(replacing: true)
            default:
                break
            }
        }
    }

    /// Asetukset is open: Laitteet, Sähköpostimallit and Pääsyavaimet (`NextPrefetch.asetukset`) are
    /// asked now and kept in `lastPainted`, so each push lands on its content (M053 M054 M057).
    /// Asked even when cached: a write under /api/auth leaves `dataVersion` alone, so the cache could
    /// hold a list that a sign-out or a rename there has changed since. A failed request leaves
    /// what was painted last.
    func warmAsetukset() async {
        guard case .signedIn = phase else { return }
        let answered = await withTaskGroup(of: String?.self, returning: Set<String>.self) { group in
            for request in NextPrefetch.asetukset() {
                group.addTask {
                    let answer: Ignored? = try? await self.cachedGet(request.path, query: request.query, force: true, persist: request.persist)
                    return answer == nil ? nil : request.path
                }
            }
            var paths: Set<String> = []
            for await path in group { if let path { paths.insert(path) } }
            return paths
        }
        if answered.contains(DevicesView.path), let list: DeviceSessions = await cachedValue(DevicesView.path) {
            rememberPainted(DeviceSession.currentFirst(list.sessions), DevicesView.path)
        }
        if answered.contains(EmailTemplatesView.path),
           let list: EmailTemplateList = await cachedValue(EmailTemplatesView.path, query: EmailTemplatesView.query) {
            rememberPainted(list, EmailTemplatesView.path, query: EmailTemplatesView.query)
        }
        if answered.contains(PasskeyScreen.listPath), answered.contains(PasskeyScreen.statusPath),
           let list: PasskeyList = await cachedValue(PasskeyScreen.listPath),
           let status: PasskeyStatus = await cachedValue(PasskeyScreen.statusPath) {
            rememberPainted(PasskeyScreen(passkeys: list.passkeys, canCreate: status.native), PasskeyScreen.listPath)
        }
    }

    private func warmAll(_ requests: [PrefetchRequest]) async {
        await withTaskGroup(of: Void.self) { group in
            for request in requests {
                group.addTask { await self.warm(request) }
            }
        }
    }

    /// Fills the cache only; a failure is the screen's to show when it is opened.
    private func warm(_ request: PrefetchRequest) async {
        guard !Task.isCancelled else { return }
        let _: Ignored? = try? await cachedGet(request.path, query: request.query, persist: request.persist)
    }

    /// One round trip for the server's version and the Kuitit counts (W24's `/api/bootstrap`).
    /// An older server answers 404 and is not asked again; the separate requests cover it.
    private func bootstrap(kuititFilter: String) async {
        guard !bootstrapMissing, case .signedIn(let user) = phase else { return }
        let started = session.current
        do {
            let response = try await api.raw("GET", "/api/bootstrap", body: nil, contentType: nil)
            guard session.isCurrent(started),
                  let boot = try? JSONDecoder().decode(AppBootstrap.self, from: response.body) else { return }
            // Taken as the baseline only: the lists are being asked for right now anyway, and a
            // bootstrap that counts its version differently from `/api/sync/version` must not
            // reload every screen at each launch.
            if let snapshot = boot.version { versions.apply(snapshot, absorb: true) }
            if let counts = boot.receiptCounts, let request = LaunchPrefetch.countsRequest(kuititFilter: kuititFilter),
               let data = try? ReceiptCounts.answer(counts) {
                let key = ResourceKey(user: user.userId, path: request.path, query: request.query)
                await resources.prime(key, data: data, version: dataVersion, persist: request.persist)
            }
        } catch let error as LKError where error.status == 404 {
            bootstrapMissing = true
        } catch {
            // Offline or a passing failure: the separate requests still fill the cache.
        }
    }

    // MARK: Freshness

    /// Pull-to-refresh on a screen that shows money: every screen asks again, not only this one,
    /// and the server's version becomes the new baseline. Returns the version the screen's own
    /// reload stands for, so its gate does not load a second time for the same bump.
    @discardableResult
    func refreshEverything() -> Int {
        versions.bump()
        settleVersionSoon()
        return versions.version
    }

    /// Asks `/api/sync/version` now and then every 30 s, while signed in and in the foreground.
    private func startVersionPolling() {
        versionPoll?.cancel()
        guard case .signedIn = phase, !UITestHooks.versionPollOff else { return }
        versionPoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollVersion()
                try? await Task.sleep(nanoseconds: UInt64(VersionPolling.interval * 1_000_000_000))
            }
        }
    }

    private func stopVersionPolling() {
        versionPoll?.cancel()
        versionPoll = nil
    }

    /// After the app's own write (or a pull-to-refresh) the screens are reloading already: the
    /// server's next answer is taken as the baseline, so the poll does not reload them again.
    /// A burst of writes (a bulk action) settles first.
    private func settleVersionSoon() {
        versionSettle?.cancel()
        versionSettle = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            await self?.pollVersion(absorb: true)
        }
    }

    /// One look at `/api/sync/version`; an answer that differs from the previous one bumps
    /// `dataVersion` (unless `absorb`). Returns the answer, nil when there was none.
    @discardableResult
    func pollVersion(absorb: Bool = false) async -> SyncVersion? {
        guard !versionRouteMissing, case .signedIn = phase else { return nil }
        let started = session.current
        do {
            let snapshot: SyncVersion = try await api.get("/api/sync/version")
            guard session.isCurrent(started) else { return nil }
            versions.apply(snapshot, absorb: absorb)
            return snapshot
        } catch let error as LKError where error.status == 404 {
            // An older server: the writes, pull-to-refresh and foreground bumps still keep the screens fresh.
            versionRouteMissing = true
            return nil
        } catch {
            // Offline or a passing failure: the next poll tries again.
            return nil
        }
    }

    /// A `lashkirja://` link opened the app; a reset link waits for the sign-in screen.
    func handle(url: URL) {
        let link = url.absoluteString
        if PasswordReset.token(from: link) != nil { pendingResetLink = link }
        // Quick actions and App Intents: MainTabView exists only while signed in, so before
        // sign-in (or during launch) the action waits here and runs once the tabs appear.
        if let action = QuickAction(url: url) { pendingQuickAction = action }
        // A Spotlight result: its tab and detail, as a notification tap opens them. Nothing opens
        // for a signed-out app (the index is cleared at sign-out, so a stale result only misses).
        if let target = OpenTarget(url: url), !isSignedOut {
            switch target {
            case .customer(let id): pendingRoute = PendingRoute(tab: .myynti, route: .customer(id))
            case .invoice(let id): pendingRoute = PendingRoute(tab: .myynti, route: .invoice(id))
            }
        }
    }

    private var isSignedOut: Bool {
        if case .signedOut = phase { return true }
        return false
    }

    /// Lists that loaded feed system search, only while an owner is signed in.
    func indexForSpotlight(_ entries: [SpotlightEntry]) {
        guard case .signedIn = phase else { return }
        SpotlightIndexer.index(entries)
    }

    /// The sign-in email was changed and confirmed: the profile and the signed-in user show it.
    func emailChanged(to email: String) {
        if case .signedIn(let user) = phase {
            phase = .signedIn(AuthUser(userId: user.userId, email: email, firstName: user.firstName))
        }
        profileChanged(nil)
    }

    /// Asked once however many screens want it at the same time (the launch prefetch, Koti, ALV).
    func cachedProfile() async -> Profile? {
        if let profile { return profile }
        let started = session.current
        let task: Task<Profile?, Never>
        if let running = profileLoad {
            task = running
        } else {
            let api = self.api
            task = Task {
                let response: ProfileResponse? = try? await api.get("/api/profile")
                return response?.profile
            }
            profileLoad = task
        }
        let loaded = await task.value
        if profileLoad == task { profileLoad = nil }
        guard let loaded, session.isCurrent(started) else { return profile }
        profile = loaded
        return profile
    }

    func profileChanged(_ new: Profile?) { profile = new }

    func hide(_ ids: [String]) { removedIds.formUnion(ids) }
    func unhide(_ ids: [String]) { removedIds.subtract(ids) }

    /// Hides `ids` now and deletes them on the server without holding the screen; a refusal brings
    /// them back and says why. The write bumps `dataVersion`, so lists reload after it lands.
    func removeInBackground(_ ids: [String], _ work: @escaping @Sendable @MainActor () async throws -> Void) {
        hide(ids)
        // A light tap now (the row went away); the success feel only once the server agreed, so a
        // deletion the server refuses never felt done.
        Haptics.selection()
        let started = session.current
        Task {
            do {
                try await work()
                if session.isCurrent(started) { Haptics.success() }
            } catch {
                // Signed out meanwhile: the next session never saw these rows hidden.
                guard session.isCurrent(started) else { return }
                unhide(ids)
                removalFailure = error.userMessage
                Haptics.error()
            }
        }
    }

    /// Hides `ids` and offers "Kumoa" for `PendingReceiptDelete.window` seconds. The server is asked
    /// only when that has passed, so an undo is not a server call. `send` makes the request and says
    /// what the server did; the rows it refused come back with the reason in a failure toast.
    func deleteWithUndo(_ ids: [String], send: @escaping @MainActor () async -> ReceiptDeleteOutcome) {
        guard !ids.isEmpty else { return }
        receiptDeleteFailure = nil
        // A newer delete does not undo an older one: that one goes now.
        flushReceiptDelete()
        withMotion { hide(ids) }
        Haptics.selection()
        receiptDelete.begin(ids)
        let started = session.current
        receiptDeleteSend = { [weak self] in
            let outcome = await send()
            self?.receiptDeleteSent(outcome, session: started)
        }
        let token = receiptDelete.waiting?.token
        receiptDeleteTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(UITestHooks.undoWindow(PendingReceiptDelete.window)))
            guard !Task.isCancelled else { return }
            self?.flushReceiptDelete(token: token)
        }
    }

    /// Kuitit's swipe and "Valitse" delete: `POST /api/receipts/batch-delete`, 50 ids to a call.
    func deleteReceipts(_ ids: [String]) {
        let api = self.api
        deleteWithUndo(ids) {
            var outcome = ReceiptDeleteOutcome()
            for chunk in BulkBatch.chunks(ids, size: BulkBatch.deleteLimit) {
                do {
                    let result: BatchDeleteResult = try await api.send("POST", "/api/receipts/batch-delete", body: ReceiptIdsBody(receiptIds: chunk))
                    outcome.add(result, asked: chunk)
                } catch {
                    outcome.fail(chunk, reason: error.userMessage)
                }
            }
            return outcome
        }
    }

    /// The receipt screen's delete: `DELETE /api/receipts/{id}`, which also takes the ostolasku the
    /// receipt filed (the batch route does not).
    func deleteReceipt(_ id: String) {
        let api = self.api
        deleteWithUndo([id]) {
            do {
                let _: Ignored = try await api.send("DELETE", "/api/receipts/\(id)", body: Optional<EmptyBody>.none)
                return ReceiptDeleteOutcome(deleted: 1)
            } catch {
                var outcome = ReceiptDeleteOutcome()
                outcome.fail([id], reason: error.userMessage)
                return outcome
            }
        }
    }

    /// "Kumoa": the rows come back where they were and the server never hears of the delete.
    func undoReceiptDelete() {
        let ids = receiptDelete.undo()
        receiptDeleteTimer?.cancel()
        receiptDeleteTimer = nil
        receiptDeleteSend = nil
        guard !ids.isEmpty else { return }
        Haptics.selection()
        withMotion { unhide(ids) }
    }

    /// Sends the waiting delete now, once: its window ended (`token`), the app is leaving the
    /// foreground, or a newer delete takes the toast.
    func flushReceiptDelete(token: Int? = nil) {
        guard receiptDelete.release(token: token) != nil else { return }
        receiptDeleteTimer?.cancel()
        receiptDeleteTimer = nil
        guard let send = receiptDeleteSend else { return }
        receiptDeleteSend = nil
        Task { await send() }
    }

    private func receiptDeleteSent(_ outcome: ReceiptDeleteOutcome, session started: Int) {
        // Signed out meanwhile: the next session never saw these rows hidden.
        guard session.isCurrent(started) else { return }
        // Lists reload after the write; the ids stay hidden until then, as after any delete.
        if outcome.deleted > 0 { dataVersion += 1 }
        guard !outcome.refused.isEmpty else {
            Haptics.success()
            return
        }
        withMotion { unhide(outcome.refused) }
        receiptDeleteFailure = outcome.message
        Haptics.error()
    }

    /// What every way out of a session leaves behind: nothing of this owner's on screen or in
    /// flight. Run before the sign-in screen shows.
    private func endLocalSession() {
        session.next()
        stopVersionPolling()
        versionSettle?.cancel()
        versionRouteMissing = false
        prefetchTask?.cancel()
        prefetchTask = nil
        nextPrefetchTask?.cancel()
        nextPrefetchTask = nil
        profileLoad = nil
        bootstrapMissing = false
        // This owner's cached answers, in memory and on disk, go with them.
        let resources = self.resources
        Task { await resources.clear() }
        receiptRows = [:]
        invoiceDetails = [:]
        lastPainted = [:]
        versions.endSession()
        // This owner's figures must not show to the next one.
        bankFeedMemory = [:]
        chat?.shutdown()
        chat = nil
        DocumentCache.shared.clear()
        // Names, Y-tunnukset and amounts must not stay findable in system search.
        SpotlightIndexer.clear()
        profile = nil
        removedIds = []
        // A delete still waiting out "Kumoa" is dropped, not sent: the receipt stays on the server.
        receiptDeleteTimer?.cancel()
        receiptDeleteTimer = nil
        receiptDeleteSend = nil
        receiptDelete = PendingReceiptDelete()
        receiptDeleteFailure = nil
        pendingRoute = nil
        pendingCapture = nil
        // A shortcut tapped by the previous owner must not open on the next one's account.
        pendingQuickAction = nil
        removalFailure = nil
        // This owner's notifications, shown or waiting, and the record of what was shown.
        AppNotifications.shared.clearForSignOut()
    }
}

struct MeResponse: Decodable { let user: AuthUser }

struct PendingRoute: Equatable {
    let tab: AppTab
    let route: Route
    /// False when the screen is placed behind a cover that is about to go down: the cover's
    /// movement is then the only one the owner sees.
    var animated = true
}

struct PendingCapture: Identifiable, Equatable {
    let id = UUID()
    /// The bank row to match; nil for a plain "Kuvaa kuitti" (quick action).
    let transactionId: String?
}

/// What an invoice opens on before its own load: the detail and, when overdue, the reminder.
struct InvoicePreview {
    let detail: InvoiceDetailResponse
    let reminder: ReminderPreview?
}

/// A one-way flag any thread may set and read (`AppModel.refusal`).
final class Refusal: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
    /// A new session signed in: the earlier refusal is not this one's.
    func clear() { lock.withLock { value = false } }
}

/// When the app was last in use on this device (UserDefaults; not a secret): the trusted session's
/// idle limit, the Face ID lock's idle time and the usage-gap histogram count from it.
enum UsageClock {
    private static let key = "usage.lastActiveAt"
    static var lastActive: Date? { UserDefaults.standard.object(forKey: key) as? Date }
    static func touch(_ now: Date = Date()) { UserDefaults.standard.set(now, forKey: key) }
    /// A locked app is not in use: a relaunch over the idle lock (force-quit, or iOS ending the
    /// backgrounded app) must still find the time it was last open, or it opens unlocked. The
    /// clock moves on again when the lock lifts (`AppLock`).
    @MainActor static func touchUnlessLocked(_ now: Date = Date()) {
        guard !AppLock.shared.isLocked else { return }
        touch(now)
    }
}
