import Foundation

/// `GET /api/alv?period=YYYY-MM|YYYY-Qn|YYYY`, the OmaVero fields.
public struct AlvReport: Decodable, Sendable {
    public struct Period: Decodable, Sendable { public let key: String }
    public struct SalesField: Decodable, Sendable { public let label: String; public let netSales: Decimal; public let vat: Decimal }
    public struct TurnoverField: Decodable, Sendable { public let label: String; public let turnover: Decimal }
    public struct AmountField: Decodable, Sendable { public let label: String; public let amount: Decimal }
    public struct PayableField: Decodable, Sendable { public let label: String; public let amount: Decimal; public let isRefund: Bool }
    public struct Filing: Decodable, Sendable {
        public let filedAt: String?
        public let paidAt: String?
        /// Field 308 as filed, signed euros (negative = refund); nil on returns filed before it was kept.
        public let filedAmount: Decimal?

        enum CodingKeys: String, CodingKey { case filedAt, paidAt, filedAmount }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            filedAt = try c.decodeIfPresent(String.self, forKey: .filedAt)
            paidAt = try c.decodeIfPresent(String.self, forKey: .paidAt)
            filedAmount = try c.decodeMoneyIfPresent(.filedAmount)
        }
    }

    /// Where the reported VAT came from, so a field can open its documents (web FP-12).
    public struct Sources: Decodable, Sendable {
        public let receiptSalesVat: Decimal?
        public let invoiceSalesVat: Decimal?
        public let invoiceCount: Int?
        public let purchaseInvoiceVat: Decimal?
        public let purchaseInvoiceCount: Int?
    }

    /// Receipts with no VAT breakdown, left out of the fields (web "N kuittia ilman ALV-erittelyä").
    public struct Review: Decodable, Sendable {
        public let salesGross: Decimal
        public let purchasesGross: Decimal
        public let count: Int

        enum CodingKeys: String, CodingKey { case salesGross, purchasesGross, count }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            salesGross = try c.decodeMoneyIfPresent(.salesGross) ?? 0
            purchasesGross = try c.decodeMoneyIfPresent(.purchasesGross) ?? 0
            count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        }
    }

    public let period: Period
    public let vatRegistered: Bool
    public let field301: SalesField
    public let field302: SalesField
    public let field303: SalesField
    public let field309: TurnoverField
    public let field307: AmountField
    public let field308: PayableField
    public let receiptCount: Int?
    public let pendingReceiptCount: Int?
    public let filing: Filing?
    public let basis: String?
    public let sources: Sources?
    public let review: Review?
    /// Income receipts left out because their bank row is already matched to an invoice.
    public let excludedReceiptCount: Int?
    public let creditNoteCount: Int?
    /// F39: purchase invoices left out, flagged as possible duplicates, or counted because the linked receipt cannot be.
    public let skippedPurchaseInvoiceCount: Int?
    public let suspectedPurchaseDuplicateCount: Int?
    public let purchaseReceiptUnusableCount: Int?
}
