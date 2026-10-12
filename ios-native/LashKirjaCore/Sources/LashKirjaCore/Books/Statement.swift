import Foundation

public struct BankTransaction: Decodable, Sendable, Identifiable, Hashable {
    public struct ReceiptBrief: Decodable, Sendable, Hashable {
        public let id: String
        public let vendor: String?
        public let totalAmount: Decimal?
        public let source: String?
    }
    public struct InvoiceBrief: Decodable, Sendable, Hashable {
        public let id: String
        public let number: Int
    }
    /// The purchase invoice this row paid, and the payment that holds the row.
    public struct PurchaseBrief: Decodable, Sendable, Hashable {
        public let id: String
        public let supplierName: String
        public let paymentId: String
    }

    public let id: String
    public let statementId: String
    public let date: String?
    public let counterparty: String?
    public let reference: String?
    public let message: String?
    public let type: String
    public let amount: Decimal
    public let receiptId: String?
    public let suggestedReceiptId: String?
    public let matchStatus: String
    public let source: String?
    public let settlesInvoice: Bool?
    public let settlesPurchase: Bool?
    public let paidInvoice: InvoiceBrief?
    public let paidPurchase: PurchaseBrief?
    public let receipt: ReceiptBrief?
    public let suggestedReceipt: ReceiptBrief?
    /// Up to three scored receipts for an unmatched row (the statement GET adds them).
    public let matchCandidates: [BankMatchCandidate]?
    /// What the matcher stored with a suggestion: codes plus Finnish "fi:" reasons.
    public let matchReasons: MatchReasons?

    public var title: String {
        if let c = counterparty, !c.isEmpty { return c }
        return amount > 0 ? "Tulo" : "Meno"
    }
}

public struct Statement: Decodable, Sendable, Identifiable, Hashable {
    public struct Totals: Decodable, Sendable, Hashable {
        public let income: Decimal
        public let expenses: Decimal
        public let transfers: Decimal?
        public let net: Decimal
        public let txCount: Int
        /// Everything in and out as the bank counts it ("Panot" / "Otot"); missing from older servers.
        public let moneyIn: Decimal?
        public let moneyOut: Decimal?
    }
    public struct Account: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let bankName: String?
        public let iban: String?
        public let currency: String?
    }

    public let id: String
    public let fileName: String
    public let fileType: String?
    public let periodMonth: String?
    public let uploadedAt: String
    public let bankAccount: Account?
    public let transactions: [BankTransaction]
    public let totals: Totals?
}

/// `GET /api/statements`: the tiliotteet with their rows, or, asked with `?cursor=` from a server
/// that pages (W18), one page of rows newest first, each carrying its statement's month and
/// account. A page is read into the same shape: one statement per `statementId`, holding that
/// page's rows of it, so every screen groups and merges them the same way.
public struct StatementList: Decodable, Sendable {
    public let statements: [Statement]
    /// Where the next page starts (`?cursor=`); nil when this answer is the whole list, as from a
    /// server that does not page. Read leniently: an odd value means no more pages, not a failure.
    public let nextCursor: String?

    public init(statements: [Statement], nextCursor: String? = nil) {
        self.statements = statements
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey { case statements, transactions, nextCursor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let statements = try c.decodeIfPresent([Statement].self, forKey: .statements) {
            self.statements = statements
        } else {
            statements = StatementPaging.group(try c.decode([PagedFeedRow].self, forKey: .transactions))
        }
        let cursor: String? = (try? c.decodeIfPresent(String.self, forKey: .nextCursor)) ?? nil
        nextCursor = cursor.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// One row of the paged feed: the bank row plus where it is filed.
struct PagedFeedRow: Decodable {
    let row: BankTransaction
    let periodMonth: String?
    let bankAccountId: String?

    enum CodingKeys: String, CodingKey { case periodMonth, bankAccountId }

    init(from decoder: Decoder) throws {
        row = try BankTransaction(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        periodMonth = (try? c.decodeIfPresent(String.self, forKey: .periodMonth)) ?? nil
        bankAccountId = (try? c.decodeIfPresent(String.self, forKey: .bankAccountId)) ?? nil
    }
}
public struct StatementResponse: Decodable, Sendable { public let statement: Statement }

/// The Pankki screen's logic, the same rules as the web app's lib/bank-feed.ts.
public enum BankFeed {
    public enum State: String, Sendable {
        case sale, suggested, missing, linked, invoice, ignored, transfer
    }

    public struct Month: Sendable, Identifiable {
        public let month: String
        public let rows: [BankTransaction]
        public let open: Int
        public var id: String { month }
    }

    public static func state(of row: BankTransaction) -> State {
        if row.type == "oma_siirto" || row.type == "palkka" { return .transfer }
        if row.paidInvoice != nil || row.settlesInvoice == true || row.settlesPurchase == true { return .invoice }
        if row.matchStatus == "confirmed" { return .linked }
        if row.matchStatus == "ignored" { return .ignored }
        if row.matchStatus == "suggested", row.suggestedReceiptId != nil {
            return row.suggestedReceipt?.source == "auto_income" ? .sale : .suggested
        }
        return .missing
    }

    public static func needsAction(_ row: BankTransaction) -> Bool {
        switch state(of: row) {
        case .sale, .suggested, .missing: true
        default: false
        }
    }

    /// Every row of every statement, newest first, grouped by month.
    public static func months(_ statements: [Statement]) -> [Month] {
        var byMonth: [String: [BankTransaction]] = [:]
        for statement in statements {
            for row in statement.transactions {
                let month = statement.periodMonth ?? row.date.map(APIDate.monthOf) ?? ""
                byMonth[month, default: []].append(row)
            }
        }
        return byMonth.keys.sorted(by: >).map { month in
            let rows = byMonth[month]!.sorted { a, b in
                switch (a.date, b.date) {
                case let (x?, y?) where x != y: return x > y
                case (nil, _?): return false
                case (_?, nil): return true
                default: return a.id < b.id
                }
            }
            return Month(month: month, rows: rows, open: rows.filter(needsAction).count)
        }
    }

    public static func label(_ state: State, income: Bool) -> String {
        switch state {
        case .sale: "Hyväksy myynti"
        case .suggested: "Ehdotus"
        case .missing: income ? "Kuitti puuttuu" : "Kuitti puuttuu"
        case .linked: "Kohdistettu"
        case .invoice: "Laskun maksu"
        case .ignored: "Ei vaadi kuittia"
        case .transfer: "Siirto"
        }
    }
}

/// `GET /api/statements/counts`: bank rows that still need the owner.
public struct StatementOpenCount: Decodable, Sendable { public let open: Int }
