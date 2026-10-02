import Foundation

/// `GET /api/dashboard?month=YYYY-MM`, the Koti screen.
public struct Dashboard: Decodable, Sendable {
    public let firstName: String?
    public let month: String
    public let income: Decimal
    public let expenses: Decimal
    public let source: String
    public let txCount: Int
    public let receiptCount: Int
    public let invoiceCount: Int
    public let pendingReceiptsCount: Int
    public let matching: Matching
    public let events: Events?
    public let handled: Handled?
    public let estimatedVat: Decimal?
    public let isRefund: Bool?
    public let vat: VatInfo?
    public let hasImap: Bool
    public let bank: BankSummary?
    public let bankTrend: BankTrend?
    public let cashflow: [CashflowMonth]
    public let receivables: OpenTotals?
    public let payables: OpenTotals?
    public let items: [DashboardItem]
    public let blockingTotal: Int?
    public let previousMonth: PreviousMonth?
    public let setup: Setup?
    public let sectionErrors: [String: String]?

    public struct Matching: Decodable, Sendable { public let matchable: Int; public let matched: Int; public let suggested: Int }
    public struct Events: Decodable, Sendable { public let done: Int; public let total: Int }
    public struct Handled: Decodable, Sendable {
        public let count: Int
        public let parts: [Part]
        public struct Part: Decodable, Sendable { public let kind: String; public let count: Int; public let label: String }
    }
    public struct VatInfo: Decodable, Sendable {
        public let registered: Bool
        public let entityType: String
        public let ytdRevenue: Decimal
        public let threshold: Decimal
        enum CodingKeys: String, CodingKey { case registered, entityType, ytdRevenue, threshold }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            registered = try c.decode(Bool.self, forKey: .registered)
            entityType = try c.decode(String.self, forKey: .entityType)
            ytdRevenue = try c.decodeMoney(.ytdRevenue)
            threshold = try c.decodeMoney(.threshold)
        }
    }
    public struct BankSummary: Decodable, Sendable {
        public let totalBalance: Decimal
        public let accountCount: Int
        public let needsAttention: Int
        public let state: String
        public let hasBalance: Bool
        enum CodingKeys: String, CodingKey { case totalBalance, accountCount, needsAttention, state, hasBalance }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalBalance = try c.decodeMoney(.totalBalance)
            accountCount = try c.decode(Int.self, forKey: .accountCount)
            needsAttention = try c.decode(Int.self, forKey: .needsAttention)
            state = try c.decode(String.self, forKey: .state)
            hasBalance = try c.decode(Bool.self, forKey: .hasBalance)
        }
    }
    public struct BankTrend: Decodable, Sendable { public let points: [BalancePoint] }
    public struct BalancePoint: Decodable, Sendable, Identifiable {
        public let month: String
        public let balance: Decimal
        public var id: String { month }
        enum CodingKeys: String, CodingKey { case month, balance }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            month = try c.decode(String.self, forKey: .month)
            balance = try c.decodeMoney(.balance)
        }
    }
    public struct CashflowMonth: Decodable, Sendable, Identifiable {
        public let month: String
        public let income: Decimal
        public let expenses: Decimal
        public var id: String { month }
        enum CodingKeys: String, CodingKey { case month, income, expenses }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            month = try c.decode(String.self, forKey: .month)
            income = try c.decodeMoney(.income)
            expenses = try c.decodeMoney(.expenses)
        }
    }
    public struct OpenTotals: Decodable, Sendable {
        public let totalOpen: Decimal
        public let overdue: Decimal
        public let overdueCount: Int
        enum CodingKeys: String, CodingKey { case totalOpen, overdue, overdueCount }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalOpen = try c.decodeMoney(.totalOpen)
            overdue = try c.decodeMoney(.overdue)
            overdueCount = try c.decode(Int.self, forKey: .overdueCount)
        }
    }
    public struct PreviousMonth: Decodable, Sendable { public let month: String; public let open: Int }
    public struct Setup: Decodable, Sendable { public let receipts: Bool; public let bank: Bool; public let seller: Bool; public let empty: Bool }

    enum CodingKeys: String, CodingKey {
        case firstName, month, income, expenses, source, txCount, receiptCount, invoiceCount, pendingReceiptsCount
        case matching, events, handled, estimatedVat, isRefund, vat, hasImap, bank, bankTrend, cashflow
        case receivables, payables, items, blockingTotal, previousMonth, setup, sectionErrors
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        firstName = try c.decodeIfPresent(String.self, forKey: .firstName)
        month = try c.decode(String.self, forKey: .month)
        income = try c.decodeMoney(.income)
        expenses = try c.decodeMoney(.expenses)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "kuitit"
        txCount = try c.decodeIfPresent(Int.self, forKey: .txCount) ?? 0
        receiptCount = try c.decodeIfPresent(Int.self, forKey: .receiptCount) ?? 0
        invoiceCount = try c.decodeIfPresent(Int.self, forKey: .invoiceCount) ?? 0
        pendingReceiptsCount = try c.decodeIfPresent(Int.self, forKey: .pendingReceiptsCount) ?? 0
        matching = try c.decode(Matching.self, forKey: .matching)
        events = try c.decodeIfPresent(Events.self, forKey: .events)
        handled = try c.decodeIfPresent(Handled.self, forKey: .handled)
        estimatedVat = try c.decodeMoneyIfPresent(.estimatedVat)
        isRefund = try c.decodeIfPresent(Bool.self, forKey: .isRefund)
        vat = try c.decodeIfPresent(VatInfo.self, forKey: .vat)
        hasImap = try c.decodeIfPresent(Bool.self, forKey: .hasImap) ?? false
        bank = try c.decodeIfPresent(BankSummary.self, forKey: .bank)
        bankTrend = try c.decodeIfPresent(BankTrend.self, forKey: .bankTrend)
        cashflow = try c.decodeIfPresent([CashflowMonth].self, forKey: .cashflow) ?? []
        receivables = try c.decodeIfPresent(OpenTotals.self, forKey: .receivables)
        payables = try c.decodeIfPresent(OpenTotals.self, forKey: .payables)
        items = try c.decodeIfPresent([DashboardItem].self, forKey: .items) ?? []
        blockingTotal = try c.decodeIfPresent(Int.self, forKey: .blockingTotal)
        previousMonth = try c.decodeIfPresent(PreviousMonth.self, forKey: .previousMonth)
        setup = try c.decodeIfPresent(Setup.self, forKey: .setup)
        sectionErrors = try c.decodeIfPresent([String: String].self, forKey: .sectionErrors)
    }
}

