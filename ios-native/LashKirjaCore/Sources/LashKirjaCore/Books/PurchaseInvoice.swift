import Foundation

/// A payable's stored status (`/api/purchase-invoices`).
public enum PurchaseStatus: String, Codable, Sendable, CaseIterable {
    case open, paid, cancelled

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PurchaseStatus(rawValue: raw) ?? .open
    }
}

/// What the list shows: an open payable past its due date reads as overdue.
public enum PurchaseDisplayStatus: String, Codable, Sendable, CaseIterable {
    case open, overdue, paid, cancelled

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PurchaseDisplayStatus(rawValue: raw) ?? .open
    }

    /// The web app's `PURCHASE_STATUS` labels.
    public var label: String {
        switch self {
        case .open: "Odottaa maksua"
        case .overdue: "Myöhässä"
        case .paid: "Maksettu"
        case .cancelled: "Mitätöity"
        }
    }
}

/// `PublicPurchaseInvoice` from `app/src/lib/purchase-invoices.ts`.
public struct PurchaseInvoice: Decodable, Sendable, Identifiable, Hashable {
    public struct Payment: Decodable, Sendable, Identifiable, Hashable {
        /// The bank row that paid it (`payments[].transaction`).
        public struct BankRow: Decodable, Sendable, Hashable {
            public let id: String
            public let statementId: String?
            public let date: String?
            public let counterparty: String?
            /// Signed, as on the statement.
            public let amount: Decimal

            enum CodingKeys: String, CodingKey { case id, statementId, date, counterparty, amount }

            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = try c.decode(String.self, forKey: .id)
                statementId = try c.decodeIfPresent(String.self, forKey: .statementId)
                date = try c.decodeIfPresent(String.self, forKey: .date)
                counterparty = try c.decodeIfPresent(String.self, forKey: .counterparty)
                amount = try c.decodeMoneyIfPresent(.amount) ?? 0
            }
        }

        public let id: String
        public let paidDate: String
        public let amount: Decimal
        public let source: String
        public let transactionId: String?
        public let note: String?
        public let transaction: BankRow?

