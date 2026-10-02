import Foundation

public struct Receipt: Decodable, Sendable, Identifiable, Hashable {
    /// A bank row as the receipt routes show it: the link, the suggestion or a candidate.
    public struct LinkedTransaction: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let date: String?
        public let counterparty: String?
        public let amount: Decimal
        public let matchScore: Double?
        public let matchReasons: [String]?
        /// Only on a suggestion or a candidate.
        public let score: Double?
        public let reasons: [String]?

        public var bestScore: Double? { score ?? matchScore }
        public var bestReasons: [String]? { reasons ?? matchReasons }
    }
    public struct Match: Decodable, Sendable, Hashable {
        public let status: String?
        public let suggestedTransaction: LinkedTransaction?
        /// Scored on the detail GET only; the list sends an empty list.
        public let matchCandidates: [LinkedTransaction]?
    }

    public let id: String
    public let vendor: String?
    public let date: String?
    public let category: String?
    public let type: String
    public let reference: String?
    public let invoiceNumber: String?
    public let fileName: String?
    public let source: String?
    public let confidence: Double?
    public let createdAt: String
    public let updatedAt: String
    public let totalAmount: Decimal?
    public let reviewStatus: String?
    public let notes: String?
    public let vatDetails: [VatDetail]?
    public let linkedTransaction: LinkedTransaction?
    public let match: Match?

    enum CodingKeys: String, CodingKey {
        case id, vendor, date, category, type, reference, invoiceNumber, fileName, source, confidence
        case createdAt, updatedAt, totalAmount, reviewStatus, notes, vatDetails, linkedTransaction, match
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "meno"
        reference = try c.decodeIfPresent(String.self, forKey: .reference)
        invoiceNumber = try c.decodeIfPresent(String.self, forKey: .invoiceNumber)
        fileName = try c.decodeIfPresent(String.self, forKey: .fileName)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        totalAmount = try c.decodeIfPresent(Decimal.self, forKey: .totalAmount)
        reviewStatus = try c.decodeIfPresent(String.self, forKey: .reviewStatus)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        // The server stores VAT rows as a JSON string; older/other routes send an array.
        if let rows = try? c.decodeIfPresent([VatDetail].self, forKey: .vatDetails) {
            vatDetails = rows
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .vatDetails) {
            vatDetails = try? JSONDecoder().decode([VatDetail].self, from: Data(text.utf8))
        } else {
            vatDetails = nil
        }
        linkedTransaction = try c.decodeIfPresent(LinkedTransaction.self, forKey: .linkedTransaction)
        match = try c.decodeIfPresent(Match.self, forKey: .match)
    }

    public var isIncome: Bool { type == "tulo" }
    public var title: String { vendor?.isEmpty == false ? vendor! : "Tuntematon myyjä" }
}

public struct VatDetail: Codable, Sendable, Hashable {
    public var rate: Decimal
    public var amount: Decimal
    public init(rate: Decimal, amount: Decimal) { self.rate = rate; self.amount = amount }
}

public struct ReceiptList: Decodable, Sendable {
    public let receipts: [Receipt]
    public let count: Int?
    public let truncated: Bool?
}

public struct ReceiptResponse: Decodable, Sendable { public let receipt: Receipt }

/// `POST /api/receipts/batch-delete`: answers 200 with the ids that went and the ones refused.
public struct BatchDeleteResult: Decodable, Sendable {
    public struct Failure: Decodable, Sendable { public let id: String; public let error: String? }
    public let succeeded: [String]?
    public let failed: [Failure]?

    public var failedIds: [String] { (failed ?? []).map(\.id) }

    /// "Poistettiin 2 kuittia." / "Poistettiin 1 kuitti. 1 epäonnistui: …"
    public var message: String {
        let done = succeeded?.count ?? 0
        var text = "Poistettiin \(done) \(done == 1 ? "kuitti" : "kuittia")."
        let refused = failed ?? []
        if !refused.isEmpty {
            text += " \(refused.count) epäonnistui"
            if let reason = refused.first?.error, !reason.isEmpty { text += ": \(reason)" }
        }
        return text
    }
}

/// `GET /api/vendor-rules?vendor=`: the active category rule of a vendor, if any.
public struct VendorRuleResponse: Decodable, Sendable {
    public struct Rule: Decodable, Sendable { public let vendor: String?; public let category: String?; public let active: Bool? }
    public let rule: Rule?
    public var isActive: Bool { rule?.active == true }
}

public struct ReceiptCounts: Decodable, Sendable {
    public struct Counts: Decodable, Sendable { public let all: Int; public let tulo: Int; public let meno: Int; public let linked: Int; public let unlinked: Int }
    public let counts: Counts
}

/// `POST /api/receipts/batch-approve` answers 200 even when some receipts were refused.
public struct BatchApproveResult: Decodable, Sendable {
    public struct Failure: Decodable, Sendable { public let id: String; public let error: String? }
    public let succeeded: Int?
    public let failed: [Failure]?
    public var firstError: String? { failed?.first.map { $0.error ?? "Hyväksyntä epäonnistui." } }
}
