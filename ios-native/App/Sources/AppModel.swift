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
    /// The last Pankki figures, kept across visits: coming back shows them at once while they
    /// refresh behind (the hub is a pushed screen, so its own state goes with it).
    var bankHubMemory: BankHubMemory?
    /// The last loaded Pankkitapahtumat per month filter ("" = every month), for the same reason.
    var bankFeedMemory: [String: BankFeedMemory] = [:]
    /// Every screen's GET answers: a screen paints the cached answer at once and asks the server
    /// only when it is stale (`dataVersion` moved or older than 60 s). The main lists are kept on
    /// disk per account, so a cold launch paints the last known Koti, Kuitit and Pankki.
    let resources = ResourceCache(store: .standard())
    /// The Kuitit rows last listed, by id: a receipt opens showing its row at once while the
    /// detail loads. Not observed: no screen redraws when it changes.
    @ObservationIgnored private var receiptRows: [String: Receipt] = [:]
    /// Invoice details as last loaded (Myynti warms its first rows), by id, with the `dataVersion`
    /// they were loaded at: an invoice opens on them in its first frame, before any await. Not
    /// observed, like `receiptRows`.
    @ObservationIgnored private var invoiceDetails: [String: (version: Int, preview: InvoicePreview)] = [:]
    /// Ids deleted but not yet confirmed by the server: lists leave them out at once, so a delete
    /// does not wait on the server's answer (removing a tiliote can take seconds).
    private(set) var removedIds: Set<String> = []
    /// A delete that failed after its screen had closed; the tab view shows it.
    var removalFailure: String?
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

    init(baseURL: URL = AppConfig.apiBaseURL, store: TokenStore = KeychainTokenStore()) {
        let auth = AuthService(store: store)
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
    }

    /// Now, for a problem report or a trip to the background; otherwise every 30 s.
    func flushEvents() async { await eventUploader.flush() }

    func start() async {
        await auth.bind(api)
        // Every write the server accepts marks what the screens show as out of date, so a list
        // reloads when the owner comes back to it after acting on a detail screen or a sheet.
        // Sign-in, chat housekeeping and the app's own diagnostics change no bookkeeping data.
        // /api/observe above all: an event upload that marked the screens stale made them
        // reload, the reloads logged new events, and the next upload reloaded them again.
        await api.setOnWrite { [weak self] path in
            guard !path.hasPrefix("/api/auth"), !path.hasPrefix("/api/ai/"), !path.hasPrefix("/api/observe") else { return }
            await MainActor.run {
                self?.dataVersion += 1
                self?.settleVersionSoon()
            }
        }
        await api.setOnUnauthorized { [weak self] sentToken in await self?.sessionExpired(sentToken: sentToken) }
        let observer = self.observer
        await api.setOnUnexpectedFailure { method, path, status, decodeError in
            await observer.reportAPIFailure(method: method, path: path, status: status, decodeError: decodeError)
        }
        await api.setOnRequestFinished { trace in await EventLog.shared.record(.request(trace)) }
        EventLog.shared.log(.lifecycle("launch"))
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
        // The offline banner also covers a server that does not answer while the phone has a network.
        await api.setOnReachability { reached in await MainActor.run { Connectivity.shared.requestFinished(reached: reached) } }
        Connectivity.shared.attach { [api] in let _: Ignored? = try? await api.get("/api/auth/me") }
        let auth = self.auth
        // The revoke of an earlier sign-out is a network call: it must not hold up opening the app.
        Task { await auth.revokePending() }
        guard let user = await auth.restore() else {
            Perf.dropLaunch()
            phase = .signedOut(notice: nil)
            return
        }
        // A lock set up before its owner was recorded belongs to this session's account.
        AppLock.shared.adoptOwnerIfUnknown(user.userId)
        AppLock.shared.keepOnly(for: user.userId)
        phase = .signedIn(user)
        let started = session.current
        await auth.refreshIfDue()
        // A refused refresh already signed out (with the notice): stop here.
        guard await auth.currentToken() != nil else { return }
        // After the refresh: the first look at the version goes out with a current token.
        startVersionPolling()
        prefetch()
        // Only for the account it was asked for: a sign-out (and maybe another sign-in) can
        // happen while it loads.
        if let me: MeResponse = try? await api.get("/api/auth/me"), session.isCurrent(started),
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
        // Receipt photos waiting for a connection belong to this owner: they leave with them.
        OfflineReceiptQueueModel.shared.clearForSignOut()
        endLocalSession()
        await auth.endSession()
        phase = .signedOut(notice: nil)
        let auth = self.auth
        Task { await auth.revokePending() }
    }

    /// The server refused the session (a 401, or a refused refresh). Waiting receipt photos stay
    /// on the device for when the same owner signs in again; nothing else of theirs stays.
    /// A 401 for an earlier session (sent before a sign-in) leaves the current one alone.
    func sessionExpired(sentToken: String) async {
        guard await auth.handleUnauthorized(sentToken: sentToken) else { return }
        OfflineReceiptQueueModel.shared.detach()
        endLocalSession()
        phase = .signedOut(notice: "Istunto vanheni. Kirjaudu uudelleen.")
    }

    /// A 401 to a request made outside `api` (the assistant's stream and receipt upload): it ends
    /// the session only if it was sent with the token still in use, as `APIClient` does.
    func unauthorized(sentToken: String?) async {
        guard let sentToken else { return }
        await sessionExpired(sentToken: sentToken)
    }

    func background() {
        backgroundedAt = Date()
        // Nothing to keep fresh while the app is not on screen; `foreground()` asks at once.
        stopVersionPolling()
        EventLog.shared.log(.lifecycle("background"))
        let uploader = eventUploader
        Task { await uploader.flush() }
    }

    func foreground() async {
        EventLog.shared.log(.lifecycle("foreground"))
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

    /// After sign-in and on coming back after a while: Koti, Kuitit page 1 with its counts and
    /// queues, and the Pankki hub load side by side with exactly the screens' queries, so the tab
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
            await self.warmAll(requests)
            await booted
            _ = await profile
            // Koti is painted: the other tabs' first screens next, before the owner taps them.
            guard !Task.isCancelled else { return }
            await self.warmAll(NextPrefetch.afterKoti(month: MonthKey.current()))
        }
    }

    /// A tab was chosen: the screens one tap away from it start loading now. Fills the cache only.
    func warmNext(from tab: AppTab) {
        guard case .signedIn = phase else { return }
        nextPrefetchTask?.cancel()
        nextPrefetchTask = Task { [weak self] in
            guard let self else { return }
            switch tab {
            case .kirjanpito:
                let kind = VatKind(profile: await self.cachedProfile()?.vatPeriod)
                let alv = VatDue.nextDueKey(today: APIDate.dayString(Date()), kind: kind)
                await self.warmAll(NextPrefetch.kirjanpito(month: MonthKey.current(), alvPeriod: alv))
            case .myynti:
                await self.warmAll(NextPrefetch.myynti())
            default:
                break
            }
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
        guard case .signedIn = phase else { return }
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
        versions.endSession()
        // This owner's figures must not show to the next one.
        bankHubMemory = nil
        bankFeedMemory = [:]
        chat?.shutdown()
        chat = nil
        DocumentCache.shared.clear()
        // Names, Y-tunnukset and amounts must not stay findable in system search.
        SpotlightIndexer.clear()
        profile = nil
        removedIds = []
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
