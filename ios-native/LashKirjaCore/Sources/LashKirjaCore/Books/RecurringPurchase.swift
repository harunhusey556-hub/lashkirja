import Foundation

// Toistuvat ostolaskut: monthly rent and other routine bills that become a purchase invoice
// every period (`/api/recurring-purchases`). Every field is decoded leniently, so a server
// that is a step behind (or ahead) still gives a usable list.

/// The VAT rates a recurring purchase may carry, as the picker shows them.
public enum PurchaseVatRate {
    public static let allowed: [Decimal] = [Decimal(string: "25.5")!, 14, Decimal(string: "13.5")!, 10, 0]

    /// "25,5 %", "0 %".
    public static func label(_ rate: Decimal) -> String {
        "\(NSDecimalNumber(decimal: rate).stringValue.replacingOccurrences(of: ".", with: ",")) %"
    }

    /// The allowed rate closest to what an invoice's net and VAT imply.
    public static func nearest(net: Decimal, vat: Decimal) -> Decimal {
        guard vat > 0 else { return 0 }
        guard net > 0 else { return allowed[0] }
        let implied = vat / net * 100
        return allowed.min { abs($0 - implied) < abs($1 - implied) } ?? 0
    }

    /// Net and VAT of a gross amount, rounded to the cent as the server does
    /// (`round(grossCents * rate / (100 + rate))`).
    public static func split(gross: Decimal, rate: Decimal) -> (net: Decimal, vat: Decimal) {
        guard rate > 0 else { return (gross, 0) }
        var raw = gross * 100 * rate / (100 + rate)
        var cents = Decimal()
        NSDecimalRound(&cents, &raw, 0, .plain)
        let vat = cents / 100
        return (gross - vat, vat)
    }
}

/// One template (`RecurringPurchaseView`).
public struct RecurringPurchase: Decodable, Sendable, Identifiable, Hashable {
    public struct LastInvoice: Decodable, Sendable, Hashable {
        public let id: String
        public let issueDate: String
        public let dueDate: String
        public let status: PurchaseStatus
        public let grossAmount: Decimal

        enum CodingKeys: String, CodingKey { case id, issueDate, dueDate, status, grossAmount }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            issueDate = try c.decodeIfPresent(String.self, forKey: .issueDate) ?? ""
            dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate) ?? ""
            status = try c.decodeIfPresent(PurchaseStatus.self, forKey: .status) ?? .open
            grossAmount = try c.decodeMoneyIfPresent(.grossAmount) ?? 0
        }
    }

    public let id: String
    public let supplierName: String
    public let supplierBusinessId: String?
    public let supplierIban: String?
    public let reference: String?
    public let category: String?
    public let notes: String?
    public let grossAmount: Decimal
    public let vatRate: Decimal
    public let netAmount: Decimal
    public let vatAmount: Decimal
    public let interval: RecurrenceInterval
    public let dayOfMonth: Int
    public let dueDays: Int
    public let startDate: String
    public let endDate: String?
    public let active: Bool
    public let nextRunDate: String?
    public let lastRunAt: String?
    public let runCount: Int
    public let lastInvoice: LastInvoice?

    enum CodingKeys: String, CodingKey {
        case id, supplierName, supplierBusinessId, supplierIban, reference, category, notes
        case grossAmount, vatRate, netAmount, vatAmount, interval, dayOfMonth, dueDays, startDate, endDate
        case active, nextRunDate, lastRunAt, runCount, lastInvoice
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        supplierName = try c.decodeIfPresent(String.self, forKey: .supplierName) ?? ""
        supplierBusinessId = try c.decodeIfPresent(String.self, forKey: .supplierBusinessId)
        supplierIban = try c.decodeIfPresent(String.self, forKey: .supplierIban)
        reference = try c.decodeIfPresent(String.self, forKey: .reference)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        grossAmount = try c.decodeMoneyIfPresent(.grossAmount) ?? 0
        vatRate = try c.decodeMoneyIfPresent(.vatRate) ?? 0
        let split = PurchaseVatRate.split(gross: grossAmount, rate: vatRate)
        netAmount = try c.decodeMoneyIfPresent(.netAmount) ?? split.net
        vatAmount = try c.decodeMoneyIfPresent(.vatAmount) ?? split.vat
        interval = (try? c.decodeIfPresent(RecurrenceInterval.self, forKey: .interval)) ?? .monthly
        dayOfMonth = try c.decodeIfPresent(Int.self, forKey: .dayOfMonth) ?? 1
        dueDays = try c.decodeIfPresent(Int.self, forKey: .dueDays) ?? 14
        startDate = String((try c.decodeIfPresent(String.self, forKey: .startDate) ?? "").prefix(10))
        endDate = try c.decodeIfPresent(String.self, forKey: .endDate).map { String($0.prefix(10)) }
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? true
        nextRunDate = try c.decodeIfPresent(String.self, forKey: .nextRunDate).map { String($0.prefix(10)) }
        lastRunAt = try c.decodeIfPresent(String.self, forKey: .lastRunAt)
        runCount = try c.decodeIfPresent(Int.self, forKey: .runCount) ?? 0
        lastInvoice = try c.decodeIfPresent(LastInvoice.self, forKey: .lastInvoice)
    }

    /// "Joka kuukausi 1. päivä".
    public var scheduleText: String {
        RecurringPurchaseSchedule.label(interval: interval, dayOfMonth: dayOfMonth, startDate: startDate)
    }

    /// The list row's second line: "Joka kuukausi 1. päivä · seuraava 1.11.".
    public func secondary(today: String) -> String {
        let next = nextRunDate.map { "seuraava \(RecurringInvoice.scheduleDate($0, today: today))" } ?? "päättynyt"
        return "\(scheduleText) · \(next)"
    }
}

