import Foundation

public enum RecurrenceInterval: String, Codable, Sendable, CaseIterable, Identifiable {
    case monthly, quarterly, yearly

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .monthly: "Kuukausittain"
        case .quarterly: "Neljännesvuosittain"
        case .yearly: "Vuosittain"
        }
    }
}

/// A recurring invoice schedule (`/api/recurring-invoices`).
public struct RecurringInvoice: Decodable, Sendable, Identifiable, Hashable {
    public struct Line: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let description: String
        public let quantity: Decimal
        public let unit: String
        public let unitPrice: Decimal
        public let vatRate: Decimal

        enum CodingKeys: String, CodingKey { case id, description, quantity, unit, unitPrice, vatRate }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            description = try c.decode(String.self, forKey: .description)
            quantity = try c.decodeMoney(.quantity)
            unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? "kpl"
            unitPrice = try c.decodeMoney(.unitPrice)
            vatRate = try c.decodeMoney(.vatRate)
        }
    }
    public struct Party: Decodable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let email: String?
    }
    public struct LastRun: Decodable, Sendable, Hashable {
        public let issueDate: String
        public let status: String
        public let invoiceId: String?
    }
    public struct MissedRun: Decodable, Sendable, Hashable {
        public let issueDate: String
        public let reason: String
        public let note: String?
    }
    public struct FailedSend: Decodable, Sendable, Hashable {
        public let issueDate: String
        public let invoiceId: String
        public let note: String?
    }

    public let id: String
    public let name: String?
    public let interval: RecurrenceInterval
    public let anchorDay: Int
    public let startDate: String
    public let endDate: String?
    public let nextRunAt: String?
    public let paymentTermDays: Int
    public let notes: String?
    public let autoSend: Bool
    public let active: Bool
    public let customer: Party
    public let lines: [Line]
    public let total: Decimal
    public let generatedCount: Int
    public let lastRun: LastRun?
    public let missedRuns: [MissedRun]
    public let failedSends: [FailedSend]

    enum CodingKeys: String, CodingKey {
        case id, name, interval, anchorDay, startDate, endDate, nextRunAt, paymentTermDays, notes, autoSend, active
        case customer, lines, total, generatedCount, lastRun, missedRuns, failedSends
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        interval = try c.decode(RecurrenceInterval.self, forKey: .interval)
        anchorDay = try c.decode(Int.self, forKey: .anchorDay)
        startDate = try c.decode(String.self, forKey: .startDate)
        endDate = try c.decodeIfPresent(String.self, forKey: .endDate)
        nextRunAt = try c.decodeIfPresent(String.self, forKey: .nextRunAt)
        paymentTermDays = try c.decodeIfPresent(Int.self, forKey: .paymentTermDays) ?? 14
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        autoSend = try c.decodeIfPresent(Bool.self, forKey: .autoSend) ?? false
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? true
        customer = try c.decode(Party.self, forKey: .customer)
        lines = try c.decodeIfPresent([Line].self, forKey: .lines) ?? []
        total = try c.decodeMoneyIfPresent(.total) ?? 0
        generatedCount = try c.decodeIfPresent(Int.self, forKey: .generatedCount) ?? 0
        lastRun = try c.decodeIfPresent(LastRun.self, forKey: .lastRun)
        missedRuns = try c.decodeIfPresent([MissedRun].self, forKey: .missedRuns) ?? []
        failedSends = try c.decodeIfPresent([FailedSend].self, forKey: .failedSends) ?? []
    }

    /// The schedule's own name, or its customer's.
    public var title: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return customer.name
    }

    /// "d.M." for a date later this year, "d.M.yyyy" for a past one or another year.
    public static func scheduleDate(_ value: String, today: String) -> String {
        let day = String(value.prefix(10))
        guard APIDate.day(day) != nil else { return "–" }
        let full = APIDate.displayDay(day)
        if day < today || day.prefix(4) != today.prefix(4) { return full }
        let parts = full.split(separator: ".")
        return parts.count == 3 ? "\(parts[0]).\(parts[1])." : full
    }

    /// "<customer> · <interval> · seuraava <date>", the customer left out when it is the title.
    public func secondary(today: String) -> String {
        var parts: [String] = []
        if customer.name != title { parts.append(customer.name) }
        parts.append(interval.label)
        parts.append(nextRunAt.map { "seuraava \(Self.scheduleDate($0, today: today))" } ?? "päättynyt")
        if autoSend { parts.append("lähetetään automaattisesti") }
        if !failedSends.isEmpty { parts.append("lähetys epäonnistui") }
        if !missedRuns.isEmpty { parts.append("lasku jäi luomatta") }
        return parts.joined(separator: " · ")
    }

    /// An active schedule whose next run is today or earlier: "Luo lasku nyt" is offered.
    public func isDue(today: String) -> Bool {
        guard active, let next = nextRunAt else { return false }
        return String(next.prefix(10)) <= today
    }

    /// What the missed occurrences say, or nil when none were missed.
    public var missedText: String? {
        guard !missedRuns.isEmpty else { return nil }
        let dates = missedRuns.map { APIDate.displayDay($0.issueDate) }.joined(separator: ", ")
        let why = missedRuns.allSatisfy { $0.reason == "period_locked" }
            ? "Kausi on suljettu. Laskut luodaan, kun avaat kauden."
            : "Laskun luonti epäonnistui."
        return "Jäi luomatta: \(dates). \(why)"
    }
}

