import SwiftUI
import Observation
import LashKirjaCore

@MainActor
@Observable
final class ChatModel {
    private let app: AppModel
    var conversationId: String?
    var title = "Avustaja"
    private(set) var messages: [ChatMessage] = []
    private(set) var streaming = false
    var failure: String?
    private var task: Task<Void, Never>?
    /// The reply the live stream writes into; a stopped or superseded stream no longer matches.
    private var liveReplyId: String?
    /// `GET /api/ai/status`: nil until known (behave as available, as the web drawer does).
    private(set) var aiAvailable: Bool?
    /// After a 429 ("Liian monta viestiä"), sending stays off until this moment.
    private(set) var cooldownUntil: Date?
    private var cooldownTask: Task<Void, Never>?

    /// One cookie-less session for every streamed reply: a new session per message
    /// leaked the session and paid a TLS handshake each time.
    private static let streamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }()

    init(app: AppModel) { self.app = app }

    /// As in the web drawer, typing stays on when the AI is unavailable (the server still answers
    /// what it can without it); only a rate-limit cooldown turns it off.
    var canType: Bool { cooldownUntil == nil }
    var canSendShortcut: Bool { cooldownUntil == nil }

    func loadStatus() async {
        do {
            let status: AssistantStatus = try await app.api.get("/api/ai/status")
            aiAvailable = status.available
        } catch {
            // Unknown: behave as available; a failed question still explains itself.
        }
    }

    private func startCooldown(retryAfter: String?) {
        let until = AssistantCooldown.until(retryAfter: retryAfter)
        cooldownUntil = until
        cooldownTask?.cancel()
        cooldownTask = Task { [weak self] in
            let wait = max(0, until.timeIntervalSinceNow)
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            if let current = self.cooldownUntil, current <= Date() {
                self.cooldownUntil = nil
                if self.failure == AssistantCooldown.rateLimitedMessage { self.failure = nil }
            }
        }
    }

    func loadLatest() async {
        do {
            var query: [String: String] = [:]
            if let conversationId { query["conversationId"] = conversationId }
            let history: ChatHistory = try await app.api.get("/api/ai/chat", query: query)
            messages = history.messages
            conversationId = history.conversation?.id
            title = history.conversation?.title ?? "Avustaja"
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }

    func open(_ conversation: Conversation) async {
        stop()
        conversationId = conversation.id
        title = conversation.title
        messages = []
        await loadLatest()
    }

    func startNew() {
        stop()
        conversationId = nil
        title = "Uusi keskustelu"
        messages = []
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !streaming, cooldownUntil == nil else { return }
        failure = nil
        messages.append(ChatMessage(id: UUID().uuidString, role: "user", content: trimmed))
        let replyId = UUID().uuidString
        messages.append(ChatMessage(id: replyId, role: "assistant", content: ""))
        streaming = true
        liveReplyId = replyId
        task = Task { await stream(trimmed, replyId: replyId) }
    }

    func stop() {
        task?.cancel()
        task = nil
        // Stopped before the first word: no empty bubble is left behind.
        if let id = liveReplyId { messages.removeAll { $0.id == id && $0.content.isEmpty } }
        liveReplyId = nil
        streaming = false
    }

    private func stream(_ text: String, replyId: String) async {
        defer {
            if liveReplyId == replyId {
                liveReplyId = nil
                streaming = false
            }
        }
        struct Body: Encodable { let message: String; let stream = true; let clientId: String; let conversationId: String? }
        do {
            var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("/api/ai/chat"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            if let token = await app.auth.currentToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            request.httpBody = try JSONEncoder().encode(Body(message: text, clientId: UUID().uuidString, conversationId: conversationId))
            request.timeoutInterval = 120
            let (bytes, response) = try await Self.streamSession.bytes(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                var data = Data()
                for try await byte in bytes { data.append(byte) }
                if http.statusCode == 429, liveReplyId == replyId {
                    startCooldown(retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
                }
                throw APIErrorDecoder.decode(status: http.statusCode, data: data)
            }
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let event = try? ChatEvent.parse(payload) else { continue }
                guard liveReplyId == replyId else { return }
                switch event {
                case .started(let id):
                    conversationId = id
                case .delta(let piece):
                    update(replyId) { $0.content += piece }
                case .finished(let message):
                    update(replyId) { $0 = message }
                case .failed(let message):
                    failure = message
                    update(replyId) { if $0.content.isEmpty { $0.content = message } }
                }
            }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            guard liveReplyId == replyId else { return }
            failure = error.userMessage
            messages.removeAll { $0.id == replyId && $0.content.isEmpty }
        }
    }

    private func update(_ id: String, _ change: (inout ChatMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }
}
