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

    public init(baseURL: URL, transport: HTTPTransport, tokens: TokenProvider,
                sleep: @escaping @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokens = tokens
        self.sleep = sleep
    }

    public func setOnUnauthorized(_ handler: (@Sendable () async -> Void)?) { onUnauthorized = handler }

    public func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let response = try await perform("GET", path, query: query, body: nil, contentType: nil, idempotencyKey: nil)
        return try decode(response)
    }

    public func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, idempotencyKey: String? = nil) async throws -> T {
        let data = try body.map { try JSONEncoder().encode($0) }
        let response = try await perform(method, path, query: [:], body: data, contentType: data == nil ? nil : "application/json", idempotencyKey: idempotencyKey)
        return try decode(response)
    }

    public func raw(_ method: String, _ path: String, body: Data?, contentType: String?, idempotencyKey: String? = nil) async throws -> HTTPResponse {
        try await perform(method, path, query: [:], body: body, contentType: contentType, idempotencyKey: idempotencyKey)
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
        if let url = error as? URLError, url.code == .cancelled { return CancellationError() }
        return LKError(status: 0, code: "NETWORK", message: LKError.unreachable)
    }

    private func decode<T: Decodable>(_ response: HTTPResponse) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: response.body) }
        catch { throw LKError(status: response.status, code: "DECODE", message: "Palvelimen vastausta ei voitu lukea.") }
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

        let attempts = method == "GET" ? 3 : 1
        var last: HTTPResponse?
        for attempt in 0..<attempts {
            let response: HTTPResponse
            do { response = try await transport.send(request) }
            catch let error as LKError { throw error }
            catch { throw Self.transportError(error) }
            if (200..<300).contains(response.status) { return response }
            let gateway = [502, 503, 504].contains(response.status) && !response.fromApp
            if gateway && attempt < attempts - 1 {
                last = response
                await sleep(UInt64(500_000_000) << UInt64(attempt))
                continue
            }
            // Only a request that carried the session that is still current
            // ends it: a wrong password (no token) or a stale request from a
            // previous sign-in must not sign the owner out.
            if response.status == 401, let sentToken, let handler = onUnauthorized,
               await tokens.currentToken() == sentToken {
                await handler()
            }
            throw APIErrorDecoder.decode(status: response.status, data: response.body)
        }
        throw APIErrorDecoder.decode(status: last?.status ?? 0, data: last?.body ?? Data())
    }
}
