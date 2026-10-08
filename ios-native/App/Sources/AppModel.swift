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
    /// Bumped after a change made outside a screen (the "+" sheet), so that screen reloads.
    var dataVersion = 0
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
            await MainActor.run { self?.dataVersion += 1 }
        }
        await api.setOnUnauthorized { [weak self] in await self?.sessionExpired() }
        let observer = self.observer
        await api.setOnUnexpectedFailure { method, path, status, decodeError in
            await observer.reportAPIFailure(method: method, path: path, status: status, decodeError: decodeError)
        }
        await api.setOnRequestFinished { trace in await EventLog.shared.record(.request(trace)) }
        EventLog.shared.log(.lifecycle("launch"))
        let uploader = eventUploader
        eventFlushLoop = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                await uploader.flush()
            }
        }
        // The offline banner also covers a server that does not answer while the phone has a network.
        await api.setOnReachability { reached in await MainActor.run { Connectivity.shared.requestFinished(reached: reached) } }
        Connectivity.shared.attach { [api] in let _: Ignored? = try? await api.get("/api/auth/me") }
        let auth = self.auth
        // The revoke of an earlier sign-out is a network call: it must not hold up opening the app.
        Task { await auth.revokePending() }
        guard let user = await auth.restore() else {
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
    func sessionExpired() async {
        let had = await auth.handleUnauthorized()
        OfflineReceiptQueueModel.shared.detach()
        endLocalSession()
        phase = .signedOut(notice: had ? "Istunto vanheni. Kirjaudu uudelleen." : nil)
    }

    /// A 401 to a request made outside `api` (the assistant's stream and receipt upload): it ends
    /// the session only if it was sent with the token still in use, as `APIClient` does.
    func unauthorized(sentToken: String?) async {
        guard let sentToken, await auth.currentToken() == sentToken else { return }
        await sessionExpired()
    }

    func background() {
        backgroundedAt = Date()
        EventLog.shared.log(.lifecycle("background"))
        let uploader = eventUploader
        Task { await uploader.flush() }
    }

    func foreground() async {
        EventLog.shared.log(.lifecycle("foreground"))
        // Back after more than five minutes: what the screens show may be out of date.
        if ForegroundRefresh.isStale(backgroundedAt: backgroundedAt, now: Date()), case .signedIn = phase {
            dataVersion += 1
        }
        backgroundedAt = nil
        await auth.refreshIfDue()
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

    func cachedProfile() async -> Profile? {
        if let profile { return profile }
        let started = session.current
        guard let response: ProfileResponse = try? await api.get("/api/profile"), session.isCurrent(started) else { return profile }
        profile = response.profile
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
}

struct PendingCapture: Identifiable, Equatable {
    let id = UUID()
    /// The bank row to match; nil for a plain "Kuvaa kuitti" (quick action).
    let transactionId: String?
}
