import Foundation

public struct ChatSource: Codable, Sendable, Hashable {
    public let label: String
    public let href: String
    public let kind: String?
}

public struct ChatMessage: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let role: String
    public var content: String
    public let status: String?
    public let limited: Bool?
    public let sources: [ChatSource]
    public let createdAt: String?

    public init(id: String, role: String, content: String, status: String? = nil, limited: Bool? = nil, sources: [ChatSource] = [], createdAt: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.status = status
        self.limited = limited
        self.sources = sources
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey { case id, role, content, status, limited, sources, createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status)
        limited = try c.decodeIfPresent(Bool.self, forKey: .limited)
        sources = try c.decodeIfPresent([ChatSource].self, forKey: .sources) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

public struct ChatHistory: Decodable, Sendable {
    public struct Conversation: Decodable, Sendable { public let id: String; public let title: String; public let archivedAt: String? }
    public let messages: [ChatMessage]
    public let hasMore: Bool
    public let conversation: Conversation?
}

public struct Conversation: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let archivedAt: String?
    public let updatedAt: String?
    public let createdAt: String?
}

public struct ConversationList: Decodable, Sendable {
    public let conversations: [Conversation]
    public let hasMore: Bool
}

/// One `data:` event of the streamed `POST /api/ai/chat`.
public enum ChatEvent: Equatable, Sendable {
    case started(conversationId: String)
    case delta(String)
    case finished(ChatMessage)
    case failed(String)

    private struct Raw: Decodable {
        let conversationId: String?
        let userMessageId: String?
        let delta: String?
        let done: Bool?
        let incomplete: Bool?
        let status: String?
        let error: String?
        let id: String?
    }

    /// One decoder for every event of every stream (decoding is thread-safe; building one is not free).
    nonisolated(unsafe) private static let decoder = JSONDecoder()

    public static func parse(_ json: String) throws -> ChatEvent? {
        let data = Data(json.utf8)
        let raw = try decoder.decode(Raw.self, from: data)
        if let delta = raw.delta { return .delta(delta) }
        if raw.done != nil || raw.incomplete != nil {
            if raw.id == nil || (raw.incomplete == true && raw.error != nil && raw.status != "incomplete") {
                return .failed(raw.error ?? "Vastaus jäi kesken.")
            }
            var message = try decoder.decode(ChatMessage.self, from: data)
            if message.content.isEmpty, let error = raw.error { message.content = error }
            return .finished(message)
        }
        if let id = raw.conversationId, raw.userMessageId != nil { return .started(conversationId: id) }
        return nil
    }
}
