import Foundation

/// One outgoing bank row that may have paid a purchase invoice
/// (`GET /api/purchase-invoices/[id]/payments/candidates`, `app/src/lib/purchase-bank-match.ts`).
public struct PurchaseBankCandidate: Decodable, Sendable, Identifiable, Hashable {
    public let transactionId: String
    public let statementId: String?
    public let date: String?
    public let counterparty: String?
    public let message: String?
    public let reference: String?
    /// What the row paid, positive.
    public let amount: Decimal
    public let score: Double
    public let exactAmount: Bool
    /// Bank amount minus the amount owed, when it is a fee-sized difference.
    public let amountDiff: Decimal?
    /// Finnish reasons ("summa sama", "nimi vastaa", "summa poikkeaa 2,00 €").
    public let reasons: [String]

    public var id: String { transactionId }

    enum CodingKeys: String, CodingKey {
        case transactionId, statementId, date, counterparty, message, reference, amount, score, exactAmount, amountDiff, reasons
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transactionId = try c.decode(String.self, forKey: .transactionId)
        statementId = try c.decodeIfPresent(String.self, forKey: .statementId)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        counterparty = try c.decodeIfPresent(String.self, forKey: .counterparty)
        message = try c.decodeIfPresent(String.self, forKey: .message)
        reference = try c.decodeIfPresent(String.self, forKey: .reference)
        amount = abs(try c.decodeMoneyIfPresent(.amount) ?? 0)
        score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
        exactAmount = try c.decodeIfPresent(Bool.self, forKey: .exactAmount) ?? false
        amountDiff = try c.decodeMoneyIfPresent(.amountDiff)
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons) ?? []
    }

    /// The payee, or "Pankkitapahtuma" when the bank gave none.
    public var title: String { PurchaseBankLinkText.nonEmpty(counterparty) ?? "Pankkitapahtuma" }

    /// "25.1.2026 · Lasku 88123": the date and whatever the bank wrote.
    public var detail: String {
        [date.map(APIDate.displayDay), PurchaseBankLinkText.nonEmpty(message) ?? PurchaseBankLinkText.nonEmpty(reference)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// "Miksi: summa sama · nimi vastaa", nil without reasons.
    public var why: String? { BankMatchText.why(reasons) }
}

/// The bank-row list for one purchase invoice.
public struct PurchaseBankCandidateList: Decodable, Sendable {
    public struct MonthCount: Decodable, Sendable, Hashable, Identifiable {
        public let month: String
        public let count: Int
        public var id: String { month }
    }

    public let candidates: [PurchaseBankCandidate]
    /// Hits before the server's cap of 30.
    public let total: Int
    public let months: [MonthCount]

    enum CodingKeys: String, CodingKey { case candidates, total, months }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        candidates = try c.decodeIfPresent([PurchaseBankCandidate].self, forKey: .candidates) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? candidates.count
        months = try c.decodeIfPresent([MonthCount].self, forKey: .months) ?? []
    }

    /// Month chips only help when there are many rows across several months.
    public var showsMonthChips: Bool { months.count > 1 && months.reduce(0) { $0 + $1.count } > ShowMore.defaultStep }

    /// Said under the list when the server left rows out.
    public var cappedNote: String? {
        total > candidates.count ? "Näytetään \(candidates.count) parasta \(total) tapahtumasta. Tarkenna hakua tai valitse kuukausi." : nil
    }
}

/// One open purchase invoice that a bank row may have paid (`GET /api/matching/purchase-candidates`).
public struct PurchaseInvoiceCandidate: Decodable, Sendable, Identifiable, Hashable {
    public struct Invoice: Decodable, Sendable, Hashable {
        public let id: String
        public let supplierName: String
        public let invoiceNumber: String?
        public let reference: String?
        public let issueDate: String
        public let dueDate: String
        public let gross: Decimal
        public let open: Decimal

        enum CodingKeys: String, CodingKey { case id, supplierName, invoiceNumber, reference, issueDate, dueDate, gross, open }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            supplierName = try c.decodeIfPresent(String.self, forKey: .supplierName) ?? ""
            invoiceNumber = try c.decodeIfPresent(String.self, forKey: .invoiceNumber)
            reference = try c.decodeIfPresent(String.self, forKey: .reference)
            issueDate = try c.decodeIfPresent(String.self, forKey: .issueDate) ?? ""
            dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate) ?? ""
            gross = try c.decodeMoneyIfPresent(.gross) ?? 0
            open = try c.decodeMoneyIfPresent(.open) ?? gross
        }
    }

    public let invoice: Invoice
    public let score: Double
    public let exactAmount: Bool
    public let amountDiff: Decimal?
    public let reasons: [String]

    public var id: String { invoice.id }

    enum CodingKeys: String, CodingKey { case invoice, score, exactAmount, amountDiff, reasons }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invoice = try c.decode(Invoice.self, forKey: .invoice)
        score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
        exactAmount = try c.decodeIfPresent(Bool.self, forKey: .exactAmount) ?? false
        amountDiff = try c.decodeMoneyIfPresent(.amountDiff)
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons) ?? []
    }

    public var title: String { PurchaseBankLinkText.nonEmpty(invoice.supplierName) ?? "Ostolasku" }

    /// "A-12 · eräpäivä 24.1.2026".
    public var detail: String {
        [PurchaseBankLinkText.nonEmpty(invoice.invoiceNumber), invoice.dueDate.isEmpty ? nil : "eräpäivä \(APIDate.displayDay(invoice.dueDate))"]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    public var why: String? { BankMatchText.why(reasons) }
}

