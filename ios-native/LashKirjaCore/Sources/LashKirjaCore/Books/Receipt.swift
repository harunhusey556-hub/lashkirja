import Foundation

public struct Receipt: Decodable, Sendable, Identifiable, Hashable {
    public struct LinkedTransaction: Decodable, Sendable, Hashable {
        public let id: String
        public let date: String?
        public let counterparty: String?
        public let amount: Decimal
    }
    public struct Match: Decodable, Sendable, Hashable {
        public let status: String?
        public let suggestedTransaction: LinkedTransaction?
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

public struct ReceiptCounts: Decodable, Sendable {
    public struct Counts: Decodable, Sendable { public let all: Int; public let tulo: Int; public let meno: Int; public let linked: Int; public let unlinked: Int }
    public let counts: Counts
}
