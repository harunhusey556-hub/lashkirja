import Foundation

public struct ChatSource: Codable, Sendable, Hashable {
    public let label: String
    public let href: String
    public let kind: String?
}

/// Which confirmation a reply carries (`proposal.type`).
public enum ChatProposalKind: String, Sendable, Hashable {
    /// A receipt and a bank row to link.
    case match = "match_proposal"
    /// A draft sales invoice the assistant would create.
    case invoiceDraft = "invoice_draft"
    /// A correction to one receipt's fields.
    case receiptUpdate = "receipt_update"
}

/// `invoice_draft`: what Hyväksy creates as a DRAFT invoice. Amounts are exact euros from the server.
public struct ChatInvoiceDraft: Sendable, Hashable {
    public struct Line: Sendable, Hashable {
        public let description: String
        public let quantity: Decimal
        public let unitPrice: Decimal?
        public let vatRate: Decimal?
        public let net: Decimal?

        public init(description: String, quantity: Decimal, unitPrice: Decimal? = nil, vatRate: Decimal? = nil, net: Decimal? = nil) {
            self.description = description
            self.quantity = quantity
            self.unitPrice = unitPrice
            self.vatRate = vatRate
            self.net = net
        }
    }

    public let customerName: String
    public let issueDate: String?
    public let dueDate: String?
    public let lines: [Line]
    public let net: Decimal?
    public let vat: Decimal?
    public let gross: Decimal?
    /// Set once accepted: the number of the draft that was created.
    public let invoiceNumber: Int?

    public init(customerName: String, issueDate: String? = nil, dueDate: String? = nil, lines: [Line], net: Decimal? = nil, vat: Decimal? = nil, gross: Decimal? = nil, invoiceNumber: Int? = nil) {
        self.customerName = customerName
        self.issueDate = issueDate
        self.dueDate = dueDate
        self.lines = lines
        self.net = net
        self.vat = vat
        self.gross = gross
        self.invoiceNumber = invoiceNumber
    }
}

/// `receipt_update`: each field Hyväksy changes, old and new as the server wrote them for people.
public struct ChatReceiptUpdate: Sendable, Hashable {
    public struct Change: Sendable, Hashable {
        public let field: String
        public let label: String
        public let from: String
        public let to: String

        public init(field: String, label: String, from: String, to: String) {
            self.field = field
            self.label = label
            self.from = from
            self.to = to
        }
    }

    public let receiptSummary: String
    public let changes: [Change]

    public init(receiptSummary: String, changes: [Change]) {
        self.receiptSummary = receiptSummary
        self.changes = changes
    }
}

/// What a reply asks the owner to confirm (`proposal` on an assistant message): a receipt-to-bank-row
/// match, a draft invoice or a receipt fix. Accepted or rejected with `PATCH /api/ai/chat`. A type the
/// app does not know fails to decode, so the message shows without a card.
public struct ChatProposal: Decodable, Sendable, Hashable {
    public let kind: ChatProposalKind
    public let transactionId: String
    public let receiptId: String
    public let txSummary: String
    public let receiptSummary: String
    public let confidenceScore: Double?
    public let reasons: [String]
    public let invoiceDraft: ChatInvoiceDraft?
    public let receiptUpdate: ChatReceiptUpdate?
    /// Once accepted: the record that was created or changed ("/laskut/lasku?id=…", "/kuitit/kuitti?id=…").
    public let href: String?
    /// "accepted" or "rejected" once decided; nil while open.
    public var status: String?

    /// A match proposal (the original kind).
    public init(transactionId: String, receiptId: String, txSummary: String, receiptSummary: String, confidenceScore: Double? = nil, reasons: [String] = [], status: String? = nil) {
        self.kind = .match
        self.transactionId = transactionId
        self.receiptId = receiptId
        self.txSummary = txSummary
        self.receiptSummary = receiptSummary
        self.confidenceScore = confidenceScore
        self.reasons = reasons
        self.invoiceDraft = nil
        self.receiptUpdate = nil
        self.href = nil
        self.status = status
    }

    public init(invoiceDraft: ChatInvoiceDraft, href: String? = nil, status: String? = nil) {
        self.kind = .invoiceDraft
        self.transactionId = ""
        self.receiptId = ""
        self.txSummary = ""
        self.receiptSummary = ""
        self.confidenceScore = nil
        self.reasons = []
        self.invoiceDraft = invoiceDraft
        self.receiptUpdate = nil
        self.href = href
        self.status = status
    }

    public init(receiptId: String, receiptUpdate: ChatReceiptUpdate, href: String? = nil, status: String? = nil) {
        self.kind = .receiptUpdate
        self.transactionId = ""
        self.receiptId = receiptId
        self.txSummary = ""
        self.receiptSummary = receiptUpdate.receiptSummary
        self.confidenceScore = nil
        self.reasons = []
        self.invoiceDraft = nil
        self.receiptUpdate = receiptUpdate
        self.href = href
        self.status = status
    }

