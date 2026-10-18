import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

// Row 27: a revoked stored session reaches the sign-in screen in about one round trip. Since w67
// nothing is held for a session check at launch (the cached screens' own loads verify the session);
// the first 401 from any request ends the session once (never retried), the session's other
// requests are cancelled, and no answer (offline, a timeout) is not a refusal.

/// Answers each request with `answer(path)`, which may wait (cancellably) on a `Gate`.
private final class PathTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String] = []
    private let answer: @Sendable (String) async throws -> HTTPResponse
    init(_ answer: @escaping @Sendable (String) async throws -> HTTPResponse) { self.answer = answer }
    var paths: [String] { lock.withLock { sent } }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let path = request.url?.path ?? ""
        lock.withLock { sent.append(path) }
        return try await answer(path)
    }
}

private actor Gate {
    private var open = false
    func release() { open = true }
    /// Throws CancellationError when the waiting request is cancelled.
    func wait() async throws {
        while !open { try await Task.sleep(nanoseconds: 1_000_000) }
    }
}

private actor Tally { var n = 0; func bump() { n += 1 }; var value: Int { n } }
private struct StoredToken: TokenProvider { func currentToken() async -> String? { "stored" } }
private struct Ok: Decodable { let ok: Bool }

private let base = URL(string: "https://example.test")!
private let realSleep: @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }
private let refused = HTTPResponse(status: 401, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"user":null}"#.utf8))
private func ok(_ json: String = #"{"ok":true}"#) -> HTTPResponse {
    HTTPResponse(status: 200, headers: ["x-lashkirja-api-version": "1"], body: Data(json.utf8))
}

/// Polls until `condition` holds (or a second has passed).
private func eventually(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
    return await condition()
}

@Test func firstUnauthorizedCancelsTheSessionsOtherRequestsAndSignsOutOnce() async {
    let gate = Gate()
    let t = PathTransport { path in
        switch path {
        case "/api/receipts": try await gate.wait(); return ok()
        default: return refused
        }
    }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let signOuts = Tally()
    await c.setOnUnauthorized { _ in await signOuts.bump() }
    let slow = Task { () -> Error? in
        do { let _: Ok = try await c.get("/api/receipts"); return nil } catch { return error }
    }
    #expect(await eventually { t.paths.contains("/api/receipts") })
    // The 401 is not retried (one request on the wire for it) and ends the session.
    await #expect(throws: LKError.self) { let _: Ok = try await c.get("/api/sync/version") }
    #expect(t.paths.filter { $0 == "/api/sync/version" }.count == 1)
    // The request still out for that session is cancelled, not waited for.
    #expect(await slow.value is CancellationError)
    #expect(await signOuts.value == 1)
}

@Test func unauthorizedAnswersTogetherSignOutOnce() async {
    let gate = Gate()
    let t = PathTransport { _ in try await gate.wait(); return refused }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let signOuts = Tally()
    await c.setOnUnauthorized { _ in await signOuts.bump() }
    let loads = ["/api/dashboard", "/api/receipts", "/api/sync/version"].map { path in
        Task { () -> Error? in
            do { let _: Ok = try await c.get(path); return nil } catch { return error }
        }
    }
    #expect(await eventually { t.paths.count == 3 })
    await gate.release()
    var refusals = 0
    for load in loads where await load.value is LKError { refusals += 1 }
    // One 401 ends the session; the others end as cancellations, with nothing to show.
    #expect(refusals == 1)
    #expect(await signOuts.value == 1)
    #expect(t.paths.count == 3)
}

@Test func signOutCancelsRequestsStillOut() async {
    let gate = Gate()
    let t = PathTransport { _ in try await gate.wait(); return ok() }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let load = Task { () -> Error? in
        do { let _: Ok = try await c.get("/api/dashboard"); return nil } catch { return error }
    }
    #expect(await eventually { t.paths == ["/api/dashboard"] })
    await c.endSessionRequests()
    #expect(await load.value is CancellationError)
}

@Test func aWriteOnTheWireFinishesWhenTheSessionEnds() async {
    let gate = Gate()
    let t = PathTransport { path in
        switch path {
        case "/api/receipts/save": try await gate.wait(); return ok()
        default: return refused
        }
    }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let signOuts = Tally()
    await c.setOnUnauthorized { _ in await signOuts.bump() }
    let save = Task { () -> Bool in
        ((try? await c.send("POST", "/api/receipts/save", body: EmptyBody()) as Ok)?.ok) ?? false
    }
    #expect(await eventually { t.paths.contains("/api/receipts/save") })
    // A sibling's 401 ends the session while the save is out, and so does a sign-out.
    await #expect(throws: LKError.self) { let _: Ok = try await c.get("/api/sync/version") }
    await c.endSessionRequests()
    #expect(await signOuts.value == 1)
    // The server may already have stored it: the save is answered, not cancelled client-side.
    await gate.release()
    #expect(await save.value)
}

@Test func launchLoadsGoOutTogetherWithNothingHeld() async {
    let gate = Gate()
    let t = PathTransport { path in
        if path == "/api/auth/me" { try await gate.wait(); return refused }
        return ok()
    }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let signOuts = Tally()
    await c.setOnUnauthorized { _ in await signOuts.bump() }
    let me = Task { () -> Error? in
        do { let _: Ok = try await c.get("/api/auth/me"); return nil } catch { return error }
    }
    // Koti's load is answered while the session's own check is still out.
    let koti: Ok? = try? await c.get("/api/dashboard")
    #expect(koti?.ok == true)
    await gate.release()
    #expect(await me.value is LKError)
    #expect(await signOuts.value == 1)
}

@Test func offlineLaunchKeepsTheOwnerSignedIn() async {
    let t = PathTransport { _ in throw URLError(.notConnectedToInternet) }
    let c = APIClient(baseURL: base, transport: t, tokens: StoredToken(), sleep: realSleep)
    let signOuts = Tally()
    await c.setOnUnauthorized { _ in await signOuts.bump() }
    await #expect(throws: LKError.offline()) { let _: Ok = try await c.get("/api/auth/me") }
    await #expect(throws: LKError.offline()) { let _: Ok = try await c.get("/api/dashboard") }
    #expect(await signOuts.value == 0)
}
