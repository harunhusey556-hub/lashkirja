import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

/// Plays back a script of answers and failures, in order.
private final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
    var script: [Result<HTTPResponse, Error>]
    var requests: [URLRequest] = []
    init(_ script: [Result<HTTPResponse, Error>]) { self.script = script }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        requests.append(request)
        guard !script.isEmpty else { return HTTPResponse(status: 500, headers: [:], body: Data()) }
        return try script.removeFirst().get()
    }
}

private struct Token: TokenProvider { let value: String?; func currentToken() async -> String? { value } }
private let base = URL(string: "https://example.test")!
private let noSleep: @Sendable (UInt64) async -> Void = { _ in }
private func okBody(_ json: String = #"{"ok":true}"#) -> HTTPResponse {
    HTTPResponse(status: 200, headers: ["x-lashkirja-api-version": "1"], body: Data(json.utf8))
}
private struct Ping: Decodable { let ok: Bool }
private actor Counter { var n = 0; func bump() { n += 1 }; var value: Int { n } }
private actor Events { var seen: [Bool] = []; func add(_ reached: Bool) { seen.append(reached) }; var all: [Bool] { seen } }

// MARK: - Retry policy

@Test func getRetriesAtMostThreeTimesWithGrowingBackoff() {
    #expect(RetryPolicy.attempts(method: "GET") == 3)
    #expect(RetryPolicy.attempts(method: "POST") == 1)
    #expect(RetryPolicy.attempts(method: "PATCH") == 1)
    #expect(RetryPolicy.attempts(method: "DELETE") == 1)
    #expect(RetryPolicy.delay(afterAttempt: 0) == 500_000_000)
    #expect(RetryPolicy.delay(afterAttempt: 1) == 1_000_000_000)
}

@Test func onlyGatewayAnswersAreRetried() {
    #expect(RetryPolicy.retriesStatus(502, fromApp: false))
    #expect(RetryPolicy.retriesStatus(503, fromApp: false))
    #expect(RetryPolicy.retriesStatus(504, fromApp: false))
    #expect(!RetryPolicy.retriesStatus(503, fromApp: true))
    #expect(!RetryPolicy.retriesStatus(500, fromApp: false))
    #expect(!RetryPolicy.retriesStatus(401, fromApp: false))
}

@Test func onlyADroppedConnectionIsRetriedNotOffline() {
    #expect(RetryPolicy.retriesTransport(URLError(.networkConnectionLost)))
    #expect(!RetryPolicy.retriesTransport(URLError(.notConnectedToInternet)))
    #expect(!RetryPolicy.retriesTransport(URLError(.cancelled)))
    #expect(!RetryPolicy.retriesTransport(URLError(.timedOut)))
}

@Test func getRetriesADroppedConnectionOnce() async throws {
    let t = ScriptedTransport([.failure(URLError(.networkConnectionLost)), .success(okBody())])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    let ping: Ping = try await c.get("/x")
    #expect(ping.ok)
    #expect(t.requests.count == 2)
}

@Test func postIsNeverRetriedAfterADroppedConnection() async {
    let t = ScriptedTransport([.failure(URLError(.networkConnectionLost)), .success(okBody())])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    await #expect(throws: LKError.self) { let _: Ping = try await c.send("POST", "/x", body: EmptyBody(), idempotencyKey: "k") }
    #expect(t.requests.count == 1)
}

@Test func getGivesUpAfterThreeGatewayAnswers() async {
    let gateway = HTTPResponse(status: 503, headers: [:], body: Data())
    let t = ScriptedTransport([.success(gateway), .success(gateway), .success(gateway), .success(okBody())])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    await #expect(throws: LKError.self) { let _: Ping = try await c.get("/x") }
    #expect(t.requests.count == 3)
}

// MARK: - 401 ends the session once, never loops

@Test func unauthorizedIsNotRetriedAndEndsTheSessionOnce() async {
    let denied = HTTPResponse(status: 401, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"error":"Ei kirjautunut"}"#.utf8))
    let t = ScriptedTransport([.success(denied), .success(okBody())])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: "old"), sleep: noSleep)
    let handled = Counter()
    await c.setOnUnauthorized { await handled.bump() }
    await #expect(throws: LKError.self) { let _: Ping = try await c.get("/x") }
    #expect(t.requests.count == 1)
    #expect(await handled.value == 1)
}

@Test func unauthorizedWithoutASessionDoesNotSignAnyoneOut() async {
    let denied = HTTPResponse(status: 401, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"error":"Ei kirjautunut"}"#.utf8))
    let t = ScriptedTransport([.success(denied)])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    let handled = Counter()
    await c.setOnUnauthorized { await handled.bump() }
    await #expect(throws: LKError.self) { let _: Ping = try await c.get("/x") }
    #expect(await handled.value == 0)
}

@Test func aWrongCurrentPasswordIsNotAnExpiredSession() {
    #expect(!LKError(status: 401, code: "INVALID_PASSWORD", message: "Nykyinen salasana on väärä.").endsSession)
    #expect(LKError(status: 401, code: "UNAUTHORIZED", message: "Ei kirjautunut").endsSession)
}

// MARK: - Reachability