public struct RecurringList: Decodable, Sendable {
    public let recurring: [RecurringInvoice]
    public let dueNow: Int

    enum CodingKeys: String, CodingKey { case recurring, dueNow }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recurring = try c.decode([RecurringInvoice].self, forKey: .recurring)
        dueNow = try c.decodeIfPresent(Int.self, forKey: .dueNow) ?? 0
    }
}

public struct RecurringResponse: Decodable, Sendable { public let recurring: RecurringInvoice }

/// `PATCH /api/recurring-invoices/{id}` that pauses or resumes a schedule.
public struct RecurringActivePatch: Encodable, Sendable {
    public let active: Bool
    public init(active: Bool) { self.active = active }
}

/// The body of `POST /api/recurring-invoices` and of the edit `PATCH`.
public struct RecurringDraft: Encodable, Sendable, Equatable {
    public var customerId = ""
    public var name = ""
    public var interval: RecurrenceInterval = .monthly
    public var anchorDay = 1
    public var startDate: String
    public var endDate: String?
    public var paymentTermDays = 14
    public var autoSend = false
    public var lines: [InvoiceDraft.Line]

    public init(today: String) {
        startDate = today
        lines = [InvoiceDraft.Line()]
    }

    public init(_ r: RecurringInvoice) {
        customerId = r.customer.id
        name = r.name ?? ""
        interval = r.interval
        anchorDay = r.anchorDay
        startDate = String(r.startDate.prefix(10))
        endDate = r.endDate.map { String($0.prefix(10)) }
        paymentTermDays = r.paymentTermDays
        autoSend = r.autoSend
        lines = r.lines.map {
            InvoiceDraft.Line(description: $0.description, quantity: $0.quantity, unit: $0.unit, unitPrice: $0.unitPrice, vatRate: $0.vatRate)
        }
    }

    enum CodingKeys: String, CodingKey {
        case customerId, name, interval, anchorDay, startDate, endDate, paymentTermDays, autoSend, lines
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(customerId, forKey: .customerId)
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { try c.encodeNil(forKey: .name) } else { try c.encode(trimmed, forKey: .name) }
        try c.encode(interval, forKey: .interval)
        try c.encode(anchorDay, forKey: .anchorDay)
        try c.encode(startDate, forKey: .startDate)
        if let endDate, !endDate.isEmpty { try c.encode(endDate, forKey: .endDate) } else { try c.encodeNil(forKey: .endDate) }
        try c.encode(paymentTermDays, forKey: .paymentTermDays)
        try c.encode(autoSend, forKey: .autoSend)
        let trimmedLines = lines.map { line -> InvoiceDraft.Line in
            var copy = line
            copy.description = line.description.trimmingCharacters(in: .whitespacesAndNewlines)
            let unit = line.unit.trimmingCharacters(in: .whitespacesAndNewlines)
            copy.unit = unit.isEmpty ? "kpl" : unit
            return copy
        }
        try c.encode(trimmedLines, forKey: .lines)
    }