public struct PurchaseInvoiceCandidateList: Decodable, Sendable {
    public let candidates: [PurchaseInvoiceCandidate]
    public let total: Int

    enum CodingKeys: String, CodingKey { case candidates, total }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        candidates = try c.decodeIfPresent([PurchaseInvoiceCandidate].self, forKey: .candidates) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? candidates.count
    }
}

/// The confirm step of "Kohdista": which amount to record, and what to say about it.
public enum PurchaseBankLink {
    /// "Kohdista ostolaskuun" on a bank row: a payment out that no invoice or kuitti holds yet.
    public static func canLink(_ row: BankTransaction) -> Bool {
        guard row.amount < 0 else { return false }
        if row.type == "oma_siirto" || row.type == "palkka" { return false }
        if row.paidPurchase != nil || row.paidInvoice != nil || row.settlesPurchase == true || row.settlesInvoice == true { return false }
        // A row documented by a kuitti is that receipt's purchase.
        return row.receiptId == nil
    }

    /// The bank row's amount; when the row paid more than is still open (a fee), the open amount.
    public static func defaultAmount(bankAmount: Decimal, open: Decimal) -> Decimal {
        let paid = abs(bankAmount)
        return open > 0 && paid > open ? open : paid
    }

    /// Why a typed amount cannot be recorded against this row, or nil.
    public static func problem(amountText: String, bankAmount: Decimal) -> String? {
        if let problem = PurchasePaymentBody.problem(amountText: amountText) { return problem }
        guard let amount = Money.parse(amountText) else { return "Anna maksun summa, esim. 124,00." }
        if amount > abs(bankAmount) {
            return "Maksu ei voi olla suurempi kuin pankkitapahtuman summa (\(Money.format(abs(bankAmount))))."
        }
        return nil
    }

    /// What the chosen amount does to the invoice: paid in full, partly paid, or more than owed.
    public static func outcome(amount: Decimal, open: Decimal) -> String {
        if open <= 0 { return "Ostolasku on jo maksettu; maksu kirjataan silti." }
        if amount == open { return "Ostolasku merkitään maksetuksi." }
        if amount < open { return "Osamaksu: ostolaskulle jää avoimeksi \(Money.format(open - amount))." }
        return "Maksu on \(Money.format(amount - open)) suurempi kuin avoin summa."
    }

    /// The fee line when the bank row and the open amount differ.
    public static func differenceNote(bankAmount: Decimal, open: Decimal) -> String? {
        let paid = abs(bankAmount)
        guard open > 0, paid != open else { return nil }
        return paid > open
            ? "Pankkitapahtuma on \(Money.format(paid - open)) suurempi kuin avoin summa (esim. pankin kulu)."
            : "Pankkitapahtuma on \(Money.format(open - paid)) pienempi kuin avoin summa."
    }
}

/// `GET /api/purchase-invoices/match`: suggestions only, nothing written.
public struct PurchaseSuggestionList: Decodable, Sendable {
    public let suggestions: [PurchaseMatchResult.Suggestion]

    enum CodingKeys: String, CodingKey { case suggestions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        suggestions = try c.decodeIfPresent([PurchaseMatchResult.Suggestion].self, forKey: .suggestions) ?? []
    }
}

/// The body of `POST /api/purchase-invoices/match/reject` ("Hylkää").
public struct PurchaseSuggestionReject: Encodable, Sendable {
    public let invoiceId: String
    public let transactionId: String
    public init(invoiceId: String, transactionId: String) {
        self.invoiceId = invoiceId
        self.transactionId = transactionId
    }
}

public enum PurchaseBankLinkText {
    static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// "1 ehdotus" / "3 ehdotusta".
    public static func suggestionCount(_ count: Int) -> String {
        count == 1 ? "1 ehdotus" : "\(count) ehdotusta"
    }

    /// The payment row in the invoice: "Tukku Oy · pankista" for a bank-linked payment.
    public static func paymentDetail(_ payment: PurchaseInvoice.Payment) -> String {
        var parts: [String] = []
        if let row = payment.transaction {
            parts.append(nonEmpty(row.counterparty) ?? "Pankkitapahtuma")
            parts.append("pankista")
        } else if payment.isFromBank {
            parts.append("pankista")
        }
        if let note = nonEmpty(payment.note) { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}
