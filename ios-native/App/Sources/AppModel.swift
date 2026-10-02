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
        phase = .signedOut(notice: nil)
        let auth = self.auth
        Task { await auth.logout() }
    }

    func foreground() async { await auth.refreshIfDue() }

    private func signedOut(notice: String?) {
        phase = .signedOut(notice: notice)
    }
}

struct MeResponse: Decodable { let user: AuthUser }
