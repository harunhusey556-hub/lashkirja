import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

private let apiHeader = ["x-lashkirja-api-version": "1"]
private func json(_ s: String, _ status: Int = 200) -> HTTPResponse { HTTPResponse(status: status, headers: apiHeader, body: Data(s.utf8)) }
private let tokenBody = #"{"token":"T1","tokenType":"Bearer","expiresAt":"2026-11-01T00:00:00.000Z","user":{"userId":"u1","email":"a@b.fi","firstName":"Harun"}}"#
private let fixedNow = Date(timeIntervalSince1970: 1_790_000_000)

private func make(_ responses: [HTTPResponse], now: Date = fixedNow) async -> (AuthService, InMemoryTokenStore, FakeTransport) {
    let store = InMemoryTokenStore()
    let transport = FakeTransport(responses)
    let auth = AuthService(store: store, now: { now })
    let client = APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in })
    await auth.bind(client)
    return (auth, store, transport)
}

@Test func loginStoresTokenAndSendsDevice() async throws {
    let (auth, store, transport) = await make([json(tokenBody)])
    let user = try await auth.login(email: " A@B.fi ", password: "pw")
    #expect(user.firstName == "Harun")
    #expect(await store.load()?.token == "T1")
    let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: String]
    #expect(body == ["email": "a@b.fi", "password": "pw", "device": "ios-app"])
    #expect(transport.requests[0].url?.path == "/api/auth/token")
}

@Test func loginErrorSurfacesServerMessage() async {
    let (auth, store, _) = await make([json(#"{"error":"Väärä sähköposti tai salasana"}"#, 401)])
    await #expect(throws: LKError(status: 401, message: "Väärä sähköposti tai salasana")) { _ = try await auth.login(email: "a@b.fi", password: "x") }
    #expect(await store.load() == nil)
}

@Test func refreshesOnlyWhenOlderThanSevenDays() async throws {
    let (auth, store, transport) = await make([json(tokenBody.replacingOccurrences(of: "T1", with: "T2"))])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400 * 20), issuedAt: fixedNow.addingTimeInterval(-86_400 * 2), userId: "u1"))
    await auth.refreshIfDue()
    #expect(transport.requests.isEmpty)
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400 * 20), issuedAt: fixedNow.addingTimeInterval(-86_400 * 8), userId: "u1"))
    await auth.refreshIfDue()
    #expect(transport.requests.count == 1)
    #expect(transport.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer T1")
    #expect(await store.load()?.token == "T2")
    #expect(await auth.currentToken() == "T2")
}

@Test func refreshFailureClearsSession() async {
    let (auth, store, _) = await make([json(#"{"error":{"code":"UNAUTHORIZED","message":"Kirjaudu uudelleen"}}"#, 401)])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400), issuedAt: fixedNow.addingTimeInterval(-86_400 * 10), userId: "u1"))
    await auth.refreshIfDue()
    #expect(await store.load() == nil)
    #expect(await auth.currentToken() == nil)
}

@Test func refreshKeepsTokenWhenOffline() async {
    let (auth, store, _) = await make([HTTPResponse(status: 502, headers: [:], body: Data())])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400), issuedAt: fixedNow.addingTimeInterval(-86_400 * 10), userId: "u1"))
    await auth.refreshIfDue()
    #expect(await store.load()?.token == "T1")
}

@Test func expiredTokenIsNotRestored() async {
    let (auth, store, _) = await make([])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(-1), issuedAt: fixedNow.addingTimeInterval(-86_400 * 31), userId: "u1"))
    #expect(await auth.restore() == nil)
    #expect(await store.load() == nil)
}

@Test func logoutRevokesOnServer() async {
    let (auth, store, transport) = await make([json(#"{"ok":true}"#)])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400), issuedAt: fixedNow, userId: "u1"))
    await auth.logout()
    #expect(transport.requests[0].url?.path == "/api/auth/logout")
    #expect(transport.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer T1")
    #expect(await store.load() == nil)
    #expect(await store.loadPendingRevoke() == nil)
}

@Test func logoutKeepsTokenForRetryWhenOffline() async {
    let (auth, store, _) = await make([HTTPResponse(status: 502, headers: [:], body: Data())])
    await store.save(StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400), issuedAt: fixedNow, userId: "u1"))
    await auth.logout()
    #expect(await store.load() == nil)
    #expect(await store.loadPendingRevoke() == "T1")
}

// MARK: Session isolation

/// Holds each request until the test answers it, so a logout or a new sign-in can land while a
/// refresh is still on the wire.
private final class GatedTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [(path: String, resume: CheckedContinuation<HTTPResponse, Never>)] = []
    private var sent: [URLRequest] = []

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return sent }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        await withCheckedContinuation { continuation in
            lock.lock()
            sent.append(request)
            waiting.append((request.url?.path ?? "", continuation))
            lock.unlock()
        }
    }

    /// Answers the oldest waiting request to `path`.
    func answer(_ path: String, _ response: HTTPResponse) {
        lock.lock()
        let index = waiting.firstIndex { $0.path == path }
        let entry = index.map { waiting.remove(at: $0) }
        lock.unlock()
        entry?.resume.resume(returning: response)
    }

    func answerAll(_ response: HTTPResponse) {
        lock.lock()
        let all = waiting
        waiting = []
        lock.unlock()
        for entry in all { entry.resume.resume(returning: response) }
    }

    func waitFor(_ count: Int) async {
        for _ in 0..<2_000 where requests.count < count { try? await Task.sleep(nanoseconds: 1_000_000) }
    }
}

