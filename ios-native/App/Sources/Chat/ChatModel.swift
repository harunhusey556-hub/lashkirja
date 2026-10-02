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

    init(app: AppModel) { self.app = app }

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
        guard !trimmed.isEmpty, !streaming else { return }
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
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false
            let (bytes, response) = try await URLSession(configuration: config).bytes(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                var data = Data()
                for try await byte in bytes { data.append(byte) }
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
