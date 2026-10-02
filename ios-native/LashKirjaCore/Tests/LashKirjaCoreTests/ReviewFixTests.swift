import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

private let apiHeader = ["x-lashkirja-api-version": "1"]
private let base = URL(string: "https://example.test")!
private struct Thing: Decodable {}

/// Mutable token for tests: the token can change while a request is in flight.
actor SwitchableToken: TokenProvider {
    var value: String?
    init(_ value: String?) { self.value = value }
    func set(_ v: String?) { value = v }
    func currentToken() async -> String? { value }
}

@Test func unauthorizedWithoutTokenDoesNotSignOut() async {
    // A wrong password on POST /api/auth/token is a 401 with no bearer: not a lost session.
    let t = FakeTransport([HTTPResponse(status: 401, headers: apiHeader, body: Data(#"{"error":"Väärä salasana"}"#.utf8))])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: nil), sleep: { _ in })
    let flag = Flag()
    await c.setOnUnauthorized { await flag.set() }
    await #expect(throws: LKError.self) { let _: Thing = try await c.send("POST", "/api/auth/token", body: EmptyBody()) }
    #expect(await flag.value == false)
}

final class SwapTransport: HTTPTransport, @unchecked Sendable {
    let token: SwitchableToken
    init(_ token: SwitchableToken) { self.token = token }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        await token.set("NEW") // the owner signed in again while the old request was in flight
        return HTTPResponse(status: 401, headers: apiHeader, body: Data(#"{"error":"x"}"#.utf8))
    }
}

@Test func staleUnauthorizedDoesNotClearNewSession() async {
    let token = SwitchableToken("OLD")
    let c = APIClient(baseURL: base, transport: SwapTransport(token), tokens: token, sleep: { _ in })
    let flag = Flag()
    await c.setOnUnauthorized { await flag.set() }
    await #expect(throws: LKError.self) { let _: Thing = try await c.get("/x") }
    #expect(await flag.value == false)
}

@Test func pendingRevokeIsSentLater() async {
    let store = InMemoryTokenStore()
    await store.savePendingRevoke("OLD")
    let t = FakeTransport([HTTPResponse(status: 200, headers: apiHeader, body: Data(#"{"ok":true}"#.utf8))])
    let auth = AuthService(store: store)
    await auth.bind(APIClient(baseURL: base, transport: t, tokens: auth, sleep: { _ in }))
    await auth.revokePending()
    #expect(t.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer OLD")
    #expect(t.requests.first?.url?.path == "/api/auth/logout")
    #expect(await store.loadPendingRevoke() == nil)
}

@Test func pendingRevokeKeptWhenStillOffline() async {
    let store = InMemoryTokenStore()
    await store.savePendingRevoke("OLD")
    let t = FakeTransport([HTTPResponse(status: 502, headers: [:], body: Data())])
    let auth = AuthService(store: store)
    await auth.bind(APIClient(baseURL: base, transport: t, tokens: auth, sleep: { _ in }))
    await auth.revokePending()
    #expect(await store.loadPendingRevoke() == "OLD")
}

@Test func moneyRoundsHalfUpLikeTheWeb() {
    #expect(Money.format(Decimal(string: "0.125")!) == "0,13\u{00A0}€")
    #expect(Money.format(Decimal(string: "2.345")!) == "2,35\u{00A0}€")
}

final class CancellingTransport: HTTPTransport, @unchecked Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResponse { throw CancellationError() }
}

@Test func cancellationIsNotANetworkError() async {
    let c = APIClient(baseURL: base, transport: CancellingTransport(), tokens: FixedToken(value: nil), sleep: { _ in })
    await #expect(throws: CancellationError.self) { let _: Thing = try await c.get("/x") }
}
