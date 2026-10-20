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
        /// A candidate's reasons in Finnish ("summa sama"), as the bank row picker gives them.
        public let explanation: [String]?

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
    /// The paged list's narrow row carries this instead of `match` ("linked" | "suggested" | "unlinked").
    public let matchStatus: String?
    /// ISO 4217 of the document; `totalAmount` stays in euros. "EUR" from an older server.
    public let currency: String
    /// The amount in `currency` when it is not EUR.
    public let originalAmount: Decimal?
    public let vatTreatment: PurchaseVatTreatment
    /// The rate that priced a non-EUR document (euros per unit), its day and where it came from
    /// ("ECB" or "document"); only the detail route sends them.
    public let fxRate: Double?
    public let fxRateDate: String?
    public let fxSource: String?
    /// `.invoice` for a bill filed as an ostolasku; only the paged list sends it, nil elsewhere.
    public let kind: ReceiptDocumentKind?

    enum CodingKeys: String, CodingKey {
        case id, vendor, date, category, type, reference, invoiceNumber, fileName, source, confidence
        case createdAt, updatedAt, totalAmount, reviewStatus, notes, vatDetails, linkedTransaction, match, matchStatus
        case currency, originalAmount, vatTreatment, fxRate, fxRateDate, fxSource, kind
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
        // A paged list may leave the timestamps out of its narrow rows (the detail always has them).
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
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
        matchStatus = try? c.decodeIfPresent(String.self, forKey: .matchStatus)
        currency = (try? c.decodeIfPresent(String.self, forKey: .currency)) ?? "EUR"
        originalAmount = try? c.decodeIfPresent(Decimal.self, forKey: .originalAmount)
        // An unknown value from a newer server reads as domestic rather than failing the screen.
        vatTreatment = (try? c.decodeIfPresent(String.self, forKey: .vatTreatment)).flatMap(PurchaseVatTreatment.init(rawValue:)) ?? .domestic
        // The rate line is extra information: a value of an odd type only hides it.
        fxRate = try? c.decodeIfPresent(Double.self, forKey: .fxRate)
        fxRateDate = try? c.decodeIfPresent(String.self, forKey: .fxRateDate)
        fxSource = try? c.decodeIfPresent(String.self, forKey: .fxSource)
        // Only a row's tag reads it: an unknown value hides the tag rather than failing the list.
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)).flatMap(ReceiptDocumentKind.init(rawValue:))
    }

    public var isIncome: Bool { type == "tulo" }
    public var title: String { vendor?.isEmpty == false ? vendor! : "Tuntematon myyjä" }
    /// A saved credit note: the server books it with a negative total and negative VAT rows.
    public var isCreditNote: Bool { (totalAmount ?? 0) < 0 }
    /// "Hyvityslasku" for a credit note, nil otherwise.
    public var creditNoteLabel: String? { isCreditNote ? CreditNoteText.label : nil }
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
    /// Where the next page starts on a server that pages (`?cursor=&limit=50`); nil on the last
    /// page and from an older server, which pages by `offset` and `truncated` instead.
    public let nextCursor: String?

    enum CodingKeys: String, CodingKey { case receipts, count, truncated, nextCursor, total, hasMore }

    public init(receipts: [Receipt], count: Int? = nil, truncated: Bool? = nil, nextCursor: String? = nil) {
        self.receipts = receipts
        self.count = count
        self.truncated = truncated
        self.nextCursor = nextCursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        receipts = try c.decode([Receipt].self, forKey: .receipts)
        // A paged answer may call them total/hasMore; either name reads, an odd type is unknown.
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? (try? c.decodeIfPresent(Int.self, forKey: .total))
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? (try? c.decodeIfPresent(Bool.self, forKey: .hasMore))
        let cursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
        nextCursor = cursor?.isEmpty == false ? cursor : nil
    }
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
    public struct Counts: Decodable, Sendable {
        public let all: Int; public let tulo: Int; public let meno: Int; public let linked: Int; public let unlinked: Int
        /// The bills filed as ostolaskut (the Laskut chip); absent from a server before the kuitti/lasku split.
        public let laskut: Int?
    }
    public let counts: Counts
}

/// `POST /api/receipts/batch-approve` answers 200 even when some receipts were refused.
public struct BatchApproveResult: Decodable, Sendable {
    public struct Failure: Decodable, Sendable { public let id: String; public let error: String? }
    /// The approved receipt ids.
    public let succeeded: [String]?
    public let failed: [Failure]?
    public let autoLinkedCount: Int?
    public var approvedCount: Int { succeeded?.count ?? 0 }
    public var firstError: String? { failed?.first.map { $0.error ?? "Hyväksyntä epäonnistui." } }
}

extension Receipt {
    /// Whether `/api/receipts/[id]/file` has something to show. A sale drafted from a bank row
    /// (`auto_income`) is stored with a placeholder name and no upload behind it.
    public var hasOriginalFile: Bool { fileName != nil && source != "auto_income" }

    /// A bank row explains the receipt: linked to it, or (a bill) paid from the bank through its
    /// ostolasku, which the list reports as `match.status == "linked"` with no linked row (W27).
    /// The same rule as the Kohdistettu / Ei kohdistettu chips.
    /// A paged (narrow) row says the same with `matchStatus`.
    public var isBankMatched: Bool { linkedTransaction != nil || match?.status == "linked" || matchStatus == "linked" }
}
