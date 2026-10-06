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
    public private(set) var onUnauthorized: (@Sendable () async -> Void)?
    /// Told the path of every write the server accepted, so the app can mark what it shows as
    /// out of date without each screen remembering to.
    public private(set) var onWrite: (@Sendable (String) async -> Void)?
    /// Told after each request whether the server answered (true) or the request never got an
    /// answer (false), for the offline indicator. A cancelled request says nothing.
    public private(set) var onReachability: (@Sendable (Bool) async -> Void)?
    /// Told (method, path, status, decodeError) of a 5xx the server answered or an answer that
    /// would not decode, never of offline, timeouts or 4xx. Runs detached: it cannot slow a request.
    public private(set) var onUnexpectedFailure: (@Sendable (String, String, Int, Bool) async -> Void)?

    public init(baseURL: URL, transport: HTTPTransport, tokens: TokenProvider,
                sleep: @escaping @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
        self.sleep = sleep
    }

    public func setOnUnauthorized(_ handler: (@Sendable () async -> Void)?) { onUnauthorized = handler }
    public func setOnWrite(_ handler: (@Sendable (String) async -> Void)?) { onWrite = handler }
    public func setOnReachability(_ handler: (@Sendable (Bool) async -> Void)?) { onReachability = handler }

    public func setOnUnexpectedFailure(_ handler: (@Sendable (String, String, Int, Bool) async -> Void)?) { onUnexpectedFailure = handler }

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

    private func perform(_ method: String, _ path: String, query: [String: String], body: Data?, contentType: String?, idempotencyKey: String?) async throws -> HTTPResponse {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        let sentToken = await tokens.currentToken()
        if let sentToken { request.setValue("Bearer \(sentToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body

        let attempts = RetryPolicy.attempts(method: method)
        var last: HTTPResponse?
        for attempt in 0..<attempts {
            let response: HTTPResponse
            do { response = try await transport.send(request) }
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
            if failure.endsSession, let sentToken, let handler = onUnauthorized,
               await tokens.currentToken() == sentToken {
                await handler()
            }
            throw failure
        }
        throw APIErrorDecoder.decode(status: last?.status ?? 0, data: last?.body ?? Data())
    }
}

extension Result where Failure == Error {
    /// The outcome of an async call as a value, so two calls can run side by side (`async let`)
    /// and each failure still be handled on its own.
    public init(asyncCatching body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
