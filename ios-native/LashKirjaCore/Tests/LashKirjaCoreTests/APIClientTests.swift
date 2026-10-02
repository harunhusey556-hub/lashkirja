import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    var responses: [HTTPResponse]
    var requests: [URLRequest] = []
    init(_ responses: [HTTPResponse]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        requests.append(request)
        return responses.isEmpty ? HTTPResponse(status: 500, headers: [:], body: Data()) : responses.removeFirst()
    }
}

struct FixedToken: TokenProvider { let value: String?; func currentToken() async -> String? { value } }

private func ok(_ json: String) -> HTTPResponse {
    HTTPResponse(status: 200, headers: ["X-LashKirja-Api-Version": "1"], body: Data(json.utf8))
}
private let base = URL(string: "https://example.test")!
private let noSleep: @Sendable (UInt64) async -> Void = { _ in }

struct Me: Decodable, Equatable { let ok: Bool }

@Test func sendsBearerAndNoOrigin() async throws {
    let t = FakeTransport([ok(#"{"ok":true}"#)])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: "abc"), sleep: noSleep)
    let me: Me = try await c.get("/api/auth/me", query: ["month": "2026-10"])
    #expect(me == Me(ok: true))
    let r = t.requests[0]
    #expect(r.url?.absoluteString == "https://example.test/api/auth/me?month=2026-10")
    #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
    #expect(r.value(forHTTPHeaderField: "Origin") == nil)
    #expect(r.value(forHTTPHeaderField: "Accept") == "application/json")
}

@Test func getRetriesGatewayErrors() async throws {
    let gateway = HTTPResponse(status: 502, headers: [:], body: Data("bad gateway".utf8))
    let t = FakeTransport([gateway, gateway, ok(#"{"ok":true}"#)])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: nil), sleep: noSleep)
    let me: Me = try await c.get("/x")
    #expect(me.ok)
    #expect(t.requests.count == 3)
}

@Test func appErrorIsNotRetried() async {
    let appError = HTTPResponse(status: 503, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"error":"Huolto"}"#.utf8))
    let t = FakeTransport([appError])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: nil), sleep: noSleep)
    await #expect(throws: LKError(status: 503, message: "Huolto")) { let _: Me = try await c.get("/x") }
    #expect(t.requests.count == 1)
}

@Test func postNeverRetries() async {
    let t = FakeTransport([HTTPResponse(status: 502, headers: [:], body: Data())])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: nil), sleep: noSleep)
    await #expect(throws: LKError.self) { let _: Me = try await c.send("POST", "/x", body: EmptyBody(), idempotencyKey: "k1") }
    #expect(t.requests.count == 1)
    #expect(t.requests[0].value(forHTTPHeaderField: "Idempotency-Key") == "k1")
    #expect(t.requests[0].value(forHTTPHeaderField: "Content-Type") == "application/json")
}

actor Flag { var value = false; func set() { value = true } }

@Test func unauthorizedCallsHandler() async {
    let t = FakeTransport([HTTPResponse(status: 401, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"error":"Ei kirjautunut"}"#.utf8))])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: "old"), sleep: noSleep)
    let flag = Flag()
    await c.setOnUnauthorized { await flag.set() }
    await #expect(throws: LKError.self) { let _: Me = try await c.get("/x") }
    #expect(await flag.value)
}

@Test func undecodableSuccessIsAnError() async {
    let t = FakeTransport([ok("not json")])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: nil), sleep: noSleep)
    await #expect(throws: LKError.self) { let _: Me = try await c.get("/x") }
}