@Test func reachabilityStartsQuiet() {
    #expect(ReachabilityState().notice == nil)
}

@Test func noPathMeansOfflineAndComingBackClearsIt() {
    var state = ReachabilityState()
    state.pathChanged(satisfied: false)
    #expect(state.notice == .offline)
    state.pathChanged(satisfied: true)
    #expect(state.notice == nil)
}

@Test func oneMissedRequestIsNotYetANotice() {
    var state = ReachabilityState()
    state.requestMissedServer()
    #expect(state.notice == nil)
    state.requestMissedServer()
    #expect(state.notice == .serverUnreachable)
}

@Test func anyAnswerFromTheServerClearsTheNotice() {
    var state = ReachabilityState()
    state.requestMissedServer()
    state.requestMissedServer()
    state.requestReachedServer()
    #expect(state.notice == nil)
}

@Test func offlineWinsOverServerUnreachable() {
    var state = ReachabilityState()
    state.requestMissedServer()
    state.requestMissedServer()
    state.pathChanged(satisfied: false)
    #expect(state.notice == .offline)
}

@Test func theNoticeHasCalmFinnishCopy() {
    #expect(ReachabilityState.Notice.offline.title == "Ei verkkoyhteyttä")
    #expect(ReachabilityState.Notice.serverUnreachable.title == "Palvelimeen ei saada yhteyttä")
}

@Test func clientReportsReachedAndMissed() async {
    let events = Events()
    let t = ScriptedTransport([
        .failure(URLError(.notConnectedToInternet)),
        .failure(URLError(.timedOut)),
        .success(HTTPResponse(status: 502, headers: [:], body: Data())),
        .success(HTTPResponse(status: 422, headers: ["x-lashkirja-api-version": "1"], body: Data(#"{"error":"Virhe"}"#.utf8))),
        .success(okBody()),
    ])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    await c.setOnReachability { await events.add($0) }
    _ = try? await c.send("POST", "/a", body: EmptyBody()) as Ignored
    _ = try? await c.send("POST", "/b", body: EmptyBody()) as Ignored
    _ = try? await c.send("POST", "/c", body: EmptyBody()) as Ignored
    _ = try? await c.send("POST", "/d", body: EmptyBody()) as Ignored
    _ = try? await c.send("POST", "/e", body: EmptyBody()) as Ignored
    // A refusal the app wrote still proves the server answered.
    #expect(await events.all == [false, false, false, true, true])
}

@Test func aCancelledRequestSaysNothingAboutReachability() async {
    let events = Events()
    let t = ScriptedTransport([.failure(URLError(.cancelled))])
    let c = APIClient(baseURL: base, transport: t, tokens: Token(value: nil), sleep: noSleep)
    await c.setOnReachability { await events.add($0) }
    _ = try? await c.get("/x") as Ping
    #expect(await events.all.isEmpty)
}

// MARK: - Finnish copy for a failed write

@Test func offlineWriteSaysNothingWasSavedAndWhatToDo() {
    let text = WriteFailureCopy.message(for: LKError.offline(), notDone: "Kopiota ei luotu.", maybeDone: "Kopio on voinut tallentua.", retrySafe: true)
    #expect(text.contains("Ei verkkoyhteyttä"))
    #expect(text.contains("Kopiota ei luotu."))
    #expect(text.contains("kun yhteys palaa"))
    #expect(!text.contains("voinut tallentua"))
}

@Test func lostConnectionMidWriteAdmitsTheOutcomeIsUnknown() {
    let lost = LKError(status: 0, code: "NETWORK", message: LKError.unreachable)
    let text = WriteFailureCopy.message(for: lost, notDone: "Kopiota ei luotu.", maybeDone: "Kopio on voinut tallentua.", retrySafe: true)
    #expect(text.contains("Kopio on voinut tallentua."))
    #expect(text.contains("Tarkista tilanne"))
    #expect(text.contains("ei tee tuplaa"))
    #expect(!text.contains("Kopiota ei luotu."))
    let unsure = WriteFailureCopy.message(for: lost, notDone: "x", maybeDone: "y", retrySafe: false)
    #expect(!unsure.contains("tuplaa"))
}

@Test func aGatewayAnswerIsTreatedAsUnknownToo() {
    let gateway = LKError(status: 502, message: LKError.unreachable)
    let text = WriteFailureCopy.message(for: gateway, notDone: "a", maybeDone: "Muistutus on voinut lähteä.", retrySafe: true)
    #expect(text.contains("Muistutus on voinut lähteä."))
}

@Test func aServerRefusalKeepsItsOwnFinnishSentence() {
    let refused = LKError(status: 409, message: "Muistutus on jo lähetetty tänään.")
    #expect(WriteFailureCopy.message(for: refused, notDone: "a", maybeDone: "b", retrySafe: true) == "Muistutus on jo lähetetty tänään.")
}

@Test func anUnknownErrorNeverShowsRawText() {
    struct Boom: Error {}
    let text = WriteFailureCopy.message(for: Boom(), notDone: "a", maybeDone: "Se on voinut onnistua.", retrySafe: true)
    #expect(text.contains("Se on voinut onnistua."))
}