/// `GET /api/recurring-purchases`.
public struct RecurringPurchaseList: Decodable, Sendable {
    public let recurring: [RecurringPurchase]

    enum CodingKeys: String, CodingKey { case recurring }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recurring = try c.decodeIfPresent([RecurringPurchase].self, forKey: .recurring) ?? []
    }

    public var activeCount: Int { recurring.filter(\.active).count }

    /// Running templates first, soonest next invoice first; paused ones after them.
    public var ordered: [RecurringPurchase] {
        recurring.enumerated().sorted { a, b in
            if a.element.active != b.element.active { return a.element.active }
            let x = a.element.nextRunDate ?? "9999", y = b.element.nextRunDate ?? "9999"
            return x == y ? a.offset < b.offset : x < y
        }.map(\.element)
    }
}

public struct RecurringPurchaseResponse: Decodable, Sendable { public let recurring: RecurringPurchase }

/// `POST /api/recurring-purchases/:id/run` ("Luo nyt").
public struct RecurringPurchaseRunResult: Decodable, Sendable {
    public let created: Bool
    public let purchaseInvoiceId: String?

    enum CodingKeys: String, CodingKey { case created, purchaseInvoiceId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = try c.decodeIfPresent(Bool.self, forKey: .created) ?? false
        purchaseInvoiceId = try c.decodeIfPresent(String.self, forKey: .purchaseInvoiceId)
    }

    public var message: String { created ? "Ostolasku luotiin." : "Tämän kauden ostolasku on jo luotu." }
}

/// `PATCH /api/recurring-purchases/:id` that pauses or resumes a template.
public struct RecurringPurchaseActivePatch: Encodable, Sendable {
    public let active: Bool
    public init(active: Bool) { self.active = active }
}

public enum RecurringPurchaseText {
    public static let title = "Toistuvat ostolaskut"
    /// Shown instead of an error while the server does not have the feature yet.
    public static let unavailable = "Toistuvat ostolaskut tulevat käyttöön pian. Siihen asti voit lisätä ostolaskut tavalliseen tapaan."
    public static let deleteMessage = "Uusia ostolaskuja ei enää luoda. Jo luodut ostolaskut säilyvät."

    /// The Ostolaskut header row: "Ei vielä", "1 toistuva", "3 toistuvaa".
    public static func countLabel(_ count: Int) -> String {
        switch count {
        case 0: "Ei vielä"
        case 1: "1 toistuva"
        default: "\(count) toistuvaa"
        }
    }

