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
    /// A password reset link handed to the app (`lashkirja://…?token=…`), waiting for the
    /// sign-in screen to open the reset form with it.
    var pendingResetLink: String?
    /// When the app went to the background: coming back after a while reloads the screens.
    private var backgroundedAt: Date?
    /// Bumped whenever the signed-in session starts or ends: an answer that arrives for an earlier
    /// session (a profile, `/api/auth/me`, a failed delete) is dropped, not shown to the next one.
    private var session = LoadGeneration()
    let auth: AuthService
    let api: APIClient

    init(baseURL: URL = AppConfig.apiBaseURL, store: TokenStore = KeychainTokenStore()) {
        let auth = AuthService(store: store)
        self.auth = auth
        self.api = APIClient(baseURL: baseURL, transport: URLSessionTransport(), tokens: auth)
    }

    func start() async {
        await auth.bind(api)
        // Every write the server accepts marks what the screens show as out of date, so a list
        // reloads when the owner comes back to it after acting on a detail screen or a sheet.
        // Sign-in and chat housekeeping change no bookkeeping data.
        await api.setOnWrite { [weak self] path in
            guard !path.hasPrefix("/api/auth"), !path.hasPrefix("/api/ai/") else { return }
            await MainActor.run { self?.dataVersion += 1 }
        }
        await api.setOnUnauthorized { [weak self] in await self?.sessionExpired() }
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
    }

    func foreground() async {
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
        Haptics.success()
        let started = session.current
        Task {
            do { try await work() }
            catch {
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
        profile = nil
        removedIds = []
        pendingRoute = nil
        removalFailure = nil
    }
}

struct MeResponse: Decodable { let user: AuthUser }

struct PendingRoute: Equatable {
    let tab: AppTab
    let route: Route
}
