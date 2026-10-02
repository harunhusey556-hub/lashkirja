import Testing
import Foundation
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
