import Foundation

/// `GET /api/reports/profit-loss?from=YYYY-MM&to=YYYY-MM`.
public struct ProfitLoss: Decodable, Sendable {
    public struct Category: Decodable, Sendable, Hashable, Identifiable {
        public let category: String
        public let gross: Decimal
        public let vat: Decimal
        public let net: Decimal
        public let count: Int
        public var id: String { category }
    }
    public struct Period: Decodable, Sendable, Identifiable {
        public let month: String?
        public let incomeNet: Decimal
        public let incomeVat: Decimal
        public let incomeGross: Decimal
        public let expenseNet: Decimal
        public let expenseVat: Decimal
        public let expenseGross: Decimal
        public let profitNet: Decimal
        public let incomeByCategory: [Category]
        public let expenseByCategory: [Category]
        public let receiptCount: Int
        public let invoiceCount: Int
        /// Credit notes sit in the invoice list too; nil from a server that does not count them.
        public let creditNoteCount: Int?
        public var id: String { month ?? "total" }

        static func empty(_ month: String) -> Period {
            Period(month: month, incomeNet: 0, incomeVat: 0, incomeGross: 0, expenseNet: 0, expenseVat: 0, expenseGross: 0,
                   profitNet: 0, incomeByCategory: [], expenseByCategory: [], receiptCount: 0, invoiceCount: 0, creditNoteCount: 0)
        }
    }

    public let from: String
    public let to: String
    public let total: Period
    public let months: [Period]
    public let basis: String?

    /// All twelve months of `year`, empty ones included, for a steady chart.
    public func filledMonths(year: String) -> [Period] {
        (1...12).map { m in
            let key = String(format: "%@-%02d", year, m)
            return months.first { $0.month == key } ?? .empty(key)
        }
    }
}