    enum CodingKeys: String, CodingKey {
        case type, transactionId, receiptId, txSummary, receiptSummary, confidenceScore, reasons, status
        case customerName, issueDate, dueDate, lines, totals, invoiceNumber, href, changes
    }

    private enum LineKeys: String, CodingKey { case description, quantity, unitPrice, vatRate, net }
    private enum TotalKeys: String, CodingKey { case net, vat, gross }
    private enum ChangeKeys: String, CodingKey { case field, label, from, to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decodeIfPresent(String.self, forKey: .type)
        guard let kind = type.map(ChatProposalKind.init(rawValue:)) ?? .match else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown proposal type")
        }
        self.kind = kind
        transactionId = (try? c.decodeIfPresent(String.self, forKey: .transactionId)) ?? ""
        receiptId = (try? c.decodeIfPresent(String.self, forKey: .receiptId)) ?? ""
        txSummary = (try? c.decodeIfPresent(String.self, forKey: .txSummary)) ?? ""
        receiptSummary = (try? c.decodeIfPresent(String.self, forKey: .receiptSummary)) ?? ""
        confidenceScore = try? c.decodeIfPresent(Double.self, forKey: .confidenceScore)
        reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        href = try? c.decodeIfPresent(String.self, forKey: .href)

        if kind == .invoiceDraft {
            let lines = ((try? c.decodeIfPresent([Lossy<LineKeys>].self, forKey: .lines)) ?? []).compactMap { $0.keyed }.map { line in
                ChatInvoiceDraft.Line(
                    description: (try? line.decodeIfPresent(String.self, forKey: .description)) ?? "",
                    quantity: Self.decimal(line, .quantity) ?? 1,
                    unitPrice: Self.decimal(line, .unitPrice),
                    vatRate: Self.decimal(line, .vatRate),
                    net: Self.decimal(line, .net)
                )
            }
            let totals = try? c.nestedContainer(keyedBy: TotalKeys.self, forKey: .totals)
            invoiceDraft = ChatInvoiceDraft(
                customerName: (try? c.decodeIfPresent(String.self, forKey: .customerName)) ?? "",
                issueDate: try? c.decodeIfPresent(String.self, forKey: .issueDate),
                dueDate: try? c.decodeIfPresent(String.self, forKey: .dueDate),
                lines: lines,
                net: totals.flatMap { Self.decimal($0, .net) },
                vat: totals.flatMap { Self.decimal($0, .vat) },
                gross: totals.flatMap { Self.decimal($0, .gross) },
                invoiceNumber: try? c.decodeIfPresent(Int.self, forKey: .invoiceNumber)
            )
        } else {
            invoiceDraft = nil
        }

        if kind == .receiptUpdate {
            let changes = ((try? c.decodeIfPresent([Lossy<ChangeKeys>].self, forKey: .changes)) ?? []).compactMap { $0.keyed }.map { change in
                ChatReceiptUpdate.Change(
                    field: (try? change.decodeIfPresent(String.self, forKey: .field)) ?? "",
                    label: (try? change.decodeIfPresent(String.self, forKey: .label)) ?? "",
                    from: (try? change.decodeIfPresent(String.self, forKey: .from)) ?? "",
                    to: (try? change.decodeIfPresent(String.self, forKey: .to)) ?? ""
                )
            }
            receiptUpdate = ChatReceiptUpdate(receiptSummary: receiptSummary, changes: changes)
        } else {
            receiptUpdate = nil
        }
    }

    /// Exact euros arrive as text ("164.41"); a plain number is read too.
    private static func decimal<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Decimal? {
        if let text = try? c.decodeIfPresent(String.self, forKey: key) {
            return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
        }
        if let number = try? c.decodeIfPresent(Double.self, forKey: key) {
            return Decimal(string: String(number), locale: Locale(identifier: "en_US_POSIX"))
        }
        return nil
    }

    /// One list element as a keyed container, or nil when it is not an object (it is skipped, not fatal).
    private struct Lossy<K: CodingKey>: Decodable {
        let keyed: KeyedDecodingContainer<K>?
        init(from decoder: Decoder) {
            keyed = try? decoder.container(keyedBy: K.self)
        }
    }
}

/// The earlier name, kept for the match card and its tests.
public typealias ChatMatchProposal = ChatProposal

public struct ChatMessage: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let role: String
    public var content: String
    public let status: String?
    public let limited: Bool?
    public let sources: [ChatSource]
    public let createdAt: String?
    /// Var: deciding sets its status at once, before the server answers.
    public var proposal: ChatProposal?

    public init(id: String, role: String, content: String, status: String? = nil, limited: Bool? = nil, sources: [ChatSource] = [], createdAt: String? = nil, proposal: ChatProposal? = nil) {
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
        proposal = (try? c.decodeIfPresent(ChatProposal.self, forKey: .proposal)) ?? nil
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