/// One thing Koti asks the owner to do. Fields not used by a kind are nil.
public struct DashboardItem: Decodable, Sendable, Identifiable, Equatable {
    public enum Kind: String, Sendable {
        case overdueInvoice = "overdue_invoice"
        case pendingReceipt = "pending_receipt"
        case vatGap = "vat_gap"
        case invoiceMatch = "invoice_match"
        case missingReceipt = "missing_receipt"
        case receiptMatch = "receipt_match"
        case paymentDuplicate = "payment_duplicate"
        case draftInvoice = "draft_invoice"
        case unknown
    }

    public let id: String
    public let kind: Kind
    public let party: String
    public let amount: Decimal?
    public let date: String?
    public let dueDate: String?
    public let paidDate: String?
    public let issueDate: String?
    public let invoiceId: String?
    public let customerId: String?
    public let receiptId: String?
    public let transactionId: String?
    public let number: Int?
    public let daysLate: Int?
    public let type: String?
    public let category: String?
    public let vatRate: Decimal?
    public let gaps: [String]
    public let fromBank: Bool

    enum CodingKeys: String, CodingKey {
        case id, kind, party, amount, date, dueDate, paidDate, issueDate, invoiceId, customerId, receiptId, transactionId
        case number, daysLate, type, category, vatRate, gaps, fromBank
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = Kind(rawValue: try c.decode(String.self, forKey: .kind)) ?? .unknown
        party = try c.decodeIfPresent(String.self, forKey: .party) ?? ""
        amount = try c.decodeMoneyIfPresent(.amount)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate)
        paidDate = try c.decodeIfPresent(String.self, forKey: .paidDate)
        issueDate = try c.decodeIfPresent(String.self, forKey: .issueDate)
        invoiceId = try c.decodeIfPresent(String.self, forKey: .invoiceId)
        customerId = try c.decodeIfPresent(String.self, forKey: .customerId)
        receiptId = try c.decodeIfPresent(String.self, forKey: .receiptId)
        transactionId = try c.decodeIfPresent(String.self, forKey: .transactionId)
        number = try c.decodeIfPresent(Int.self, forKey: .number)
        daysLate = try c.decodeIfPresent(Int.self, forKey: .daysLate)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        vatRate = try c.decodeMoneyIfPresent(.vatRate)
        gaps = try c.decodeIfPresent([String].self, forKey: .gaps) ?? []
        fromBank = try c.decodeIfPresent(Bool.self, forKey: .fromBank) ?? false
    }
}
