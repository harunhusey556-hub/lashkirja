import Foundation

public enum InvoiceStatus: String, Codable, Sendable, CaseIterable {
    case draft, sent, overdue, paid, credited

    public var label: String {
        switch self {
        case .draft: "Luonnos"
        case .sent: "Odottaa maksua"
        case .overdue: "Myöhässä"
        case .paid: "Maksettu"
        case .credited: "Hyvitetty"
        }
    }
}

public struct Invoice: Decodable, Sendable, Identifiable, Hashable {
    public struct Line: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let description: String
        public let quantity: Decimal
        public let unit: String
        public let unitPrice: Decimal
        public let vatRate: Decimal
        public let net: Decimal
    }
    public struct Payment: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let paidDate: String
        public let amount: Decimal
        public let source: String
        public let transactionId: String?
        public let note: String?
    }
    public struct Send: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let toAddress: String
        public let status: String
        public let error: String?
        public let createdAt: String
        /// The PDF and sum that attempt carried (web Historia shows them); absent from older servers.
        public var attachmentName: String?
        public var gross: Decimal?
    }
    public struct Activity: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let kind: String
        public let summary: String
        public let createdAt: String
    }
    public struct Party: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let email: String?
        public let businessId: String?
    }
    public struct Ref: Decodable, Sendable, Hashable { public let id: String; public let number: Int }

    public let id: String
    public let number: Int
    public let reference: String
    public let status: String
    public let displayStatus: InvoiceStatus
    public let issueDate: String
    public let dueDate: String
    public let sentAt: String?
    public let paidAt: String?
    public let notes: String?
    public let currency: String
    public let net: Decimal
    public let vat: Decimal
    public let gross: Decimal
    public let paid: Decimal
    public let open: Decimal
    public let closedReason: String?
    public let updatedAt: String
    public let documentKind: String
    public let creditsInvoice: Ref?
    public let customer: Party
    public let lines: [Line]
    public let payments: [Payment]
    public let sends: [Send]
    public let activity: [Activity]
    /// The bank virtual barcode (pankkiviivakoodi) to paste into a bank app; nil when the invoice
    /// has none (credit note, no IBAN, ...). `barcodeIssue` then says why, when the server knows.
    public var barcode: String?
    public var barcodeIssue: String?

    public var isCreditNote: Bool { documentKind == "credit_note" }
}

/// `PATCH /api/invoices/{id}` for a draft: the server wants the version it
/// is replacing (`expectedUpdatedAt`) and a due date, not a payment term.
public struct InvoicePatch: Encodable, Sendable {
    public let draft: InvoiceDraft
    public let expectedUpdatedAt: String

    public init(draft: InvoiceDraft, expectedUpdatedAt: String) {
        self.draft = draft
        self.expectedUpdatedAt = expectedUpdatedAt
    }

    enum CodingKeys: String, CodingKey { case customerId, issueDate, dueDate, notes, lines, expectedUpdatedAt }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(draft.customerId, forKey: .customerId)
        try c.encode(draft.issueDate, forKey: .issueDate)
        if let issue = APIDate.day(draft.issueDate),
           let due = Calendar(identifier: .gregorian).date(byAdding: .day, value: draft.paymentTermDays, to: issue) {
            try c.encode(APIDate.dayString(due), forKey: .dueDate)
        }
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if notes.isEmpty { try c.encodeNil(forKey: .notes) } else { try c.encode(notes, forKey: .notes) }
        try c.encode(draft.lines, forKey: .lines)
        try c.encode(expectedUpdatedAt, forKey: .expectedUpdatedAt)
    }
}

public struct InvoiceList: Decodable, Sendable {
    public struct Aging: Decodable, Sendable {
        public struct Bucket: Decodable, Sendable, Hashable {
            public let count: Int
            public let openCents: Int
        }
        public let totalOpen: Decimal
        public let overdue: Decimal
        public let overdueCount: Int
        /// Open money by days late ("not_due", "1-30", "31-60", "61-90", "90+"); see `Receivables.swift`.
        public let buckets: [String: Bucket]?
        /// Money received on invoices in the last 90 days, for the "Saatavat" bar.
        public let paidRecentCents: Int?
    }
    public let invoices: [Invoice]
    public let aging: Aging
}

