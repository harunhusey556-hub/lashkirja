import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol TokenProvider: Sendable {
    func currentToken() async -> String?
}

public struct EmptyBody: Codable, Sendable { public init() {} }

/// Every call to the LashKirja server. GETs retry a gateway 502/503/504 (not
/// one the app itself answered) three times with backoff; writes never retry.
public actor APIClient {
    private let baseURL: URL
    private let transport: HTTPTransport
    private let tokens: TokenProvider
    private let sleep: @Sendable (UInt64) async -> Void
    /// Told the token a refused request (401) was sent with, so the session ends only if that
    /// token is still the one in use when the handler runs.
    public private(set) var onUnauthorized: (@Sendable (String) async -> Void)?
    /// Told the path of every write the server accepted, so the app can mark what it shows as
    /// out of date without each screen remembering to.
    public private(set) var onWrite: (@Sendable (String) async -> Void)?
    /// Told after each request whether the server answered (true) or the request never got an
    /// answer (false), for the offline indicator. A cancelled request says nothing.
    public private(set) var onReachability: (@Sendable (Bool) async -> Void)?
    /// Told (method, path, status, decodeError) of a 5xx the server answered or an answer that
    /// would not decode, never of offline, timeouts or 4xx. Runs detached: it cannot slow a request.
    public private(set) var onUnexpectedFailure: (@Sendable (String, String, Int, Bool) async -> Void)?
    /// Told about every request once it is over (the debugging trail, `EventLog`). Runs
    /// detached; the trail's own uploads (/api/observe…) are not reported.
    public private(set) var onRequestFinished: (@Sendable (RequestTrace) async -> Void)?
    /// Bumped when a session ends here (its first refusing 401, or `endSessionRequests()`): a
    /// request that started for an earlier session ends as a cancellation, so no screen shows an
    /// error for a session that is already gone, and a second 401 signs nobody out again.
    private var sessionGeneration = 0
    /// The requests on the wire with a session's token, cancelled when that session ends.
    private var sessionRequests: [UUID: Task<HTTPResponse, Error>] = [:]
    /// While the launch's session check is out (`checkSession`), every other request waits on this,
    /// at most `hold`: the stored token's verdict comes back alone instead of behind the burst of
    /// launch loads (7–9 s on a CI runner, w49).
    private var launchHold: Task<Void, Never>?

    public init(baseURL: URL, transport: HTTPTransport, tokens: TokenProvider,
                sleep: @escaping @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
        self.sleep = sleep
    }

    public func setOnUnauthorized(_ handler: (@Sendable (String) async -> Void)?) { onUnauthorized = handler }
    public func setOnWrite(_ handler: (@Sendable (String) async -> Void)?) { onWrite = handler }
    public func setOnReachability(_ handler: (@Sendable (Bool) async -> Void)?) { onReachability = handler }

    /// Asks `path` with the stored token, first and alone: the other requests wait until it is
    /// answered or `hold` seconds have passed, whichever comes first. Past the hold the check still
    /// runs, and its 401 (like any request's) ends the session when it comes. Only a refusing 401
    /// is `.refused`; offline, a timeout or a server failure says nothing about the session.
    public func checkSession(_ path: String, hold: TimeInterval) -> Task<SessionCheck, Never> {
        let sleep = self.sleep
        let gate = Task { await sleep(UInt64(hold * 1_000_000_000)) }
        launchHold = gate
        return Task {
            let outcome: SessionCheck
            do {
                let response = try await self.perform("GET", path, query: [:], body: nil, contentType: nil,
                                                      idempotencyKey: nil, held: false)
                outcome = .accepted(response.body)
            } catch let error as LKError where error.endsSession {
                outcome = .refused
            } catch {
                outcome = .unanswered
            }
            self.openHold(gate)
            return outcome
        }
    }

    private func openHold(_ gate: Task<Void, Never>) {
        gate.cancel()
        if launchHold == gate { launchHold = nil }
    }

    /// The session ended on this device (sign-out, or a 401 seen outside this client): its
    /// requests still on the wire are cancelled and any still waiting never go out.
    public func endSessionRequests() {
        sessionGeneration += 1
        for request in sessionRequests.values { request.cancel() }
        sessionRequests = [:]
        launchHold?.cancel()
        launchHold = nil
    }

    public func setOnUnexpectedFailure(_ handler: (@Sendable (String, String, Int, Bool) async -> Void)?) { onUnexpectedFailure = handler }
    public func setOnRequestFinished(_ handler: (@Sendable (RequestTrace) async -> Void)?) { onRequestFinished = handler }

    private func noteFinished(_ method: String, _ path: String, status: Int, started: Date, requestId: String, error: Error?) {
        guard let handler = onRequestFinished, !path.hasPrefix("/api/observe") else { return }
        let trace = RequestTrace(method: method, path: path, status: status,
                                 durationMs: Int(Date().timeIntervalSince(started) * 1000),
                                 requestId: requestId, error: error.map(Self.traceDescription))
        Task.detached { await handler(trace) }
    }

    /// The error code and message the owner saw, or the kind of failure without an answer.
    static func traceDescription(_ error: Error) -> String {
        if let failure = error as? LKError { return [failure.code, failure.message].compactMap { $0 }.joined(separator: ": ") }
        if error is CancellationError { return "cancelled" }
        return String(describing: type(of: error))
    }

    private func noteUnexpected(_ method: String, _ path: String, _ status: Int, decodeError: Bool) {
        guard let handler = onUnexpectedFailure else { return }
        Task.detached { await handler(method, path, status, decodeError) }
    }

    public func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let response = try await perform("GET", path, query: query, body: nil, contentType: nil, idempotencyKey: nil)
        return try decode(response, method: "GET", path: path)
    }

    public func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String] = [:], body: B?, idempotencyKey: String? = nil) async throws -> T {
        let data = try body.map { try JSONEncoder().encode($0) }
        let response = try await perform(method, path, query: query, body: data, contentType: data == nil ? nil : "application/json", idempotencyKey: idempotencyKey)
        return try decode(response, method: method, path: path)
    }

    public func raw(_ method: String, _ path: String, query: [String: String] = [:], body: Data?, contentType: String?, idempotencyKey: String? = nil) async throws -> HTTPResponse {
        try await perform(method, path, query: query, body: body, contentType: contentType, idempotencyKey: idempotencyKey)
    }

    /// A write with a given bearer token (sign-out after the store is cleared).
    public func sendWithToken<T: Decodable>(_ method: String, _ path: String, token: String) async throws -> T {
        var request = URLRequest(url: url(path, query: [:]))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let response: HTTPResponse
        do { response = try await transport.send(request) }
        catch { throw Self.transportError(error) }
        guard (200..<300).contains(response.status) else { throw APIErrorDecoder.decode(status: response.status, data: response.body) }
        return try decode(response)
    }

    /// A cancelled request (the screen went away) stays a cancellation, so
    /// views can ignore it instead of showing "no connection".
    static func transportError(_ error: Error) -> Error {
        if error is CancellationError { return error }
        if let url = error as? URLError {
            switch url.code {
            case .cancelled: return CancellationError()
            // The request never left the phone.
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return LKError.offline()
            // It may have reached the server: a write's outcome is unknown, as with NETWORK.
            case .timedOut: return LKError(status: 0, code: "TIMEOUT", message: LKError.unreachable)
            default: break
            }
        }
        return LKError(status: 0, code: "NETWORK", message: LKError.unreachable)
    }

    private func decode<T: Decodable>(_ response: HTTPResponse, method: String? = nil, path: String? = nil) throws -> T {
        // A 204 (or any empty body) reads as an empty object.
        let body = response.body.isEmpty ? Data("{}".utf8) : response.body
        do { return try JSONDecoder().decode(T.self, from: body) }
        catch {
            if let method, let path { noteUnexpected(method, path, response.status, decodeError: true) }
            throw LKError(status: response.status, code: "DECODE", message: "Palvelimen vastausta ei voitu lukea.")
        }
    }

    private func url(_ path: String, query: [String: String]) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return components.url!
    }

    private func perform(_ method: String, _ path: String, query: [String: String], body: Data?, contentType: String?, idempotencyKey: String?,
                         held: Bool = true) async throws -> HTTPResponse {
        // Sent as X-Request-Id: the server logs its errors under the same id.
        let requestId = String(UUID().uuidString.prefix(8)).lowercased()
        let started = Date()
        let generation = sessionGeneration
        if held, let launchHold { await launchHold.value }
        do {
            let response = try await attempt(method, path, query: query, body: body, contentType: contentType,
                                             idempotencyKey: idempotencyKey, requestId: requestId, generation: generation)
            noteFinished(method, path, status: response.status, started: started, requestId: requestId, error: nil)
            return response
        } catch {
            noteFinished(method, path, status: (error as? LKError)?.status ?? 0, started: started, requestId: requestId, error: error)
            throw error
        }
    }

    private func attempt(_ method: String, _ path: String, query: [String: String], body: Data?, contentType: String?, idempotencyKey: String?, requestId: String, generation: Int) async throws -> HTTPResponse {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        request.setValue(requestId, forHTTPHeaderField: "X-Request-Id")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        let sentToken = await tokens.currentToken()
        if let sentToken { request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body

        let attempts = RetryPolicy.attempts(method: method)
        var last: HTTPResponse?
        for attempt in 0..<attempts {
            // The session it was asked for ended while it waited (the launch hold, a retry's
            // backoff): it does not go out, with no token or with the next owner's.
            guard generation == sessionGeneration else { throw CancellationError() }
            let response: HTTPResponse
            do { response = try await send(request, forSession: sentToken != nil) }
            catch let error as LKError { throw error }
            catch {
                if RetryPolicy.retriesTransport(error) && attempt < attempts - 1 {
                    await sleep(RetryPolicy.delay(afterAttempt: attempt))
                    continue
                }
                let failure = Self.transportError(error)
                if !(failure is CancellationError) { await onReachability?(false) }
                throw failure
            }
            if (200..<300).contains(response.status) {
                await onReachability?(true)
                if method != "GET", let onWrite { await onWrite(path) }
                return response
            }
            let gateway = RetryPolicy.retriesStatus(response.status, fromApp: response.fromApp)
            if gateway && attempt < attempts - 1 {
                last = response
                await sleep(RetryPolicy.delay(afterAttempt: attempt))
                continue
            }
            // A refusal the app wrote still proves the server answered; a gateway's does not.
            await onReachability?(!gateway)
            // Only a request that carried the session that is still current
            // ends it: a wrong password (no token) or a stale request from a
            // previous sign-in must not sign the owner out.
            let failure = APIErrorDecoder.decode(status: response.status, data: response.body)
            if response.status >= 500 { noteUnexpected(method, path, response.status, decodeError: false) }
            if failure.endsSession, let sentToken {
                let current = await tokens.currentToken() == sentToken
                // Another request's 401 already ended this session: nothing more to sign out, and
                // nothing to show for a screen that is going away.
                guard generation == sessionGeneration else { throw CancellationError() }
                if current {
                    // The first 401 ends the session at once: the requests still out for it are
                    // cancelled before the sign-in screen shows, and are not waited for.
                    endSessionRequests()
                    if let handler = onUnauthorized { await handler(sentToken) }
                }
            }
            throw failure
        }
        throw APIErrorDecoder.decode(status: last?.status ?? 0, data: last?.body ?? Data())
    }

    /// A request with a session's token is kept until it is answered, so the end of that
    /// session can cancel it.
    private func send(_ request: URLRequest, forSession: Bool) async throws -> HTTPResponse {
        guard forSession else { return try await transport.send(request) }
        let transport = self.transport
        let id = UUID()
        let task = Task { try await transport.send(request) }
        sessionRequests[id] = task
        defer { sessionRequests[id] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}

/// What the launch's session check learned about the stored token.
public enum SessionCheck: Sendable, Equatable {
    /// The server accepted it; the answer's body.
    case accepted(Data)
    /// A 401 that ends the session (the client's handler has already been told).
    case refused
    /// No verdict: offline, a timeout, or a failure that is not the session's. The owner stays signed in.
    case unanswered

    /// How long the launch's other requests wait for the verdict before going out anyway.
    public static let hold: TimeInterval = 1.5
}

extension Result where Failure == Error {
    /// The outcome of an async call as a value, so two calls can run side by side (`async let`)
    /// and each failure still be handled on its own.
    public init(asyncCatching body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