    /// The first problem, in the web form's field order, or nil when it can be saved.
    public var validationError: String? {
        if customerId.isEmpty { return "Valitse asiakas." }
        if !(1...31).contains(anchorDay) { return "Laskutuspäivä on 1-31." }
        if APIDate.day(startDate) == nil { return "Valitse alkupäivä." }
        if let endDate, !endDate.isEmpty, endDate < startDate { return "Päättymispäivä ei voi olla ennen alkupäivää." }
        if !(0...365).contains(paymentTermDays) { return "Maksuaika on 0-365 päivää." }
        if lines.isEmpty { return "Lisää vähintään yksi rivi." }
        for line in lines {
            if line.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Kuvaus puuttuu." }
            if line.quantity == 0 { return "Määrä puuttuu." }
            if line.quantity < 0 { return "Määrä ei voi olla negatiivinen." }
            if line.unitPrice < 0 { return "Hinta ei voi olla negatiivinen." }
        }
        return nil
    }
}

// MARK: - Run now

private enum RecurringText {
    static let lockFix = "Avaa kausi kohdassa Kirjanpito > Suljetut kaudet."

    static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// "heinäkuu 2026, elokuu 2026": the distinct months of some dates, in order.
    static func months(_ dates: [String]) -> String {
        Array(Set(dates.map { String($0.prefix(7)) })).sorted().map { key in
            "\(MonthKey.name(key).lowercased()) \(key.prefix(4))"
        }.joined(separator: ", ")
    }

    static func monthCount(_ dates: [String]) -> Int { Set(dates.map { String($0.prefix(7)) }).count }
}

/// `GET /api/recurring-invoices/run`: what a run would make now, for the confirmation.
public struct RecurringRunPlan: Decodable, Sendable {
    public struct Entry: Decodable, Sendable, Hashable {
        public let recurringInvoiceId: String
        public let name: String
        public let customerName: String
        public let customerEmail: String?
        public let autoSend: Bool
        public let grossByDate: [Decimal]
        public let issueDates: [String]
        public let lockedDates: [String]

        enum CodingKeys: String, CodingKey {
            case recurringInvoiceId, name, customerName, customerEmail, autoSend, grossByDate, issueDates, lockedDates
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            recurringInvoiceId = try c.decode(String.self, forKey: .recurringInvoiceId)
            name = try c.decode(String.self, forKey: .name)
            customerName = try c.decodeIfPresent(String.self, forKey: .customerName) ?? name
            customerEmail = try c.decodeIfPresent(String.self, forKey: .customerEmail)
            autoSend = try c.decodeIfPresent(Bool.self, forKey: .autoSend) ?? false
            let gross = try c.decodeIfPresent([Double].self, forKey: .grossByDate) ?? []
            grossByDate = gross.map { Decimal(string: String(describing: $0), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal($0) }
            issueDates = try c.decodeIfPresent([String].self, forKey: .issueDates) ?? []
            lockedDates = try c.decodeIfPresent([String].self, forKey: .lockedDates) ?? []
        }

        /// "3 × 100,00 € + 1 × 99,00 €": equal amounts grouped.
        var amountsText: String {
            var groups: [(gross: Decimal, count: Int)] = []
            for gross in grossByDate {
                if let last = groups.last, last.gross == gross { groups[groups.count - 1].count += 1 }
                else { groups.append((gross, 1)) }
            }
            let single = groups.count == 1 && groups[0].count == 1
            return groups.map { single ? Money.format($0.gross) : "\($0.count) × \(Money.format($0.gross))" }.joined(separator: " + ")
        }
    }

    public let plan: [Entry]

    /// How many invoices the run makes: every due date counts, not every schedule.
    public var invoiceCount: Int { plan.reduce(0) { $0 + $1.issueDates.count } }

    private var lockedDates: [String] { plan.flatMap(\.lockedDates) }

