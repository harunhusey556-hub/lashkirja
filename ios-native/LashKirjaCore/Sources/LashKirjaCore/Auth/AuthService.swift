import Foundation

/// Sign-in, the 30-day bearer token, its refresh after 7 days, and sign-out.
public actor AuthService: TokenProvider {
    public static let refreshAfter: TimeInterval = 7 * 86_400
    /// The Keychain refused the token: the sign-in did not stick, so it is not shown as done.
    public static let notSavedMessage = "Kirjautumista ei voitu tallentaa laitteelle."

    private let store: TokenStore
    private let now: @Sendable () -> Date
    private var client: APIClient?
    private var cached: StoredToken?
    /// Bumped whenever the session changes (sign-in, sign-out, expiry). An answer that arrives for
    /// an earlier session (a refresh sent before a sign-out) is dropped instead of written back.
    private var epoch = LoadGeneration()
    /// The refresh on the wire: a second caller waits for it instead of sending another.
    private var refreshing: Task<Void, Never>?

    public init(store: TokenStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.now = now
    }

    public func bind(_ client: APIClient) { self.client = client }

    public func currentToken() async -> String? {
        if cached == nil {
            let session = epoch.current
            let loaded = await store.load()
            // Signed out while the Keychain was read: the old token must not come back.
            guard epoch.isCurrent(session) else { return cached?.token }
            if cached == nil { cached = loaded }
        }
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
        try await start(response)
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
        try await start(response)
        return response.user
    }

    /// Whether this server creates new accounts at all (`SIGNUP_ENABLED`).
    public func signupStatus() async throws -> SignUpStatus {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        return try await client.get("/api/auth/signup/status")
    }

    /// Mails a 6-digit code. The answer is the same whether or not the address has an account.
    public func signupStart(email: String, password: String, firstName: String) async throws -> SignUpStartResponse {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let body = SignUpStartBody(email: email, password: password, firstName: firstName)
        return try await client.send("POST", "/api/auth/signup/start", body: body)
    }

    /// The right code creates the account and answers like `/api/auth/token`: signed in at once.
    public func signupVerify(email: String, code: String) async throws -> AuthUser {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let response: TokenResponse = try await client.send("POST", "/api/auth/signup/verify", body: SignUpVerifyBody(email: email, code: code))
        try await start(response)
        return response.user
    }

    public func signupResend(email: String) async throws {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let _: Ignored = try await client.send("POST", "/api/auth/signup/resend", body: SignUpResendBody(email: email))
    }

    /// The reset mail's code instead of its link. Signs every device out, like the link does.
    public func resetWithCode(email: String, code: String, password: String) async throws {
        guard let client else { throw LKError(status: 0, message: LKError.unreachable) }
        let _: Ignored = try await client.send("POST", "/api/auth/password/reset", body: ResetWithCodeBody(email: email, code: code, password: password))
    }

    /// A stored, unexpired token: the signed-in user without a network call.
    public func restore() async -> AuthUser? {
        guard let stored = await store.load() else { return nil }
        guard stored.expiresAt > now() else {
            epoch.next()
            cached = nil
            await store.clear()
            return nil
        }
        cached = stored
        return AuthUser(userId: stored.userId, email: "", firstName: nil)
    }

    /// Callers at the same time share one request.
    public func refreshIfDue() async {
        if let refreshing { return await refreshing.value }
        let task = Task { await self.refresh() }
        refreshing = task
        await task.value
    }

    private func refresh() async {
        defer { refreshing = nil }
        let session = epoch.current
        guard let client, let stored = await store.load(), epoch.isCurrent(session) else { return }
        guard now().timeIntervalSince(stored.issuedAt) > Self.refreshAfter else { return }
        do {
            let response: TokenResponse = try await client.send("POST", "/api/auth/token/refresh", body: Optional<EmptyBody>.none)
            // Signed out (or in as someone else) meanwhile: this token belongs to a session that
            // has ended. The server issues it for the same session row, so the sign-out's revoke
            // covers it too.
            guard epoch.isCurrent(session) else { return }
            // Not saved: the old token is for the same session and still valid, so keep using it.
            try? await keep(response)
        } catch let error as LKError where error.status == 401 {
            guard epoch.isCurrent(session) else { return }
            epoch.next()
            cached = nil
            await store.clear()
        } catch {
            // Offline or a gateway error: keep the token, try again later.
        }
    }

    /// Ends the session on this device at once: the token is gone before this returns, and is
    /// kept only to be revoked on the server by `revokePending()`, which may wait on the network.
    public func endSession() async {
        epoch.next()
        let token = cached?.token
        cached = nil
        let stored = await store.load()
        await store.clear()
        if let revoke = token ?? stored?.token { await store.savePendingRevoke(revoke) }
    }

    public func logout() async {
        await endSession()
        await revokePending()
    }

    /// A sign-out made offline (or not yet sent): revoke that token on the server now.
    public func revokePending() async {
        guard let client, let token = await store.loadPendingRevoke() else { return }
        do {
            let _: [String: Bool] = try await client.sendWithToken("POST", "/api/auth/logout", token: token)
            await forgetPending(token)
        } catch let error as LKError where error.status == 401 {
            await forgetPending(token) // already invalid on the server
        } catch {
            // Still offline: try again next launch.
        }
    }

    /// Another sign-out may have queued its own token while this one was being revoked.
    private func forgetPending(_ token: String) async {
        if await store.loadPendingRevoke() == token { await store.savePendingRevoke(nil) }
    }

    /// Called on any 401: drop the session. True when one existed.
    public func handleUnauthorized() async -> Bool {
        epoch.next()
        let had = cached != nil
        cached = nil
        let stored = await store.load()
        await store.clear()
        return had || stored != nil
    }

    /// A new session from a sign-in: one that cannot be saved is reported, not pretended.
    private func start(_ response: TokenResponse) async throws {
        epoch.next()
        cached = nil
        do {
            try await keep(response)
        } catch {
            if let client {
                let token = response.token
                Task { let _: [String: Bool]? = try? await client.sendWithToken("POST", "/api/auth/logout", token: token) }
            }
            throw LKError(status: 0, code: "KEYCHAIN", message: Self.notSavedMessage)
        }
    }

    private func keep(_ response: TokenResponse) async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = formatter.date(from: response.expiresAt) ?? now().addingTimeInterval(30 * 86_400)
        let stored = StoredToken(token: response.token, expiresAt: expires, issuedAt: now(), userId: response.user.userId)
        let session = epoch.current
        try await store.save(stored)
        // A sign-out while the Keychain was writing: it cleared before this save landed.
        // Only this token is taken back: a newer sign-in may already have saved its own.
        guard epoch.isCurrent(session) else {
            if await store.load()?.token == stored.token { await store.clear() }
            return
        }
        cached = stored
    }
}
