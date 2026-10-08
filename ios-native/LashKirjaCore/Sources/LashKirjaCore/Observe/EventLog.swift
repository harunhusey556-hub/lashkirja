import Foundation

/// One line of the app's debugging trail: a screen, a request or a problem report.
/// Ids and actions only — never amounts, names, bodies or tokens (server `lib/event-log.ts`).
public struct AppEvent: Codable, Equatable, Sendable {
    /// Unique per event: a batch sent again after a crash is told apart from new events.
    public let id: String
    public let ts: String
    public let kind: String
    public var name: String?
    public var screen: String?
    public var method: String?
    public var path: String?
    public var status: Int?
    public var durationMs: Int?
    public var requestId: String?
    public var message: String?

    public init(kind: String, at date: Date = Date(), name: String? = nil, screen: String? = nil,
                method: String? = nil, path: String? = nil, status: Int? = nil, durationMs: Int? = nil,
                requestId: String? = nil, message: String? = nil) {
        self.id = String(UUID().uuidString.prefix(12)).lowercased()
        self.ts = date.formatted(.iso8601)
        self.kind = kind
        self.name = name
        self.screen = screen
        self.method = method
        self.path = path
        self.status = status
        self.durationMs = durationMs
        self.requestId = requestId
        self.message = message.map { String($0.prefix(1000)) }
    }

    private enum CodingKeys: String, CodingKey {
        case id, ts, kind, name, screen, method, path, status, durationMs, requestId, message
    }

    /// Events saved by an earlier build have no id: they get one, so the saved trail still loads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? String(UUID().uuidString.prefix(12)).lowercased()
        ts = try c.decode(String.self, forKey: .ts)
        kind = try c.decode(String.self, forKey: .kind)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        screen = try c.decodeIfPresent(String.self, forKey: .screen)
        method = try c.decodeIfPresent(String.self, forKey: .method)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        status = try c.decodeIfPresent(Int.self, forKey: .status)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        requestId = try c.decodeIfPresent(String.self, forKey: .requestId)
        message = try c.decodeIfPresent(String.self, forKey: .message)
    }

    public static func screen(_ name: String) -> AppEvent { AppEvent(kind: "screen", screen: name) }
    public static func lifecycle(_ name: String) -> AppEvent { AppEvent(kind: "app", name: name) }
    /// A tap that changes something ("clear-sent"), with the screen it was on.
    public static func action(_ name: String, screen: String? = nil) -> AppEvent { AppEvent(kind: "action", name: name, screen: screen) }

    /// Kinds written to the phone at once: a freeze right after them must not lose them.
    static let durableKinds: Set<String> = ["action", "hang", "report"]

    /// Written at once as well: a request that got no answer or a server error (not a
    /// cancellation), the events a debugging session needs most.
    var isDurable: Bool {
        if Self.durableKinds.contains(kind) { return true }
        guard kind == "request", let status else { return false }
        return status >= 500 || (status == 0 && message != "cancelled")
    }

    /// A request as APIClient saw it; status 0 means no answer arrived.
    public static func request(_ trace: RequestTrace) -> AppEvent {
        AppEvent(kind: "request", method: trace.method, path: trace.path, status: trace.status,
                 durationMs: trace.durationMs, requestId: trace.requestId, message: trace.error)
    }
}

/// What APIClient reports about each request it made.
public struct RequestTrace: Equatable, Sendable {
    public let method: String
    /// Without the query: ids in the path stay, so a record can be looked up.
    public let path: String
    public let status: Int
    public let durationMs: Int
    public let requestId: String
    public let error: String?

    public init(method: String, path: String, status: Int, durationMs: Int, requestId: String, error: String?) {
        self.method = method
        self.path = path
        self.status = status
        self.durationMs = durationMs
        self.requestId = requestId
        self.error = error
    }
}