private let refreshPath = "/api/auth/token/refresh"
private let dueToken = StoredToken(token: "T1", expiresAt: fixedNow.addingTimeInterval(86_400 * 20), issuedAt: fixedNow.addingTimeInterval(-86_400 * 8), userId: "u1")

private func gated() async -> (AuthService, InMemoryTokenStore, GatedTransport) {
    let store = InMemoryTokenStore()
    let transport = GatedTransport()
    let auth = AuthService(store: store, now: { fixedNow })
    let client = APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in })
    await auth.bind(client)
    return (auth, store, transport)
}

@Test func refreshAnsweredAfterLogoutIsNotStored() async throws {
    let (auth, store, transport) = await gated()
    try await store.save(dueToken)
    let refresh = Task { await auth.refreshIfDue() }
    await transport.waitFor(1)
    let logout = Task { await auth.logout() }
    await transport.waitFor(2)
    transport.answer(refreshPath, json(tokenBody.replacingOccurrences(of: "T1", with: "T2")))
    await refresh.value
    transport.answer("/api/auth/logout", json(#"{"ok":true}"#))
    await logout.value
    #expect(await store.load() == nil)
    #expect(await auth.currentToken() == nil)
}

@Test func refreshRefusedAfterAnotherSignInKeepsTheNewSession() async throws {
    let (auth, store, transport) = await gated()
    try await store.save(dueToken)
    let refresh = Task { await auth.refreshIfDue() }
    await transport.waitFor(1)
    await auth.endSession()
    let login = Task { try await auth.login(email: "b@b.fi", password: "pw") }
    await transport.waitFor(2)
    transport.answer("/api/auth/token", json(tokenBody.replacingOccurrences(of: "T1", with: "T3").replacingOccurrences(of: "u1", with: "u2")))
    _ = try await login.value
    transport.answer(refreshPath, json(#"{"error":{"code":"UNAUTHORIZED","message":"Kirjaudu uudelleen"}}"#, 401))
    await refresh.value
    #expect(await store.load()?.token == "T3")
    #expect(await auth.currentToken() == "T3")
}

@Test func concurrentRefreshesSendOneRequest() async throws {
    let (auth, store, transport) = await gated()
    try await store.save(dueToken)
    let first = Task { await auth.refreshIfDue() }
    let second = Task { await auth.refreshIfDue() }
    await transport.waitFor(1)
    try? await Task.sleep(nanoseconds: 50_000_000)
    transport.answerAll(json(tokenBody.replacingOccurrences(of: "T1", with: "T2")))
    await first.value
    await second.value
    #expect(transport.requests.count == 1)
    #expect(await auth.currentToken() == "T2")
}

@Test func endSessionClearsAtOnceAndLeavesTheRevokeForLater() async throws {
    let (auth, store, transport) = await make([])
    try await store.save(dueToken)
    await auth.endSession()
    #expect(transport.requests.isEmpty)
    #expect(await store.load() == nil)
    #expect(await auth.currentToken() == nil)
    #expect(await store.loadPendingRevoke() == "T1")
}

@Test func finishedRevokeDoesNotForgetALaterSignOut() async throws {
    let (auth, store, transport) = await gated()
    await store.savePendingRevoke("T1")
    let revoke = Task { await auth.revokePending() }
    await transport.waitFor(1)
    await store.savePendingRevoke("T9")
    transport.answer("/api/auth/logout", json(#"{"ok":true}"#))
    await revoke.value
    #expect(await store.loadPendingRevoke() == "T9")
}

private struct DiskFull: Error {}

/// A Keychain that refuses to save.
private actor FailingTokenStore: TokenStore {
    func load() -> StoredToken? { nil }
    func save(_ token: StoredToken) throws { throw DiskFull() }
    func clear() {}
    func loadPendingRevoke() -> String? { nil }
    func savePendingRevoke(_ token: String?) {}
}

@Test func unsavedSignInIsReportedNotPretended() async {
    let transport = FakeTransport([json(tokenBody)])
    let auth = AuthService(store: FailingTokenStore(), now: { fixedNow })
    await auth.bind(APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in }))
    await #expect(throws: LKError(status: 0, code: "KEYCHAIN", message: AuthService.notSavedMessage)) {
        _ = try await auth.login(email: "a@b.fi", password: "pw")
    }
    #expect(AuthService.notSavedMessage == "Kirjautumista ei voitu tallentaa laitteelle.")
    #expect(await auth.currentToken() == nil)
}
