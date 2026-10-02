import Foundation

public struct ChatSource: Codable, Sendable, Hashable {
    public let label: String
    public let href: String
    public let kind: String?
}

/// A receipt-to-bank-row match the assistant offers (`proposal` on an assistant message);
/// the owner accepts or rejects it with `PATCH /api/ai/chat`.
public struct ChatMatchProposal: Decodable, Sendable, Hashable {
    public let transactionId: String
    public let receiptId: String
    public let txSummary: String
    public let receiptSummary: String
    public let confidenceScore: Double?
    public let reasons: [String]
    /// "accepted" or "rejected" once decided; nil while open.
    public var status: String?

    public init(transactionId: String, receiptId: String, txSummary: String, receiptSummary: String, confidenceScore: Double? = nil, reasons: [String] = [], status: String? = nil) {
        self.transactionId = transactionId
        self.receiptId = receiptId
        self.txSummary = txSummary
        self.receiptSummary = receiptSummary
        self.confidenceScore = confidenceScore
        self.reasons = reasons
        self.status = status
    }

    enum CodingKeys: String, CodingKey { case type, transactionId, receiptId, txSummary, receiptSummary, confidenceScore, reasons, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decodeIfPresent(String.self, forKey: .type)
        guard type == nil || type == "match_proposal" else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "not a match proposal")
        }
        transactionId = try c.decodeIfPresent(String.self, forKey: .transactionId) ?? ""
        receiptId = try c.decodeIfPresent(String.self, forKey: .receiptId) ?? ""
        txSummary = try c.decodeIfPresent(String.self, forKey: .txSummary) ?? ""
        receiptSummary = try c.decodeIfPresent(String.self, forKey: .receiptSummary) ?? ""
        confidenceScore = try? c.decodeIfPresent(Double.self, forKey: .confidenceScore)
        reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
        status = try? c.decodeIfPresent(String.self, forKey: .status)
    }
}

public struct ChatMessage: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let role: String
    public var content: String
    public let status: String?
    public let limited: Bool?
    public let sources: [ChatSource]
    public let createdAt: String?
    /// Var: deciding sets its status at once, before the server answers.
    public var proposal: ChatMatchProposal?

    public init(id: String, role: String, content: String, status: String? = nil, limited: Bool? = nil, sources: [ChatSource] = [], createdAt: String? = nil, proposal: ChatMatchProposal? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.status = status
        self.limited = limited
        self.sources = sources
        self.createdAt = createdAt
        self.proposal = proposal
    }

    enum CodingKeys: String, CodingKey { case id, role, content, status, limited, sources, createdAt, proposal }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status)
        limited = try c.decodeIfPresent(Bool.self, forKey: .limited)
        sources = try c.decodeIfPresent([ChatSource].self, forKey: .sources) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        // A proposal the app cannot read is left out rather than losing the whole message.
        proposal = (try? c.decodeIfPresent(ChatMatchProposal.self, forKey: .proposal)) ?? nil
    }
}

/// `POST /api/ai/chat/receipt`: the stored "Kuitti: …" message and the assistant's answer to it.
public struct ChatReceiptResponse: Decodable, Sendable {
    public let conversationId: String
    public let receiptId: String?
    public let userMessage: ChatMessage
    public let assistantMessage: ChatMessage
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