        enum CodingKeys: String, CodingKey { case id, paidDate, amount, source, transactionId, note, transaction }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            paidDate = try c.decodeIfPresent(String.self, forKey: .paidDate) ?? ""
            amount = try c.decodeMoneyIfPresent(.amount) ?? 0
            source = try c.decodeIfPresent(String.self, forKey: .source) ?? "manual"
            transactionId = try c.decodeIfPresent(String.self, forKey: .transactionId)
            note = try c.decodeIfPresent(String.self, forKey: .note)
            transaction = try? c.decodeIfPresent(BankRow.self, forKey: .transaction)
        }

        public var isFromBank: Bool { source == "bank" }
        /// Holds a bank row: removing it ("Irrota") frees the row for another invoice.
        public var isLinkedToBank: Bool { transactionId != nil }
    }

    public let id: String
    public let supplierName: String
    public let supplierBusinessId: String?
    public let supplierIban: String?
    public let invoiceNumber: String?
    public let reference: String?
    public let issueDate: String
    public let dueDate: String
    public let status: PurchaseStatus
    public let displayStatus: PurchaseDisplayStatus
    public let gross: Decimal
    public let vat: Decimal
    public let net: Decimal
    public let paid: Decimal
    public let open: Decimal
    public let closedReason: String?
    public let category: String?
    public let notes: String?
    public let paidAt: String?
    public let receiptId: String?
    public let payments: [Payment]

    enum CodingKeys: String, CodingKey {
        case id, supplierName, supplierBusinessId, supplierIban, invoiceNumber, reference, issueDate, dueDate
        case status, displayStatus, gross, vat, net, paid, open, closedReason, category, notes, paidAt, receiptId, payments
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        supplierName = try c.decodeIfPresent(String.self, forKey: .supplierName) ?? ""
        supplierBusinessId = try c.decodeIfPresent(String.self, forKey: .supplierBusinessId)
        supplierIban = try c.decodeIfPresent(String.self, forKey: .supplierIban)
        invoiceNumber = try c.decodeIfPresent(String.self, forKey: .invoiceNumber)
        reference = try c.decodeIfPresent(String.self, forKey: .reference)
        issueDate = try c.decodeIfPresent(String.self, forKey: .issueDate) ?? ""
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate) ?? ""
        status = try c.decodeIfPresent(PurchaseStatus.self, forKey: .status) ?? .open
        displayStatus = try c.decodeIfPresent(PurchaseDisplayStatus.self, forKey: .displayStatus) ?? .open
        gross = try c.decodeMoneyIfPresent(.gross) ?? 0
        vat = try c.decodeMoneyIfPresent(.vat) ?? 0
        net = try c.decodeMoneyIfPresent(.net) ?? gross - vat
        paid = try c.decodeMoneyIfPresent(.paid) ?? 0
        open = try c.decodeMoneyIfPresent(.open) ?? 0
        closedReason = try c.decodeIfPresent(String.self, forKey: .closedReason)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        paidAt = try c.decodeIfPresent(String.self, forKey: .paidAt)
        receiptId = try c.decodeIfPresent(String.self, forKey: .receiptId)
        payments = try c.decodeIfPresent([Payment].self, forKey: .payments) ?? []
    }

    /// The list row's second line, as the web's `rowSecondary`: "A-12 · eräpäivä 15.9. · avoinna 100,00 €".
    public var rowSecondary: String {
        let phrase = displayStatus == .overdue ? "myöhässä, eräpäivä" : "eräpäivä"
        let dateText = "\(phrase) \(Self.dayMonth(dueDate))"
        let base: String
        if let number = invoiceNumber, !number.isEmpty {
            base = "\(number) · \(dateText)"
        } else {
            base = dateText.prefix(1).uppercased() + dateText.dropFirst()
        }
        let partiallyPaid = paid > 0 && open > 0
        return partiallyPaid ? "\(base) · avoinna \(Money.format(open))" : base
    }

    /// "15.9." from "2026-09-15".
    static func dayMonth(_ day: String) -> String {
        let parts = day.prefix(10).split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let dayNumber = Int(parts[2]) else { return "–" }
        return "\(dayNumber).\(month)."
    }

    // Server rules (`updatePurchaseInvoice`, `deletePurchaseInvoice`).

    /// Only an invoice without payments can be deleted.
    public var canDelete: Bool { payments.isEmpty }
    /// Cancelling is refused once a payment is recorded.
    public var canCancel: Bool { status == .open && payments.isEmpty }
    public var canRecordPayment: Bool { status == .open }
    public var canMarkPaid: Bool { status == .open }
    /// Marking paid without full payments needs a written reason (3+ characters).
    public var markPaidNeedsReason: Bool { paid < gross }
    public var canReopen: Bool { status != .open }
}

public struct PurchaseInvoiceResponse: Decodable, Sendable { public let invoice: PurchaseInvoice }

/// `GET /api/purchase-invoices`: the rows (capped at `limit`) and the payables aging.
public struct PurchaseInvoiceList: Decodable, Sendable {
    public static let limit = 200

    public struct Aging: Decodable, Sendable {
        public struct Bucket: Decodable, Sendable {
            public let count: Int
            public let openCents: Int
        }
        public static let overdueBuckets = ["1-30", "31-60", "61-90", "90+"]

        public let buckets: [String: Bucket]
        public let totalOpen: Decimal
        public let overdue: Decimal
        public let overdueCount: Int

        enum CodingKeys: String, CodingKey { case buckets, totalOpen, overdue, overdueCount }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            buckets = (try? c.decodeIfPresent([String: Bucket].self, forKey: .buckets)) ?? [:]
            totalOpen = try c.decodeMoneyIfPresent(.totalOpen) ?? 0
            overdue = try c.decodeMoneyIfPresent(.overdue) ?? 0
            overdueCount = try c.decodeIfPresent(Int.self, forKey: .overdueCount) ?? 0
        }

        /// A bucket's open euros ("1-30" → 100), zero when absent.
        public func bucket(_ key: String) -> Decimal {
            Decimal(buckets[key]?.openCents ?? 0) / 100
        }
    }

    public let invoices: [PurchaseInvoice]
    public let aging: Aging?
}

/// `GET /api/purchase-invoices/counts`.
public struct PurchaseStatusCounts: Decodable, Sendable, Equatable {
    public let open: Int
    public let overdue: Int
    public let paid: Int
    public let cancelled: Int

    public init(open: Int, overdue: Int, paid: Int, cancelled: Int) {
        self.open = open
        self.overdue = overdue
        self.paid = paid
        self.cancelled = cancelled
    }