    public var summary: String {
        let sends = plan.filter { $0.autoSend && $0.customerEmail != nil }.reduce(0) { $0 + $1.issueDates.count }
        let drafts = invoiceCount - sends
        let parts = plan.filter { !$0.issueDates.isEmpty }.map { "\($0.name) \($0.amountsText)" }
        let locked = lockedDates
        var sentences: [String] = []
        if !parts.isEmpty { sentences.append("\(parts.joined(separator: ", ")).") }
        if sends > 0 { sentences.append("\(sends) lähetetään sähköpostilla.") }
        if drafts > 0 { sentences.append("\(drafts) jää luonnokseksi.") }
        if sends > 0 { sentences.append("Lähetettyä laskua ei voi perua, vain hyvittää.") }
        if !locked.isEmpty {
            let one = RecurringText.monthCount(locked) == 1
            sentences.append("\(RecurringText.capitalized(RecurringText.months(locked))) \(one ? "on suljettu kausi" : "ovat suljettuja kausia"), joten \(locked.count == 1 ? "sen lasku" : "niiden laskut") jää odottamaan. \(RecurringText.lockFix)")
        }
        return sentences.joined(separator: " ")
    }

    /// When every due date is in a closed month there is nothing to confirm: why.
    public var lockedOnlyMessage: String {
        let locked = lockedDates
        let one = RecurringText.monthCount(locked) == 1
        return "\(RecurringText.capitalized(RecurringText.months(locked))) \(one ? "on suljettu kausi" : "ovat suljettuja kausia"), joten laskuja ei voi luoda. \(RecurringText.lockFix)"
    }

    public var confirmTitle: String { invoiceCount == 1 ? "Luodaanko 1 lasku?" : "Luodaanko \(invoiceCount) laskua?" }
    public var confirmLabel: String { invoiceCount == 1 ? "Luo lasku" : "Luo \(invoiceCount) laskua" }
}

/// `POST /api/recurring-invoices/run`.
public struct RecurringRunResult: Decodable, Sendable {
    public struct Generated: Decodable, Sendable {
        public let invoiceId: String?
        public let invoiceNumber: Int?
        public let sent: Bool
        public let sendError: String?
    }
    public struct Skipped: Decodable, Sendable {
        public let issueDate: String
        public let reason: String
    }
    public struct Retry: Decodable, Sendable { public let sent: Bool }

    public let generated: [Generated]
    public let skipped: [Skipped]
    public let sendRetries: [Retry]?

    /// What the run did, in words; `isProblem` when something was left undone.
    public var summary: (text: String, isProblem: Bool) {
        let made = generated.count
        let lockedDates = skipped.filter { $0.reason == "period_locked" }.map(\.issueDate)
        let failedCreate = skipped.filter { $0.reason == "failed" }.count
        let already = skipped.filter { $0.reason == "already_generated" }.count
        let failedSends = generated.filter { $0.sendError != nil }.count
        let resent = sendRetries?.filter(\.sent).count ?? 0

        var pieces: [String] = []
        if made == 1 { pieces.append("1 lasku luotiin.") }
        else if made > 1 { pieces.append("\(made) laskua luotiin.") }
        else if lockedDates.isEmpty && failedCreate == 0 && resent == 0 { pieces.append("Yhtään laskua ei luotu.") }
        if resent > 0 {
            pieces.append(resent == 1 ? "1 aiemmin lähettämättä jäänyt lasku lähetettiin." : "\(resent) aiemmin lähettämättä jäänyttä laskua lähetettiin.")
        }
        if !lockedDates.isEmpty {
            let months = RecurringText.monthCount(lockedDates)
            pieces.append("\(RecurringText.capitalized(RecurringText.months(lockedDates))) \(months == 1 ? "jäi" : "jäivät") luomatta, koska kausi on suljettu. \(RecurringText.lockFix) Kun kausi on auki, \(lockedDates.count == 1 ? "lasku luodaan" : "laskut luodaan") seuraavalla kerralla.")
        }
        if failedCreate > 0 {
            pieces.append(failedCreate == 1 ? "Yhden laskun luonti epäonnistui." : "\(failedCreate) laskun luonti epäonnistui.")
        }
        if already > 0 { pieces.append(already == 1 ? "1 oli jo luotu." : "\(already) oli jo luotu.") }
        if failedSends > 0 {
            pieces.append(failedSends == 1
                ? "1 lähetys epäonnistui, lasku on tallessa luonnoksena. Voit lähettää sen laskun sivulta."
                : "\(failedSends) lähetystä epäonnistui, laskut ovat tallessa luonnoksina. Voit lähettää ne laskun sivulta.")
        }
        return (pieces.joined(separator: " "), failedSends > 0 || failedCreate > 0)
    }
}
