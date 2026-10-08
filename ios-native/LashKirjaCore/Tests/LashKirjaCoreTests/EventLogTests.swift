import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

private func tempLogURL() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("event-log-\(UUID().uuidString).json")
}

@Test func eventLogKeepsTheNewestPastCapacityAndSurvivesARestart() async {
    let url = tempLogURL()
    defer { try? FileManager.default.removeItem(at: url) }
    let log = EventLog(fileURL: url, capacity: 3)
    for index in 0..<5 { await log.record(.screen("s\(index)")) }
    #expect(await log.pending(max: 10).map(\.screen) == ["s2", "s3", "s4"])
    await log.save()
    let reopened = EventLog(fileURL: url, capacity: 3)
    #expect(await reopened.count == 3)
}

private actor Sent {
    var batches: [EventBatch] = []
    var fail = false
    func add(_ batch: EventBatch) throws {
        if fail { throw LKError(status: 0, message: "offline") }
        batches.append(batch)
    }
    func setFail(_ value: Bool) { fail = value }
}

@Test func uploaderRemovesOnlyWhatTheServerConfirmed() async {
    let log = EventLog(fileURL: nil)
    for index in 0..<250 { await log.record(.screen("s\(index)")) }
    let sent = Sent()
    let uploader = EventLogUploader(log: log, app: ObserveAppInfo(version: "1", build: "2", os: "26"),
                                    isSignedIn: { true }, send: { try await sent.add($0) })
    await sent.setFail(true)
    #expect(await uploader.flush() == false)
    #expect(await log.count == 250)
    await sent.setFail(false)
    #expect(await uploader.flush() == true)
    #expect(await log.count == 0)
    #expect(await sent.batches.map(\.events.count) == [200, 50])
    #expect(await sent.batches.first?.sessionId == EventLog.sessionId)
}

@Test func uploaderSendsNothingSignedOut() async {
    let log = EventLog(fileURL: nil)
    await log.record(.lifecycle("launch"))
    let sent = Sent()
    let uploader = EventLogUploader(log: log, app: ObserveAppInfo(version: "1", build: "2", os: "26"),
                                    isSignedIn: { false }, send: { try await sent.add($0) })
    #expect(await uploader.flush() == false)
    #expect(await log.count == 1)
}

@Test func problemReportCodeIsShortAndUnambiguous() {
    let code = ProblemReport.newCode()
    #expect(code.count == 6)
    #expect(!code.contains("O") && !code.contains("0") && !code.contains("I") && !code.contains("1"))
    let event = ProblemReport.event(code: code, note: "  kuva ei latautunut \n", screen: "receipts")
    #expect(event.kind == "report" && event.name == code && event.message == "kuva ei latautunut")
}

private actor Traces {
    var all: [RequestTrace] = []
    func add(_ trace: RequestTrace) { all.append(trace) }
}

@Test func everyRequestCarriesAnIdAndIsTraced() async throws {
    let t = FakeTransport([
        HTTPResponse(status: 200, headers: ["X-LashKirja-Api-Version": "1"], body: Data(#"{"ok":true}"#.utf8)),
        HTTPResponse(status: 422, headers: ["X-LashKirja-Api-Version": "1"], body: Data(#"{"error":"Ei käy","code":"BAD"}"#.utf8)),
        HTTPResponse(status: 200, headers: [:], body: Data("{}".utf8)),
    ])
    let c = APIClient(baseURL: URL(string: "https://example.test")!, transport: t, tokens: FixedToken(value: "abc"), sleep: { _ in })
    let traces = Traces()
    await c.setOnRequestFinished { await traces.add($0) }
    let _: Me = try await c.get("/api/auth/me")
    await #expect(throws: LKError.self) { let _: Me = try await c.send("POST", "/api/receipts", body: EmptyBody()) }
    let _: Me? = try? await c.send("POST", "/api/observe/events", body: EmptyBody())
    for _ in 0..<50 where await traces.all.count < 2 { try await Task.sleep(nanoseconds: 10_000_000) }

    let ids = t.requests.compactMap { $0.value(forHTTPHeaderField: "X-Request-Id") }
    #expect(ids.count == 3 && Set(ids).count == 3)
    let all = await traces.all.sorted { $0.path < $1.path }
    #expect(all.map(\.path) == ["/api/auth/me", "/api/receipts"])
    #expect(all[0].status == 200 && all[0].error == nil && all[0].requestId == ids[0])
    #expect(all[1].status == 422 && all[1].error == "BAD: Ei käy")
}

@Test func eventsSavedByAnEarlierBuildStillLoadAndGetAnId() throws {
    let old = #"[{"ts":"2026-10-08T09:55:23Z","kind":"screen","screen":"receipts"}]"#
    let events = try JSONDecoder().decode([AppEvent].self, from: Data(old.utf8))
    #expect(events.count == 1 && !events[0].id.isEmpty && events[0].screen == "receipts")
    #expect(AppEvent.screen("a").id != AppEvent.screen("a").id)
}

@Test func aTapIsOnDiskAtOnceAndTheLastScreenIsKnown() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("event-log-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: url) }
    let log = EventLog(fileURL: url)
    await log.record(.screen("receipts"))
    #expect(!FileManager.default.fileExists(atPath: url.path))
    await log.record(.action("clear-sent", screen: "receipts"))
    // Without an explicit save: a freeze right after the tap must not lose it.
    let saved = try JSONDecoder().decode([AppEvent].self, from: Data(contentsOf: url))
    #expect(saved.map(\.kind) == ["screen", "action"])
    #expect(await log.lastScreen == "receipts")
}

private actor Sends {
    var count = 0
    func add() -> Int { count += 1; return count }
}

@Test func aFlushDoesNotChaseTheEventsItsOwnUploadsCause() async {
    // Each upload used to mark the screens stale; their reloads logged new events and the same
    // flush sent those too, for ever. A flush now sends only what waited when it began.
    let log = EventLog(fileURL: nil)
    for index in 0..<3 { await log.record(.screen("s\(index)")) }
    let sends = Sends()
    let uploader = EventLogUploader(log: log, app: ObserveAppInfo(version: "1", build: "2", os: "26"),
                                    isSignedIn: { true }, send: { _ in
        _ = await sends.add()
        await log.record(AppEvent(kind: "request", method: "GET", path: "/api/dashboard", status: 200))
    })
    #expect(await uploader.flush() == true)
    #expect(await sends.count == 1)
    #expect(await log.count == 1)
}

@Test func failedRequestsAreDurableButCancellationsAreNot() {
    #expect(AppEvent(kind: "request", status: 0, message: "URLError").isDurable)
    #expect(AppEvent(kind: "request", status: 502).isDurable)
    #expect(!AppEvent(kind: "request", status: 0, message: "cancelled").isDurable)
    #expect(!AppEvent(kind: "request", status: 200).isDurable)
    #expect(AppEvent.action("x").isDurable)
}
