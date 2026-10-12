import Foundation

/// `GET /api/ledger?year=` — the double-entry books of one fiscal year, derived from the
/// documents on the server (`lib/ledger`). Amounts arrive in cents.
public struct LedgerBooks: Decodable, Sendable {
    public struct Line: Decodable, Sendable, Identifiable {
        public let code: String
        public let name: String
        public let cents: Int
        public var id: String { code }
    }
    public struct TrialRow: Decodable, Sendable, Identifiable {
        public let code: String
        public let name: String
        public let balanceCents: Int
        public var id: String { code }
    }
    public struct Entry: Decodable, Sendable, Identifiable {
        public struct EntryLine: Decodable, Sendable { public let account: String; public let debitCents: Int; public let creditCents: Int }
        public let voucher: Int
        public let id: String
        public let date: String
        public let description: String
        public let lines: [EntryLine]
    }
    public struct Income: Decodable, Sendable {
        public let revenue: [Line]
        public let expenses: [Line]
        public let revenueCents: Int
        public let expensesCents: Int
        public let resultCents: Int
    }
    public struct Sheet: Decodable, Sendable {
        public let assets: [Line]
        public let liabilities: [Line]
        public let equity: [Line]
        public let assetsCents: Int
        public let liabilitiesAndEquityCents: Int
    }
    public struct Notes: Decodable, Sendable {
        public let openingBalanceMissing: Bool
        public let suspenseCents: Int
        public let balances: Bool
    }

    public let year: Int
    public let journal: [Entry]
    public let trialBalance: [TrialRow]
    public let incomeStatement: Income
    public let balanceSheet: Sheet
    public let notes: Notes

    /// Cents as euros for `MoneyText`.
    public static func euros(_ cents: Int) -> Decimal { Decimal(cents) / 100 }

    /// "Tosite 12 · 3.9.2026"
    public static func voucherTitle(_ entry: Entry) -> String {
        let parts = entry.date.split(separator: "-")
        let date = parts.count == 3 ? "\(Int(parts[2]) ?? 0).\(Int(parts[1]) ?? 0).\(parts[0])" : entry.date
        return "Tosite \(entry.voucher) · \(date)"
    }
}