    enum CodingKeys: String, CodingKey { case open, overdue, paid, cancelled }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = try c.decodeIfPresent(Int.self, forKey: .open) ?? 0
        overdue = try c.decodeIfPresent(Int.self, forKey: .overdue) ?? 0
        paid = try c.decodeIfPresent(Int.self, forKey: .paid) ?? 0
        cancelled = try c.decodeIfPresent(Int.self, forKey: .cancelled) ?? 0
    }

    public var total: Int { open + overdue + paid + cancelled }

    public func count(_ status: PurchaseDisplayStatus) -> Int {
        switch status {
        case .open: open
        case .overdue: overdue
        case .paid: paid
        case .cancelled: cancelled
        }
    }
}

public struct PurchaseInvoiceCountsResponse: Decodable, Sendable { public let counts: PurchaseStatusCounts }

/// The list filter, `lib/purchase-invoice-groups.ts`.
public enum PurchaseFilter: String, Sendable, CaseIterable, Identifiable, Hashable {
    case all, overdue, open, paid, cancelled

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: "Kaikki"
        case .overdue: "Myöhässä"
        case .open: "Odottaa maksua"
        case .paid: "Maksetut"
        case .cancelled: "Mitätöidyt"
        }
    }

    /// The `status` query parameter; "all" sends none.
    public var queryValue: String? { self == .all ? nil : rawValue }

    var displayStatus: PurchaseDisplayStatus? {
        switch self {
        case .all: nil
        case .overdue: .overdue
        case .open: .open
        case .paid: .paid
        case .cancelled: .cancelled
        }
    }

    static let order: [PurchaseDisplayStatus] = [.overdue, .open, .paid, .cancelled]

    public struct Chip: Sendable, Hashable, Identifiable {
        public let filter: PurchaseFilter
        public let label: String
        public let count: Int
        public var id: PurchaseFilter { filter }
    }

    public struct Group: Sendable, Identifiable {
        public let status: PurchaseDisplayStatus
        public let label: String
        public let items: [PurchaseInvoice]
        public var id: PurchaseDisplayStatus { status }
    }

    static func groupLabel(_ status: PurchaseDisplayStatus) -> String {
        switch status {
        case .overdue: "Myöhässä"
        case .open: "Odottaa maksua"
        case .paid: "Maksetut"
        case .cancelled: "Mitätöidyt"
        }
    }

    /// "Kaikki" plus one chip per status; "Mitätöidyt" only once something is cancelled.
    public static func chips(_ counts: PurchaseStatusCounts) -> [Chip] {
        var chips = [Chip(filter: .all, label: PurchaseFilter.all.label, count: counts.total)]
        for filter in [PurchaseFilter.overdue, .open, .paid, .cancelled] {
            if filter == .cancelled && counts.cancelled == 0 { continue }
            chips.append(Chip(filter: filter, label: filter.label, count: counts.count(filter.displayStatus!)))
        }
        return chips
    }

    /// The sections to show: every non-empty status in order for "all", else at most one.
    public static func groups(_ invoices: [PurchaseInvoice], filter: PurchaseFilter) -> [Group] {
        let statuses = filter.displayStatus.map { [$0] } ?? order
        return statuses.compactMap { status in
            let items = invoices.filter { $0.displayStatus == status }
            return items.isEmpty ? nil : Group(status: status, label: groupLabel(status), items: items)
        }
    }
}

/// `GET /api/purchase-invoices/[id]/receipts`: the linked receipt and likely candidates.
public struct PurchaseReceiptCandidate: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let vendor: String?
    public let date: String?
    public let gross: Decimal?
    public let reviewStatus: String
    public let sameAmount: Bool

    enum CodingKeys: String, CodingKey { case id, vendor, date, gross, reviewStatus, sameAmount }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        gross = try c.decodeMoneyIfPresent(.gross)
        reviewStatus = try c.decodeIfPresent(String.self, forKey: .reviewStatus) ?? ""
        sameAmount = try c.decodeIfPresent(Bool.self, forKey: .sameAmount) ?? false
    }

    /// "Kauppa · 12.8.2026 · 124,00 €", whatever of it is known.
    public var text: String {
        let name = vendor?.trimmingCharacters(in: .whitespaces).isEmpty == false ? vendor!.trimmingCharacters(in: .whitespaces) : "Kuitti"
        return [name, date.map(APIDate.displayDay), gross.map { Money.format($0) }].compactMap { $0 }.joined(separator: " · ")
    }
}