/// `GET /api/invoices/{id}`: the invoice, plus hand-recorded payments that an
/// income receipt from a bank row seems to count a second time.
public struct InvoiceDetailResponse: Decodable, Sendable {
    public let invoice: Invoice
    public let paymentDuplicates: [PaymentDuplicate]?
}
public struct InvoiceResponse: Decodable, Sendable { public let invoice: Invoice }
public struct InvoiceCounts: Decodable, Sendable { public let counts: [String: Int] }

/// The body of `POST /api/invoices` (strict on the server: only these keys).
public struct InvoiceDraft: Encodable, Sendable, Equatable {
    public struct Line: Codable, Sendable, Equatable, Identifiable {
        public var id = UUID()
        public var description: String
        public var quantity: Decimal
        public var unit: String
        public var unitPrice: Decimal
        public var vatRate: Decimal

        public init(description: String = "", quantity: Decimal = 1, unit: String = "kpl", unitPrice: Decimal = 0, vatRate: Decimal = Decimal(string: "25.5")!) {
            self.description = description
            self.quantity = quantity
            self.unit = unit
            self.unitPrice = unitPrice
            self.vatRate = vatRate
        }

        enum CodingKeys: String, CodingKey { case description, quantity, unit, unitPrice, vatRate }
    }

    public var customerId: String
    public var issueDate: String
    public var paymentTermDays: Int
    public var notes: String = ""
    public var lines: [Line] = []

    public init(customerId: String, issueDate: String, paymentTermDays: Int) {
        self.customerId = customerId
        self.issueDate = issueDate
        self.paymentTermDays = paymentTermDays
    }

    enum CodingKeys: String, CodingKey { case customerId, issueDate, paymentTermDays, notes, lines }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(customerId, forKey: .customerId)
        try c.encode(issueDate, forKey: .issueDate)
        try c.encode(paymentTermDays, forKey: .paymentTermDays)
        let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { try c.encode(trimmed, forKey: .notes) }
        try c.encode(lines, forKey: .lines)
    }

    /// Totals as the server computes them: net summed per VAT rate, VAT rounded once per rate.
    public var totals: (net: Decimal, vat: Decimal, gross: Decimal) {
        var netByRate: [Decimal: Decimal] = [:]
        for line in lines { netByRate[line.vatRate, default: 0] += Self.round2(line.quantity * line.unitPrice) }
        let net = netByRate.values.reduce(0, +)
        let vat = netByRate.reduce(Decimal(0)) { $0 + Self.round2($1.value * $1.key / 100) }
        return (net, vat, net + vat)
    }

    public var validationError: String? {
        if customerId.isEmpty { return "Valitse asiakas." }
        if lines.isEmpty { return "Lisää vähintään yksi rivi." }
        if lines.contains(where: { $0.description.trimmingCharacters(in: .whitespaces).isEmpty }) { return "Jokaisella rivillä tarvitaan kuvaus." }
        if lines.contains(where: { $0.quantity <= 0 }) { return "Määrän on oltava suurempi kuin nolla." }
        // The server refuses a rate that is not valid on the invoice date (a 14 % line in 2026).
        if APIDate.day(issueDate) != nil, let note = lines.lazy.compactMap({ SalesVat.dateNote($0.vatRate, issueDate: self.issueDate) }).first {
            return note
        }
        return nil
    }

    static func round2(_ value: Decimal) -> Decimal {
        var input = value
        var output = Decimal()
        NSDecimalRound(&output, &input, 2, .plain)
        return output
    }
}

extension InvoiceDraft.Line {
    /// A new line at the seller's rate: 0 % for a seller outside the VAT register.
    public static func new(sellerRegistered: Bool) -> InvoiceDraft.Line {
        sellerRegistered ? .init() : .init(vatRate: 0)
    }
}

extension InvoiceDraft {
    /// A seller outside the VAT register charges no VAT, whatever a line holds (the server applies
    /// the same rule; this keeps the preview honest). A registered seller's lines are left as typed.
    public mutating func followSellerVat(registered: Bool) {
        lines.followSellerVat(registered: registered)
    }
}

extension Array where Element == InvoiceDraft.Line {
    /// The same rule for any list of lines (recurring invoices use them too).
    public mutating func followSellerVat(registered: Bool) {
        guard !registered else { return }
        for index in indices where self[index].vatRate != 0 { self[index].vatRate = 0 }
    }
}
