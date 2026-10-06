import Foundation

/// What `/api/observe` accepts from the app: a short, already-scrubbed line. The server
/// redacts again and rate-limits; nothing here carries amounts, names, tokens, bodies or URLs
/// with a query.
public struct ObservePayload: Codable, Equatable, Sendable {
    public let message: String
    public let source: String

    /// The server keeps 300 characters of the message.
    static let maxMessage = 300

    init(message: String) {
        self.message = String(message.prefix(Self.maxMessage))
        self.source = "native"
    }
}

public struct ObserveAppInfo: Equatable, Sendable {
    public let version: String
    public let build: String
    public let os: String
    public init(version: String, build: String, os: String) {
        self.version = version
        self.build = build
        self.os = os
    }
    var tag: String { "app=\(version)(\(build)) ios=\(os)" }
}

/// A request path reduced to its template: no host, no query, ids as `:id`.
public enum ObservePath {
    public static func template(_ raw: String) -> String {
        var path = raw
        if raw.contains("://"), let parsed = URLComponents(string: raw) { path = parsed.path }
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
        let segments = path.split(separator: "/", omittingEmptySubsequences: true).map { segment -> String in
            isIdentifier(String(segment)) ? ":id" : String(segment)
        }
        return "/" + segments.joined(separator: "/")
    }

    /// Numbers, UUIDs and long generated keys (cuid and the like). Route names never contain digits.
    static func isIdentifier(_ s: String) -> Bool {
        if s.allSatisfy(\.isNumber) { return true }
        if UUID(uuidString: s) != nil { return true }
        let idChars = s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        return idChars && s.count >= 12 && s.contains(where: \.isNumber)
    }
}

/// A MetricKit diagnostic reduced to what is safe and useful to send.
public struct NativeDiagnostic: Equatable, Sendable {
    public enum Kind: String, Sendable { case crash, hang, cpu, disk }
    public struct Frame: Equatable, Sendable {
        public let binary: String
        public let offset: Int
        public init(binary: String, offset: Int) { self.binary = binary; self.offset = offset }
    }

    public let kind: Kind
    public let exceptionType: Int?
    public let exceptionCode: Int?
    public let signal: Int?
    public let frames: [Frame]

    public init(kind: Kind, exceptionType: Int?, exceptionCode: Int?, signal: Int?, frames: [Frame]) {
        self.kind = kind
        self.exceptionType = exceptionType
        self.exceptionCode = exceptionCode
        self.signal = signal
        self.frames = frames
    }

    /// The innermost frames (binary name and offset only) of the thread MetricKit blames, from
    /// `MXCallStackTree.jsonRepresentation()`. Empty when the JSON is not that shape.
    public static func frames(fromCallStackTree json: Data, limit: Int) -> [Frame] {
        guard let root = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let stacks = root["callStacks"] as? [[String: Any]], !stacks.isEmpty else { return [] }
        let stack = stacks.first { ($0["threadAttributed"] as? Bool) == true } ?? stacks[0]
        var chain: [Frame] = []
        var level = stack["callStackRootFrames"] as? [[String: Any]]
        while let node = level?.first {
            if let name = node["binaryName"] as? String, let offset = node["offsetIntoBinaryTextSegment"] as? Int {
                chain.append(Frame(binary: name, offset: offset))
            }
            level = node["subFrames"] as? [[String: Any]]
        }
        return Array(chain.suffix(max(limit, 0)).reversed())
    }
}

extension ObservePayload {
    public static func apiFailure(method: String, path: String, status: Int, decodeError: Bool, app: ObserveAppInfo) -> ObservePayload {
        let kind = decodeError ? "api decode" : "api"
        return ObservePayload(message: "\(kind) \(status) \(method.uppercased()) \(ObservePath.template(path)) \(app.tag)")
    }

    public static func diagnostic(_ d: NativeDiagnostic, app: ObserveAppInfo) -> ObservePayload {
        var parts = [d.kind.rawValue]
        if let v = d.exceptionType { parts.append("type=\(v)") }
        if let v = d.exceptionCode { parts.append("code=\(v)") }
        if let v = d.signal { parts.append("signal=\(v)") }
        parts.append(app.tag)
        var message = parts.joined(separator: " ")
        var frames: [String] = []
        for frame in d.frames {
            let next = "\(frame.binary)+0x\(String(frame.offset, radix: 16))"
            let projected = message + " frames=" + (frames + [next]).joined(separator: ",")
            if projected.count > maxMessage { break }
            frames.append(next)
        }
        if !frames.isEmpty { message += " frames=" + frames.joined(separator: ",") }
        return ObservePayload(message: message)
    }
}

/// Reports unexpected failures once, quietly. Everything is best effort: a report that cannot
/// be sent is dropped, never queued and never shown.
public actor ObserveReporter {
    private let app: ObserveAppInfo
    private let isSignedIn: @Sendable () async -> Bool
    private let send: @Sendable (ObservePayload) async throws -> Void
    private let sleep: @Sendable (UInt64) async -> Void
    private var reported: Set<String> = []

    public init(app: ObserveAppInfo,
                isSignedIn: @escaping @Sendable () async -> Bool,
                send: @escaping @Sendable (ObservePayload) async throws -> Void,
                sleep: @escaping @Sendable (UInt64) async -> Void = { try? await Task.sleep(nanoseconds: $0) }) {
        self.app = app
        self.isSignedIn = isSignedIn
        self.send = send
        self.sleep = sleep
    }

    /// A 5xx or an answer the app could not read; once per (path template, status) per session.
    public func reportAPIFailure(method: String, path: String, status: Int, decodeError: Bool) async {
        let template = ObservePath.template(path)
        guard template != "/api/observe", decodeError || status >= 500 else { return }
        let key = "\(template)|\(status)"
        guard !reported.contains(key), await isSignedIn() else { return }
        reported.insert(key)
        await deliver(.apiFailure(method: method, path: template, status: status, decodeError: decodeError, app: app))
    }

    /// `diagnosed` is the build the diagnostic came from when MetricKit says it was an earlier one.
    public func reportDiagnostic(_ diagnostic: NativeDiagnostic, app diagnosed: ObserveAppInfo? = nil) async {
        guard await isSignedIn() else { return }
        await deliver(.diagnostic(diagnostic, app: diagnosed ?? app))
    }

    /// One retry after a short wait, then give up.
    private func deliver(_ payload: ObservePayload) async {
        for attempt in 0..<2 {
            do { try await send(payload); return }
            catch is CancellationError { return }
            catch { if attempt == 0 { await sleep(2_000_000_000) } }
        }
    }
}