public struct PurchaseReceiptLinks: Decodable, Sendable {
    public let linked: PurchaseReceiptCandidate?
    public let candidates: [PurchaseReceiptCandidate]

    enum CodingKeys: String, CodingKey { case linked, candidates }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        linked = try c.decodeIfPresent(PurchaseReceiptCandidate.self, forKey: .linked)
        candidates = try c.decodeIfPresent([PurchaseReceiptCandidate].self, forKey: .candidates) ?? []
    }
}

/// `POST /api/purchase-invoices/match`.
public struct PurchaseMatchResult: Decodable, Sendable {
    public struct Applied: Decodable, Sendable { public let invoiceId: String; public let supplierName: String }
    public struct Skipped: Decodable, Sendable { public let invoiceId: String; public let supplierName: String }
    /// A bank row + purchase invoice pair for the owner: "Hyväksy" posts the payment with the row, "Hylkää" forgets it.
    public struct Suggestion: Decodable, Sendable, Identifiable, Hashable {
        public let invoiceId: String
        public let supplierName: String
        public let invoiceNumber: String?
        public let open: Decimal?
        public let transactionId: String?
        public let amount: Decimal?
        public let paidDate: String?
        public let counterparty: String?
        public let reasons: [String]

        public var id: String { "\(transactionId ?? ""):\(invoiceId)" }

        enum CodingKeys: String, CodingKey { case invoiceId, supplierName, invoiceNumber, open, transactionId, amount, paidDate, counterparty, reasons }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            invoiceId = try c.decode(String.self, forKey: .invoiceId)
            supplierName = try c.decodeIfPresent(String.self, forKey: .supplierName) ?? ""
            invoiceNumber = try c.decodeIfPresent(String.self, forKey: .invoiceNumber)
            open = try c.decodeMoneyIfPresent(.open)
            transactionId = try c.decodeIfPresent(String.self, forKey: .transactionId)
            amount = try c.decodeMoneyIfPresent(.amount)
            paidDate = try c.decodeIfPresent(String.self, forKey: .paidDate)
            counterparty = try c.decodeIfPresent(String.self, forKey: .counterparty)
            reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
        }

        /// Accepting needs the row, its amount and its date (an older server sent only names).
        public var canAccept: Bool { transactionId != nil && (amount ?? 0) > 0 && paidDate != nil }

        /// "Pankista 25.1.2026 · Tukku Oy · 124,00 €".
        public var bankLine: String {
            var parts = ["Pankista" + (paidDate.map { " \(APIDate.displayDay($0))" } ?? "")]
            if let name = PurchaseBankLinkText.nonEmpty(counterparty) { parts.append(name) }
            if let amount { parts.append(Money.format(amount)) }
            return parts.joined(separator: " · ")
        }

        public var why: String? { BankMatchText.why(reasons) }

        /// The payment "Hyväksy" records: the whole row, dated as the bank dated it.
        public var acceptBody: PurchasePaymentBody? {
            guard canAccept, let amount, let paidDate, let transactionId else { return nil }
            return PurchasePaymentBody(amount: amount, paidDate: paidDate, transactionId: transactionId)
        }
    }

    public let applied: [Applied]
    public let skippedLocked: [Skipped]
    public let suggestions: [Suggestion]

    enum CodingKeys: String, CodingKey { case applied, skippedLocked, suggestions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        applied = try c.decodeIfPresent([Applied].self, forKey: .applied) ?? []
        skippedLocked = try c.decodeIfPresent([Skipped].self, forKey: .skippedLocked) ?? []
        suggestions = try c.decodeIfPresent([Suggestion].self, forKey: .suggestions) ?? []
    }

    /// The web's toast text.
    public var summary: String {
        if applied.isEmpty && suggestions.isEmpty { return "Ei kohdistettavia maksuja." }
        return "Kohdistettiin \(applied.count) maksua viitenumerolla. \(suggestions.count) mahdollista osumaa vaatii tarkistuksen."
    }
}

/// Finnish domestic reference numbers (viitenumero), `lib/finnish-reference.ts`.
public enum PurchaseReference {
    public static func normalize(_ value: String) -> String {
        value.filter { !$0.isWhitespace }
    }

