import Foundation

/// Sign-in, the 30-day bearer token, its refresh after 7 days, and sign-out.
public actor AuthService: TokenProvider {
    public static let refreshAfter: TimeInterval = 7 * 86_400

    private let store: TokenStore
    private let now: @Sendable () -> Date
    private var client: APIClient?
    private var cached: StoredToken?

    public init(store: TokenStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.now = now
    }

    public func bind(_ client: APIClient) { self.client = client }

    public func currentToken() async -> String? {
        if cached == nil { cached = await store.load() }
        return cached?.token
    }

    private struct LoginBody: Encodable {
        let email: String
        let password: String
        let device = "ios-app"
    }

    public func login(email: String, password: String) async throws -> AuthUser {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let body = LoginBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), password: password)
        let response: TokenResponse = try await client.send("POST", "/api/auth/token", body: body)
        await keep(response)
        return response.user
    }

    /// The challenge for a usernameless passkey sign-in.
    public func passkeyOptions() async throws -> PasskeySignInStart {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        return try await client.send("POST", "/api/auth/passkey/authenticate/options", body: EmptyBody())
    }

    /// The server checks the assertion and issues the same bearer session a password sign-in gets.
    public func passkeySignIn(_ verify: PasskeySignInVerify) async throws -> AuthUser {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let response: TokenResponse = try await client.send("POST", "/api/auth/passkey/authenticate/verify", body: verify)
        await keep(response)
        return response.user
    }

    /// A stored, unexpired token: the signed-in user without a network call.
    public func restore() async -> AuthUser? {
        guard let stored = await store.load() else { return nil }
        guard stored.expiresAt > now() else {
            await store.clear()
            cached = nil
            return nil
        }
        cached = stored
        return AuthUser(userId: stored.userId, email: "", firstName: nil)
    }

    public func refreshIfDue() async {
        guard let client, let stored = await store.load() else { return }
        guard now().timeIntervalSince(stored.issuedAt) > Self.refreshAfter else { return }
        do {
            let response: TokenResponse = try await client.send("POST", "/api/auth/token/refresh", body: Optional<EmptyBody>.none)
            await keep(response)
        } catch let error as LKError where error.status == 401 {
            await store.clear()
            cached = nil
        } catch {
            // Offline or a gateway error: keep the token, try again later.
        }
    }

    public func logout() async {
        let token = await currentToken()
        await store.clear()
        cached = nil
        guard let token, let client else { return }
        do {
            let _: [String: Bool] = try await client.sendWithToken("POST", "/api/auth/logout", token: token)
            await store.savePendingRevoke(nil)
        } catch {
            await store.savePendingRevoke(token)
        }
    }

    /// A sign-out made offline: revoke that token on the server now.
    public func revokePending() async {
        guard let client, let token = await store.loadPendingRevoke() else { return }
        do {
            let _: [String: Bool] = try await client.sendWithToken("POST", "/api/auth/logout", token: token)
            await store.savePendingRevoke(nil)
        } catch let error as LKError where error.status == 401 {
            await store.savePendingRevoke(nil) // already invalid on the server
        } catch {
            // Still offline: try again next launch.
        }
    }

    /// Called on any 401: drop the session. True when one existed.
    public func handleUnauthorized() async -> Bool {
        let had = await store.load() != nil
        await store.clear()
        cached = nil
        return had
    }

    private func keep(_ response: TokenResponse) async {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = formatter.date(from: response.expiresAt) ?? now().addingTimeInterval(30 * 86_400)
        let stored = StoredToken(token: response.token, expiresAt: expires, issuedAt: now(), userId: response.user.userId)
        await store.save(stored)
        cached = stored
    }
}
