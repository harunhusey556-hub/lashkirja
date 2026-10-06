import Testing
import Foundation
@testable import LashKirjaCore

private let info = ObserveAppInfo(version: "1.0.0", build: "7", os: "18.2")

// MARK: path scrubbing

@Test func pathScrubReplacesIdsAndDropsQuery() {
    #expect(ObservePath.template("/api/invoices/12345?email=a@b.fi&x=1") == "/api/invoices/:id")
    #expect(ObservePath.template("/api/receipts/3F2504E0-4F89-41D3-9A0C-0305E82C3301/file#frag") == "/api/receipts/:id/file")
    #expect(ObservePath.template("/api/customers/cmgx8k2a90001abcd1234xyz/invoices") == "/api/customers/:id/invoices")
    #expect(ObservePath.template("/api/reports/vat") == "/api/reports/vat")
    #expect(ObservePath.template("api/health") == "/api/health")
}

@Test func pathScrubNeverKeepsHostOrQuery() {
    let t = ObservePath.template("https://example.test/api/sales/42?token=secret")
    #expect(t == "/api/sales/:id")
    #expect(!t.contains("secret") && !t.contains("example"))
}

// MARK: payloads

@Test func apiFailurePayloadIsCompactAndPrivate() {
    let p = ObservePayload.apiFailure(method: "get", path: "/api/invoices/99?name=Matti", status: 503, decodeError: false, app: info)
    #expect(p.source == "native")
    #expect(p.message == "api 503 GET /api/invoices/:id app=1.0.0(7) ios=18.2")
    #expect(!p.message.contains("Matti"))
}

@Test func decodeFailurePayloadSaysDecode() {
    let p = ObservePayload.apiFailure(method: "POST", path: "/api/sales", status: 200, decodeError: true, app: info)
    #expect(p.message == "api decode 200 POST /api/sales app=1.0.0(7) ios=18.2")
}

@Test func payloadEncodesOnlyMessageAndSource() throws {
    let p = ObservePayload.apiFailure(method: "GET", path: "/api/x", status: 500, decodeError: false, app: info)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(p)) as! [String: Any]
    #expect(Set(json.keys) == ["message", "source"])
}

@Test func diagnosticPayloadHasTypeCodesVersionAndFrames() {
    let d = NativeDiagnostic(kind: .crash, exceptionType: 1, exceptionCode: 1, signal: 11,
                             frames: [.init(binary: "LashKirja", offset: 4242), .init(binary: "libswiftCore.dylib", offset: 16)])
    let p = ObservePayload.diagnostic(d, app: info)
    #expect(p.message == "crash type=1 code=1 signal=11 app=1.0.0(7) ios=18.2 frames=LashKirja+0x1092,libswiftCore.dylib+0x10")
    #expect(p.source == "native")
}

@Test func diagnosticPayloadStaysWithinServerLimit() {
    let frames = (0..<50).map { NativeDiagnostic.Frame(binary: "SomeVeryLongFrameworkName\($0)", offset: 123456789) }
    let d = NativeDiagnostic(kind: .hang, exceptionType: nil, exceptionCode: nil, signal: nil, frames: frames)
    let p = ObservePayload.diagnostic(d, app: info)
    #expect(p.message.count <= 300)
    #expect(p.message.hasPrefix("hang app=1.0.0(7)"))
}

@Test func callStackTreeYieldsInnermostFramesOnly() {
    let json = #"""
    {"callStacks":[
      {"threadAttributed":false,"callStackRootFrames":[{"binaryName":"Other","offsetIntoBinaryTextSegment":1,"address":9,"subFrames":[]}]},
      {"threadAttributed":true,"callStackRootFrames":[
        {"binaryName":"dyld","offsetIntoBinaryTextSegment":5,"address":1,"subFrames":[
          {"binaryName":"LashKirja","offsetIntoBinaryTextSegment":100,"address":2,"subFrames":[
            {"binaryName":"SwiftUI","offsetIntoBinaryTextSegment":200,"address":3,"subFrames":[]}]}]}]}]}
    """#
    let frames = NativeDiagnostic.frames(fromCallStackTree: Data(json.utf8), limit: 2)
    #expect(frames == [.init(binary: "SwiftUI", offset: 200), .init(binary: "LashKirja", offset: 100)])
    #expect(NativeDiagnostic.frames(fromCallStackTree: Data("not json".utf8), limit: 5).isEmpty)
}

// MARK: reporter

private actor Sink {
    var sent: [ObservePayload] = []
    var failures = 0
    var failNext = 0
    func send(_ p: ObservePayload) throws {
        if failNext > 0 { failNext -= 1; failures += 1; throw LKError.offline() }
        sent.append(p)
    }
    func setFail(_ n: Int) { failNext = n }
}

private func reporter(_ sink: Sink, signedIn: Bool = true) -> ObserveReporter {
    ObserveReporter(app: info, isSignedIn: { signedIn }, send: { try await sink.send($0) }, sleep: { _ in })
}

@Test func reporterSendsEachPathTemplateAndStatusOncePerSession() async {
    let sink = Sink()
    let r = reporter(sink)
    await r.reportAPIFailure(method: "GET", path: "/api/invoices/1", status: 500, decodeError: false)
    await r.reportAPIFailure(method: "GET", path: "/api/invoices/2", status: 500, decodeError: false)
    await r.reportAPIFailure(method: "GET", path: "/api/invoices/3", status: 502, decodeError: false)
    await r.reportAPIFailure(method: "GET", path: "/api/sales", status: 500, decodeError: false)
    #expect(await sink.sent.count == 3)
}

@Test func reporterDropsWhenSignedOut() async {
    let sink = Sink()
    let r = reporter(sink, signedIn: false)
    await r.reportAPIFailure(method: "GET", path: "/api/x", status: 500, decodeError: false)
    await r.reportDiagnostic(NativeDiagnostic(kind: .crash, exceptionType: nil, exceptionCode: nil, signal: 6, frames: []))
    #expect(await sink.sent.isEmpty)
}

@Test func reporterIgnoresClientErrorsAndItsOwnEndpoint() async {
    let sink = Sink()
    let r = reporter(sink)
    await r.reportAPIFailure(method: "GET", path: "/api/x", status: 404, decodeError: false)
    await r.reportAPIFailure(method: "GET", path: "/api/x", status: 0, decodeError: false)
    await r.reportAPIFailure(method: "POST", path: "/api/observe", status: 500, decodeError: false)
    #expect(await sink.sent.isEmpty)
}

@Test func reporterRetriesOnceThenGivesUp() async {
    let sink = Sink()
    await sink.setFail(1)
    let r = reporter(sink)
    await r.reportAPIFailure(method: "GET", path: "/api/a", status: 500, decodeError: false)
    #expect(await sink.sent.count == 1)

    await sink.setFail(5)
    await r.reportAPIFailure(method: "GET", path: "/api/b", status: 500, decodeError: false)
    #expect(await sink.sent.count == 1)
    #expect(await sink.failures == 3) // 1 for /api/a, then 2 attempts for /api/b, no third
    // A failed report is not retried by a later identical failure either.
    await r.reportAPIFailure(method: "GET", path: "/api/b", status: 500, decodeError: false)
    #expect(await sink.failures == 3)
}