    public static func isValid(_ value: String) -> Bool {
        let digits = normalize(value)
        guard (4...20).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        guard digits.contains(where: { $0 != "0" }) else { return false }
        let numbers = digits.compactMap { $0.wholeNumberValue }
        let base = numbers.dropLast()
        let weights = [7, 3, 1]
        var sum = 0
        for (index, digit) in base.reversed().enumerated() { sum += digit * weights[index % 3] }
        return (10 - sum % 10) % 10 == numbers.last
    }
}

/// The body of `POST /api/purchase-invoices` (nil fields are left out).
public struct PurchaseInvoiceInput: Encodable, Sendable, Equatable {
    public var supplierName: String
    public var invoiceNumber: String?
    public var reference: String?
    public var issueDate: String
    public var dueDate: String
    public var gross: Decimal
    public var vat: Decimal
    public var category: String?
    public var notes: String?
}

/// A `PATCH /api/purchase-invoices/[id]` that carries only what changed.
public struct PurchaseInvoicePatch: Encodable, Sendable {
    var supplierName: String?
    var invoiceNumber: String??
    var reference: String??
    var issueDate: String?
    var dueDate: String?
    var gross: Decimal?
    var vat: Decimal?
    var category: String??
    var notes: String??

    public init(from input: PurchaseInvoiceInput, existing: PurchaseInvoice) {
        if input.supplierName != existing.supplierName { supplierName = input.supplierName }
        if input.invoiceNumber != Self.clean(existing.invoiceNumber) { invoiceNumber = .some(input.invoiceNumber) }
        if input.reference != Self.clean(existing.reference).map(PurchaseReference.normalize) { reference = .some(input.reference) }
        if input.issueDate != existing.issueDate { issueDate = input.issueDate }
        if input.dueDate != existing.dueDate { dueDate = input.dueDate }
        if input.gross != existing.gross { gross = input.gross }
        if input.vat != existing.vat { vat = input.vat }
        if input.category != Self.clean(existing.category) { category = .some(input.category) }
        if input.notes != Self.clean(existing.notes) { notes = .some(input.notes) }
    }

    static func clean(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    public var isEmpty: Bool {
        supplierName == nil && invoiceNumber == nil && reference == nil && issueDate == nil && dueDate == nil
            && gross == nil && vat == nil && category == nil && notes == nil
    }

    enum CodingKeys: String, CodingKey { case supplierName, invoiceNumber, reference, issueDate, dueDate, gross, vat, category, notes }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(supplierName, forKey: .supplierName)
        try c.encodeIfPresent(issueDate, forKey: .issueDate)
        try c.encodeIfPresent(dueDate, forKey: .dueDate)
        try c.encodeIfPresent(gross, forKey: .gross)
        try c.encodeIfPresent(vat, forKey: .vat)
        for (value, key) in [(invoiceNumber, CodingKeys.invoiceNumber), (reference, .reference), (category, .category), (notes, .notes)] {
            if case .some(let inner) = value {
                if let inner { try c.encode(inner, forKey: key) } else { try c.encodeNil(forKey: key) }
            }
        }
    }
}

/// The "Uusi ostolasku" / "Muokkaa" form, validated like the web page.
public struct PurchaseInvoiceForm: Sendable, Equatable {
    public enum Field: String, Sendable, Hashable { case supplierName, gross, vat, dueDate, reference }

    public struct Validation: Sendable {
        public let errors: [Field: String]
        public let input: PurchaseInvoiceInput?
    }

    public var supplierName = ""
    public var invoiceNumber = ""
    public var reference = ""
    public var issueDate: String
    public var dueDate: String
    public var gross = ""
    public var vat = ""
    public var category = ""
    public var notes = ""

    public init(today: String) {
        issueDate = today
        dueDate = today
    }

    public init(editing invoice: PurchaseInvoice) {
        supplierName = invoice.supplierName
        invoiceNumber = invoice.invoiceNumber ?? ""
        reference = invoice.reference ?? ""
        issueDate = invoice.issueDate
        dueDate = invoice.dueDate
        gross = Self.amountText(invoice.gross)
        vat = invoice.vat == 0 ? "" : Self.amountText(invoice.vat)
        category = invoice.category ?? ""
        notes = invoice.notes ?? ""
    }

    /// "124,00" for a text field.
    public static func amountText(_ value: Decimal) -> String {
        Money.format(value).replacingOccurrences(of: "\u{00A0}€", with: "")
    }

