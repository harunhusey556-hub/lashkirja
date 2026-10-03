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

public struct StatementList: Decodable, Sendable { public let statements: [Statement] }
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