    /// A 404 from the list means the server has no such route yet.
    public static func isUnavailable(_ error: Error) -> Bool {
        (error as? LKError)?.status == 404
    }
}

// MARK: - Schedule

/// Date arithmetic on "YYYY-MM-DD" strings, matching the server's `lib/recurrence.ts`
/// (the day is 1–28, so no month is ever too short for it).
public enum RecurringPurchaseSchedule {
    private static func parts(_ day: String) -> (year: Int, month: Int, day: Int)? {
        let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return (p[0], p[1], p[2])
    }

    private static func iso(_ year: Int, _ month: Int, _ day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func months(_ interval: RecurrenceInterval) -> Int {
        switch interval {
        case .monthly: 1
        case .quarterly: 3
        case .yearly: 12
        }
    }

    private static func adding(months count: Int, to date: String, day: Int) -> String {
        guard let p = parts(date) else { return date }
        let total = p.year * 12 + (p.month - 1) + count
        return iso(total / 12, total % 12 + 1, day)
    }

    public static func label(interval: RecurrenceInterval, dayOfMonth: Int, startDate: String) -> String {
        switch interval {
        case .monthly: return "Joka kuukausi \(dayOfMonth). päivä"
        case .quarterly: return "Joka neljännes \(dayOfMonth). päivä"
        case .yearly:
            let month = parts(startDate)?.month
            return month.map { "Joka vuosi \(dayOfMonth).\($0)." } ?? "Joka vuosi \(dayOfMonth). päivä"
        }
    }

    /// The first issue date on or after the start that falls on the day.
    public static func firstRun(startDate: String, dayOfMonth: Int, interval: RecurrenceInterval) -> String? {
        guard let p = parts(startDate) else { return nil }
        let anchored = iso(p.year, p.month, dayOfMonth)
        return dayOfMonth >= p.day ? anchored : adding(months: months(interval), to: anchored, day: dayOfMonth)
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private static func date(_ day: String) -> Date? {
        guard let p = parts(day) else { return nil }
        return calendar.date(from: DateComponents(year: p.year, month: p.month, day: p.day))
    }

    public static func dueDate(issue: String, dueDays: Int) -> String {
        guard let start = date(issue), let due = calendar.date(byAdding: .day, value: dueDays, to: start) else { return issue }
        let c = calendar.dateComponents([.year, .month, .day], from: due)
        return iso(c.year!, c.month!, c.day!)
    }

    /// Whole days from one date to another (negative when `to` is earlier).
    public static func days(from: String, to: String) -> Int {
        guard let a = date(from), let b = date(to) else { return 0 }
        return calendar.dateComponents([.day], from: a, to: b).day ?? 0
    }

    /// What the form says will happen: the first invoice to be made and its due date.
    /// `coveredPeriod` ("YYYY-MM") is the month an existing invoice already stands for.
    public static func preview(startDate: String, dayOfMonth: Int, interval: RecurrenceInterval, dueDays: Int,
                               endDate: String?, coveredPeriod: String?, today: String) -> String? {
        guard (1...28).contains(dayOfMonth), var issue = firstRun(startDate: startDate, dayOfMonth: dayOfMonth, interval: interval) else { return nil }
        let covered = coveredPeriod != nil && issue.prefix(7) == coveredPeriod!.prefix(7)
        if covered { issue = adding(months: months(interval), to: issue, day: dayOfMonth) }
        if let endDate, !endDate.isEmpty, issue > endDate {
            return "Päättymispäivä on ennen ensimmäistä ostolaskua, joten yhtään ostolaskua ei luoda."
        }
        let due = dueDate(issue: issue, dueDays: dueDays)
        let lead = covered ? "Seuraava ostolasku" : "Ensimmäinen ostolasku"
        let text = "\(lead) \(APIDate.displayDay(issue)), eräpäivä \(APIDate.displayDay(due))."
        return issue <= today ? "\(text) Se luodaan heti, kun tallennat." : text
    }
}

// MARK: - Form

/// The body of `POST /api/recurring-purchases` and of the edit `PATCH`.
public struct RecurringPurchaseInput: Sendable, Equatable {
    public var supplierName: String
    public var supplierBusinessId: String?
    public var supplierIban: String?
    public var reference: String?
    public var category: String?
    public var notes: String?
    public var grossAmount: Decimal
    public var vatRate: Decimal
    public var interval: RecurrenceInterval
    public var dayOfMonth: Int
    public var dueDays: Int
    public var startDate: String
    public var endDate: String?
    public var fromPurchaseInvoiceId: String?

    /// A new template leaves empty fields out; an edit sends them as null so the server clears them.
    public func body(forEdit: Bool) -> Body { Body(input: self, forEdit: forEdit) }

    public struct Body: Encodable, Sendable {
        let input: RecurringPurchaseInput
        let forEdit: Bool

        enum CodingKeys: String, CodingKey {
            case supplierName, supplierBusinessId, supplierIban, reference, category, notes, grossAmount, vatRate
            case interval, dayOfMonth, dueDays, startDate, endDate, fromPurchaseInvoiceId
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(input.supplierName, forKey: .supplierName)
            try c.encode(input.grossAmount, forKey: .grossAmount)
            try c.encode(input.vatRate, forKey: .vatRate)
            try c.encode(input.interval, forKey: .interval)
            try c.encode(input.dayOfMonth, forKey: .dayOfMonth)
            try c.encode(input.dueDays, forKey: .dueDays)
            try c.encode(input.startDate, forKey: .startDate)
            let optional: [(String?, CodingKeys)] = [
                (input.supplierBusinessId, .supplierBusinessId), (input.supplierIban, .supplierIban),
                (input.reference, .reference), (input.category, .category), (input.notes, .notes), (input.endDate, .endDate),
            ]
            for (value, key) in optional {
                if let value { try c.encode(value, forKey: key) } else if forEdit { try c.encodeNil(forKey: key) }
            }
            if !forEdit, let from = input.fromPurchaseInvoiceId { try c.encode(from, forKey: .fromPurchaseInvoiceId) }
        }
    }
}

/// The "Uusi toistuva ostolasku" / "Muokkaa" form, validated before the server sees it.
public struct RecurringPurchaseForm: Sendable, Equatable {
    public enum Field: String, Sendable, Hashable {
        case supplierName, businessId = "supplierBusinessId", iban = "supplierIban", reference, gross = "grossAmount"
        case dayOfMonth, dueDays, startDate, endDate, category, notes
    }

    public struct Validation: Sendable {
        public let errors: [Field: String]
        public let input: RecurringPurchaseInput?
    }

    public var supplierName = ""
    public var businessId = ""
    public var iban = ""
    public var reference = ""
    public var gross = ""
    public var vatRate: Decimal = PurchaseVatRate.allowed[0]
    public var category = ""
    public var interval: RecurrenceInterval = .monthly
    public var dayOfMonth: Int
    public var dueDays = 14
    public var startDate: String
    public var endDate: String?
    public var notes = ""
    /// Set when made from an existing invoice ("Tee toistuvaksi"): that invoice is this template's first run.
    public private(set) var fromPurchaseInvoiceId: String?
    /// The month that invoice stands for, so the preview starts after it.
    public private(set) var coveredPeriod: String?

    public init(today: String) {
        startDate = today
        dayOfMonth = min(max(Int(today.suffix(2)) ?? 1, 1), 28)
    }

    public init(editing r: RecurringPurchase) {
        supplierName = r.supplierName
        businessId = r.supplierBusinessId ?? ""
        iban = r.supplierIban ?? ""
        reference = r.reference ?? ""
        gross = PurchaseInvoiceForm.amountText(r.grossAmount)
        vatRate = PurchaseVatRate.allowed.contains(r.vatRate) ? r.vatRate : PurchaseVatRate.nearest(net: r.netAmount, vat: r.vatAmount)
        category = r.category ?? ""
        interval = r.interval
        dayOfMonth = r.dayOfMonth
        dueDays = r.dueDays
        startDate = r.startDate
        endDate = r.endDate
        notes = r.notes ?? ""
    }

    /// "Tee toistuvaksi": the invoice's supplier, amount and rhythm, starting from its own date.
    public init(from invoice: PurchaseInvoice) {
        supplierName = invoice.supplierName
        businessId = invoice.supplierBusinessId ?? ""
        iban = invoice.supplierIban ?? ""
        reference = invoice.reference ?? ""
        gross = PurchaseInvoiceForm.amountText(invoice.gross)
        vatRate = PurchaseVatRate.nearest(net: invoice.net, vat: invoice.vat)
        category = invoice.category ?? ""
        let issue = String(invoice.issueDate.prefix(10))
        // 28 is the last day every month has.
        dayOfMonth = min(max(Int(issue.suffix(2)) ?? 1, 1), 28)
        dueDays = min(max(RecurringPurchaseSchedule.days(from: issue, to: String(invoice.dueDate.prefix(10))), 0), 90)
        startDate = issue
        fromPurchaseInvoiceId = invoice.id
        coveredPeriod = String(issue.prefix(7))
    }

    public var grossValue: Decimal? { Money.parse(gross) }

    public func preview(today: String) -> String? {
        RecurringPurchaseSchedule.preview(startDate: startDate, dayOfMonth: dayOfMonth, interval: interval, dueDays: dueDays,
                                          endDate: endDate, coveredPeriod: coveredPeriod, today: today)
    }

    public func validate() -> Validation {
        var errors: [Field: String] = [:]
        let name = supplierName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { errors[.supplierName] = "Anna toimittajan nimi." }
        else if name.count > 120 { errors[.supplierName] = "Nimi on liian pitkä." }

        let businessTrimmed = businessId.trimmingCharacters(in: .whitespaces)
        if !businessTrimmed.isEmpty && !Self.isValidBusinessId(businessTrimmed) {
            errors[.businessId] = "Toimittajan Y-tunnus ei ole kelvollinen."
        }
        let ibanNormalized = Self.normalizeIban(iban)
        if !ibanNormalized.isEmpty && !Self.isValidIban(ibanNormalized) {
            errors[.iban] = "Toimittajan IBAN ei ole kelvollinen."
        }
        let referenceTrimmed = reference.trimmingCharacters(in: .whitespaces)
        if !referenceTrimmed.isEmpty && !PurchaseReference.isValid(referenceTrimmed) {
            errors[.reference] = "Viitenumero ei täsmää."
        }

        if let g = grossValue, g > 0 {
            if let problem = PurchaseInvoiceForm.moneyProblem(g) { errors[.gross] = problem }
        } else {
            errors[.gross] = "Anna summa, esim. 850,00."
        }

        if !(1...28).contains(dayOfMonth) { errors[.dayOfMonth] = "Päivä on 1–28." }
        if !(0...90).contains(dueDays) { errors[.dueDays] = "Eräaika on 0–90 päivää." }
        if APIDate.day(startDate) == nil { errors[.startDate] = "Valitse aloituspäivä." }
        if let endDate, !endDate.isEmpty, endDate < startDate { errors[.endDate] = "Päättymispäivä ei voi olla ennen aloitusta." }
        if category.trimmingCharacters(in: .whitespaces).count > 60 { errors[.category] = "Luokka on liian pitkä." }
        if notes.count > 2000 { errors[.notes] = "Muistiinpano on liian pitkä." }

        guard errors.isEmpty, let g = grossValue else { return Validation(errors: errors, input: nil) }
        let input = RecurringPurchaseInput(
            supplierName: name,
            supplierBusinessId: businessTrimmed.isEmpty ? nil : Self.normalizeBusinessId(businessTrimmed),
            supplierIban: ibanNormalized.isEmpty ? nil : ibanNormalized,
            reference: referenceTrimmed.isEmpty ? nil : PurchaseReference.normalize(referenceTrimmed),
            category: PurchaseInvoicePatch.clean(category),
            notes: PurchaseInvoicePatch.clean(notes),
            grossAmount: g,
            vatRate: vatRate,
            interval: interval,
            dayOfMonth: dayOfMonth,
            dueDays: dueDays,
            startDate: startDate,
            endDate: endDate.flatMap { $0.isEmpty ? nil : $0 },
            fromPurchaseInvoiceId: fromPurchaseInvoiceId
        )
        return Validation(errors: [:], input: input)
    }

    // The server's checks (`lib/finnish-reference.ts`, `lib/iban.ts`), so a typo shows at the field.

    static func normalizeBusinessId(_ value: String) -> String {
        let digits = value.filter { $0.isASCII && $0.isNumber }
        guard digits.count == 8 else { return value.trimmingCharacters(in: .whitespaces).uppercased() }
        return "\(digits.prefix(7))-\(digits.suffix(1))"
    }

    static func isValidBusinessId(_ value: String) -> Bool {
        let normalized = normalizeBusinessId(value)
        guard normalized.range(of: #"^\d{7}-\d$"#, options: .regularExpression) != nil else { return false }
        let digits = normalized.compactMap(\.wholeNumberValue)
        let weights = [7, 9, 10, 5, 8, 4, 2]
        let sum = zip(digits.prefix(7), weights).reduce(0) { $0 + $1.0 * $1.1 }
        let remainder = sum % 11
        if remainder == 1 { return false }
        return (remainder == 0 ? 0 : 11 - remainder) == digits[7]
    }

    static func normalizeIban(_ value: String) -> String {
        value.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.uppercased()
    }

    private static let ibanLengths: [String: Int] = [
        "AT": 20, "BE": 16, "CH": 21, "CZ": 24, "DE": 22, "DK": 18, "EE": 20, "ES": 24, "FI": 18,
        "FR": 27, "GB": 22, "IE": 22, "IS": 26, "IT": 27, "LT": 20, "LU": 20, "LV": 21, "NL": 18,
        "NO": 15, "PL": 28, "PT": 25, "SE": 24, "SI": 19, "SK": 24,
    ]

    static func isValidIban(_ value: String) -> Bool {
        let iban = normalizeIban(value)
        guard iban.range(of: #"^[A-Z]{2}[0-9]{2}[0-9A-Z]{10,30}$"#, options: .regularExpression) != nil else { return false }
        if let expected = ibanLengths[String(iban.prefix(2))], iban.count != expected { return false }
        let rearranged = iban.dropFirst(4) + iban.prefix(4)
        var remainder = 0
        for ch in rearranged {
            let value = ch.isNumber ? ch.wholeNumberValue! : Int(ch.asciiValue!) - 55
            remainder = value >= 10 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97
        }
        return remainder == 1
    }
}

// MARK: - The "Toistuva" tag on purchase invoices

/// The invoice-to-template link the server adds to purchase invoices (`recurringPurchaseId`),
/// read beside the invoice so an older server without the field still decodes.
private struct RecurringTag: Decodable {
    let id: String
    let recurringPurchaseId: String?
}

/// `GET /api/purchase-invoices` with each invoice's template, when it has one.
public struct PurchaseInvoiceTaggedList: Decodable, Sendable {
    public let list: PurchaseInvoiceList
    /// Invoice id → template id.
    public let recurringIds: [String: String]

    enum CodingKeys: String, CodingKey { case invoices }

    public init(from decoder: Decoder) throws {
        list = try PurchaseInvoiceList(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let tags = (try? c.decodeIfPresent([RecurringTag].self, forKey: .invoices)) ?? []
        var ids: [String: String] = [:]
        for tag in tags { if let template = tag.recurringPurchaseId { ids[tag.id] = template } }
        recurringIds = ids
    }
}

/// `GET /api/purchase-invoices/:id` with the invoice's template, when it has one.
public struct PurchaseInvoiceTaggedResponse: Decodable, Sendable {
    public let invoice: PurchaseInvoice
    public let recurringPurchaseId: String?

    enum CodingKeys: String, CodingKey { case invoice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invoice = try c.decode(PurchaseInvoice.self, forKey: .invoice)
        recurringPurchaseId = (try? c.decodeIfPresent(RecurringTag.self, forKey: .invoice))?.recurringPurchaseId
    }
}
