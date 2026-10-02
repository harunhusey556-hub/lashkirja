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
        guard let user = await auth.restore() else {
            phase = .signedOut(notice: nil)
            return
        }
        phase = .signedIn(user)
        await auth.refreshIfDue()
        if let me: MeResponse = try? await api.get("/api/auth/me") { phase = .signedIn(me.user) }
    }

    func login(email: String, password: String) async throws {
        let user = try await auth.login(email: email, password: password)
        Haptics.success()
        phase = .signedIn(user)
    }

    func logout() async {
        await auth.logout()
        phase = .signedOut(notice: nil)
    }

    func foreground() async { await auth.refreshIfDue() }

    private func signedOut(notice: String?) {
        phase = .signedOut(notice: notice)
    }
}

struct MeResponse: Decodable { let user: AuthUser }