/// The trail kept on the phone until the server has it: problems that happen offline are
/// still there when the connection returns. Oldest events go first past `capacity`.
public actor EventLog {
    public static let shared = EventLog(fileURL: EventLog.defaultFileURL)

    /// Ties one launch's events together on the server.
    public static let sessionId = String(UUID().uuidString.prefix(8)).lowercased()

    private let fileURL: URL?
    private let capacity: Int
    private var events: [AppEvent] = []
    private var unsaved = 0
    /// The latest screen recorded, for a hang report.
    public private(set) var lastScreen: String?

    public init(fileURL: URL?, capacity: Int = 2000) {
        self.fileURL = fileURL
        self.capacity = capacity
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([AppEvent].self, from: data) {
            events = Array(saved.suffix(capacity))
        }
    }

    static var defaultFileURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("event-log.json")
    }

    public func record(_ event: AppEvent) {
        if event.kind == "screen" { lastScreen = event.screen }
        events.append(event)
        if events.count > capacity { events.removeFirst(events.count - capacity) }
        unsaved += 1
        // Written now and then, on every flush or trip to the background, and at once for the
        // events a freeze would otherwise take with it (the app is killed before the next save).
        if unsaved >= 25 || event.isDurable { save() }
    }

    /// For SwiftUI and other synchronous callers.
    public nonisolated func log(_ event: AppEvent) {
        Task { await record(event) }
    }

    public var count: Int { events.count }

    /// The oldest `max` events, to send.
    public func pending(max: Int) -> [AppEvent] { Array(events.prefix(max)) }

    /// After the server confirmed the first `n`.
    public func removeSent(_ n: Int) {
        events.removeFirst(min(n, events.count))
        save()
    }

    public func save() {
        unsaved = 0
        guard let fileURL else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(events) { try? data.write(to: fileURL, options: .atomic) }
    }
}

/// What POST /api/observe/events takes.
public struct EventBatch: Encodable, Sendable {
    public struct App: Encodable, Sendable { public let version: String; public let build: String; public let os: String }
    public let sessionId: String
    public let app: App
    public let events: [AppEvent]
}

/// Sends the trail in batches of up to 200. Events leave the phone only once the server
/// confirmed them; a failed send keeps them for the next try.
public actor EventLogUploader {
    private let log: EventLog
    private let app: ObserveAppInfo
    private let isSignedIn: @Sendable () async -> Bool
    private let send: @Sendable (EventBatch) async throws -> Void
    private var sending = false

    public init(log: EventLog, app: ObserveAppInfo,
                isSignedIn: @escaping @Sendable () async -> Bool,
                send: @escaping @Sendable (EventBatch) async throws -> Void) {
        self.log = log
        self.app = app
        self.isSignedIn = isSignedIn
        self.send = send
    }

    /// True when everything was sent (or nothing waited).
    @discardableResult
    public func flush() async -> Bool {
        guard !sending else { return false }
        sending = true
        defer { sending = false }
        guard await isSignedIn() else { await log.save(); return false }
        // What waited when the flush began, and no more: events logged while it sends (its own
        // requests' side effects) wait for the next flush instead of keeping this one going.
        var left = await log.count
        while left > 0 {
            let batch = await log.pending(max: min(200, left))
            if batch.isEmpty { return true }
            do {
                try await send(EventBatch(sessionId: EventLog.sessionId,
                                          app: .init(version: app.version, build: app.build, os: app.os),
                                          events: batch))
                await log.removeSent(batch.count)
                left -= batch.count
            } catch {
                await log.save()
                return false
            }
        }
        return true
    }
}

/// "Ilmoita ongelmasta": a short code the owner can pass on, found with `npm run debug-log -- --report CODE`.
public enum ProblemReport {
    public static func newCode() -> String {
        let letters = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<6).map { _ in letters.randomElement()! })
    }

    public static func event(code: String, note: String, screen: String?) -> AppEvent {
        AppEvent(kind: "report", name: code, screen: screen, message: note.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
