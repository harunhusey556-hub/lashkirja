import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

// Pääsyavaimet (M057, G001): its two reads go out together and land as one screen, and only the
// server's own "not set up" answer hides the create button.

private let header = ["x-lashkirja-api-version": "1"]
private func reply(_ body: String, _ status: Int = 200) -> HTTPResponse {
    HTTPResponse(status: status, headers: header, body: Data(body.utf8))
}
private let oneKey = #"{"passkeys":[{"id":"k1","deviceName":"iPhone","createdAt":"2026-09-01T10:00:00.000Z","lastUsedAt":null}]}"#
private let configured = #"{"web":true,"native":true}"#
private let notConfigured = #"{"web":true,"native":false}"#

/// Holds each request until the test answers it, as AuthServiceTests' gated transport does.
private final class Gate: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [(path: String, resume: CheckedContinuation<HTTPResponse, Never>)] = []
    private var sent: [String] = []

    var paths: [String] { lock.lock(); defer { lock.unlock() }; return sent }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        await withCheckedContinuation { continuation in
            lock.lock()
            sent.append(request.url?.path ?? "")
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

    func waitFor(_ count: Int) async {
        for _ in 0..<2_000 where paths.count < count { try? await Task.sleep(nanoseconds: 1_000_000) }
    }
}

/// Answers each path at once as scripted; a path without an answer throws `error`.
private final class Script: HTTPTransport, @unchecked Sendable {
    private let answers: [String: HTTPResponse]
    private let error: Error

    init(_ answers: [String: HTTPResponse], error: Error = URLError(.notConnectedToInternet)) {
        self.answers = answers
        self.error = error
    }

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        if let response = answers[request.url?.path ?? ""] { return response }
        throw error
    }
}

private final class Finished: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return raised }
    func raise() { lock.lock(); raised = true; lock.unlock() }
}

private func client(_ transport: HTTPTransport) -> APIClient {
    APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: FixedToken(value: "t"), sleep: { _ in })
}

@Test func bothPasskeyReadsAreOnTheWireTogetherAndLandAsOneScreen() async throws {
    let gate = Gate()
    let api = client(gate)
    let finished = Finished()
    let load = Task { () -> Result<PasskeyScreen, Error> in
        let result = await PasskeyScreen.load(api: api)
        finished.raise()
        return result
    }
    await gate.waitFor(2)
    // Neither is answered yet and both are out: one after the other, the second waited on the first.
    #expect(Set(gate.paths) == [PasskeyScreen.listPath, PasskeyScreen.statusPath])
    gate.answer(PasskeyScreen.listPath, reply(oneKey))
    for _ in 0..<200 { await Task.yield() }
    // The list alone is not handed over: drawn on its own, the create row came in under it later.
    #expect(!finished.value)
    gate.answer(PasskeyScreen.statusPath, reply(configured))
    let screen = try await load.value.get()
    #expect(screen.passkeys.map(\.id) == ["k1"])
    #expect(screen.canCreate)
}

@Test func aFailedPasskeyReadIsAFailureNotCannotCreateHere() async {
    let scripts = [
        // The status answered 500.
        Script([PasskeyScreen.listPath: reply(oneKey), PasskeyScreen.statusPath: reply(#"{"error":"Pääsyavaintoiminto epäonnistui. Yritä uudelleen."}"#, 500)]),
        // The status never arrived: no connection.
        Script([PasskeyScreen.listPath: reply(oneKey)]),
        // The list never arrived while the status said "not set up".
        Script([PasskeyScreen.statusPath: reply(notConfigured)]),
    ]
    for script in scripts {
        let result = await PasskeyScreen.load(api: client(script))
        switch result {
        case .success(let screen):
            Issue.record("a failed read gave a screen (canCreate \(screen.canCreate)): it said passkeys are not set up")
        case .failure(let error):
            // Shown as the failure with its retry, over the list already on screen.
            #expect(LoadFailure(error) != nil)
        }
    }
}

@Test func aCancelledPasskeyReadStaysACancellation() async {
    let result = await PasskeyScreen.load(api: client(Script([PasskeyScreen.listPath: reply(oneKey)], error: CancellationError())))
    guard case .failure(let error) = result else {
        Issue.record("a cancelled status read gave a screen")
        return
    }
    // Nothing to show: the screen went away, and what it showed (the create button too) stays.
    #expect(error is CancellationError)
}

@Test func onlyTheServersNotSetUpAnswerSaysAPasskeyCannotBeMadeHere() async throws {
    let off = try await PasskeyScreen.load(api: client(Script([
        PasskeyScreen.listPath: reply(#"{"passkeys":[]}"#), PasskeyScreen.statusPath: reply(notConfigured),
    ]))).get()
    #expect(off.passkeys.isEmpty)
    #expect(!off.canCreate)
    let on = try await PasskeyScreen.load(api: client(Script([
        PasskeyScreen.listPath: reply(oneKey), PasskeyScreen.statusPath: reply(configured),
    ]))).get()
    #expect(on.canCreate)
    #expect(on.passkeys.first?.deviceName == "iPhone")
}