    /// Why a typed amount cannot be saved (`moneyEntryProblem`), or nil.
    public static func moneyProblem(_ value: Decimal) -> String? {
        if abs(value) > Decimal(string: "21474836.47")! { return "Summa on liian suuri." }
        var input = value * 100
        var rounded = Decimal()
        NSDecimalRound(&rounded, &input, 0, .plain)
        if rounded != value * 100 { return "Summassa saa olla enintään kaksi desimaalia." }
        return nil
    }

    public func validate() -> Validation {
        var errors: [Field: String] = [:]
        let name = supplierName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { errors[.supplierName] = "Anna toimittajan nimi." }

        let grossValue = Money.parse(gross)
        if let g = grossValue, g > 0 {
            if let problem = Self.moneyProblem(g) { errors[.gross] = problem }
        } else {
            errors[.gross] = "Anna laskun summa, esim. 124,00."
        }

        let vatTrimmed = vat.trimmingCharacters(in: .whitespaces)
        let vatValue: Decimal? = vatTrimmed.isEmpty ? 0 : Money.parse(vatTrimmed)
        if let v = vatValue, v >= 0 {
            if let problem = Self.moneyProblem(v) { errors[.vat] = problem }
        } else {
            errors[.vat] = "ALV on virheellinen."
        }
        if let g = grossValue, let v = vatValue, v > g { errors[.vat] = "ALV ei voi ylittää summaa." }

        if dueDate < issueDate { errors[.dueDate] = "Eräpäivä ei voi olla ennen laskun päivää." }
        let referenceTrimmed = reference.trimmingCharacters(in: .whitespaces)
        if !referenceTrimmed.isEmpty && !PurchaseReference.isValid(referenceTrimmed) {
            errors[.reference] = "Viitenumero ei täsmää."
        }

        guard errors.isEmpty, let g = grossValue, let v = vatValue else { return Validation(errors: errors, input: nil) }
        let input = PurchaseInvoiceInput(
            supplierName: name,
            invoiceNumber: PurchaseInvoicePatch.clean(invoiceNumber),
            reference: referenceTrimmed.isEmpty ? nil : PurchaseReference.normalize(referenceTrimmed),
            issueDate: issueDate,
            dueDate: dueDate,
            gross: g,
            vat: v,
            category: PurchaseInvoicePatch.clean(category),
            notes: PurchaseInvoicePatch.clean(notes)
        )
        return Validation(errors: [:], input: input)
    }
}

/// A status change through `PATCH /api/purchase-invoices/[id]`.
public struct PurchaseStatusChange: Encodable, Sendable {
    public let status: PurchaseStatus
    public let closeReason: String?

    public init(status: PurchaseStatus, closeReason: String? = nil) {
        self.status = status
        self.closeReason = PurchaseInvoicePatch.clean(closeReason)
    }

    /// The server wants at least three characters when the payments do not cover the invoice.
    public static func reasonIsLongEnough(_ reason: String) -> Bool {
        reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
    }
}

/// Links a receipt to the invoice, or removes the link (`receiptId: null`).
public struct PurchaseReceiptLink: Encodable, Sendable {
    public let receiptId: String?
    public init(receiptId: String?) { self.receiptId = receiptId }

    enum CodingKeys: String, CodingKey { case receiptId }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let receiptId { try c.encode(receiptId, forKey: .receiptId) } else { try c.encodeNil(forKey: .receiptId) }
    }
}

/// The body of `POST /api/purchase-invoices/[id]/payments`; with `transactionId` the payment is that bank row.
public struct PurchasePaymentBody: Encodable, Sendable, Equatable {
    public let amount: Decimal
    public let paidDate: String
    public let transactionId: String?
    public let note: String?

    public init(amount: Decimal, paidDate: String, transactionId: String? = nil, note: String? = nil) {
        self.amount = amount
        self.paidDate = paidDate
        self.transactionId = transactionId
        self.note = PurchaseInvoicePatch.clean(note)
    }

    /// Why a typed payment amount is refused, or nil.
    public static func problem(amountText: String) -> String? {
        guard let amount = Money.parse(amountText), amount > 0 else { return "Anna maksun summa, esim. 124,00." }
        return PurchaseInvoiceForm.moneyProblem(amount)
    }
}
