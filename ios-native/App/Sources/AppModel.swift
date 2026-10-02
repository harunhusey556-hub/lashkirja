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
    /// The owner's profile, loaded once and kept: forms and the ALV screen read VAT settings from
    /// it instead of asking the server each time. Settings screens hand back what they save.
    private(set) var profile: Profile?
    /// The assistant's conversation outlives its sheet: closing with "Valmis" and opening again
    /// returns to the same conversation (a new, still empty one included), not the latest stored one.
    var chat: ChatModel?
    let auth: AuthService
    let api: APIClient

    init(baseURL: URL = AppConfig.apiBaseURL, store: TokenStore = KeychainTokenStore()) {
        let auth = AuthService(store: store)
        self.auth = auth
        self.api = APIClient(baseURL: baseURL, transport: URLSessionTransport(), tokens: auth)
    }

    func start() async {
        await auth.bind(api)
        let auth = self.auth
        await api.setOnUnauthorized { [weak self] in
            let had = await auth.handleUnauthorized()
            await self?.signedOut(notice: had ? "Istunto vanheni. Kirjaudu uudelleen." : nil)
        }
        await auth.revokePending()
        guard let user = await auth.restore() else {
            phase = .signedOut(notice: nil)
            return
        }
        phase = .signedIn(user)
        await auth.refreshIfDue()
        // A refused refresh already signed out (with the notice): stop here.
        guard await auth.currentToken() != nil else { return }
        if let me: MeResponse = try? await api.get("/api/auth/me"), case .signedIn = phase {
            phase = .signedIn(me.user)
        }
    }

    func login(email: String, password: String) async throws {
        let user = try await auth.login(email: email, password: password)
        Haptics.success()
        phase = .signedIn(user)
        Task { await auth.revokePending() }
    }

    /// Signed out at once; the server revoke runs behind (it may take the full
    /// timeout when the server is unreachable, and then retries next launch).
    func logout() async {
        // The lock belongs to the signed-in owner; the next account sets its own.
        AppLock.shared.disable()
        profile = nil
        chat = nil
        phase = .signedOut(notice: nil)
        let auth = self.auth
        Task { await auth.logout() }
    }

    func foreground() async { await auth.refreshIfDue() }

    func cachedProfile() async -> Profile? {
        if let profile { return profile }
        if let response: ProfileResponse = try? await api.get("/api/profile") { profile = response.profile }
        return profile
    }

    func profileChanged(_ new: Profile?) { profile = new }

    private func signedOut(notice: String?) {
        profile = nil
        chat = nil
        phase = .signedOut(notice: notice)
    }
}

struct MeResponse: Decodable { let user: AuthUser }
