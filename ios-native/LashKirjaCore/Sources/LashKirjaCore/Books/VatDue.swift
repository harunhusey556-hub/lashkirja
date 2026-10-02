import Foundation

/// The unit of an ALV return: the profile's ALV-verokausi, or the unit of a period key.
public enum VatKind: String, CaseIterable, Identifiable, Sendable {
    case month, quarter, year

    public var id: String { rawValue }

    /// The ALV page's chips (web `KIND_CHIPS`).
    public var title: String {
        switch self {
        case .month: "Kuukausi"
        case .quarter: "Neljännes"
        case .year: "Vuosi"
        }
    }

    /// Any stored profile value; unknown strings are monthly, like the rest of the app.
    public init(profile: String?) {
        self = profile == "quarter" ? .quarter : profile == "year" ? .year : .month
    }

    /// "2026-08" / "2026-Q3" / "2026".
    public init(key: String) {
        self = key.contains("-Q") ? .quarter : key.count == 4 ? .year : .month
    }
}

/// The statutory due date of a kausiveroilmoitus and the ALV page's period choice
/// (web `lib/vat-deadline.ts`, `lib/alv-period-choice.ts`). Days are "YYYY-MM-DD" calendar
/// dates with no time zone: a due date has no time of day.
public enum VatDue {
    /// A calendar day as a count of days, for weekday and day arithmetic without a Calendar.
    struct Day: Comparable {
        let year: Int, month: Int, day: Int

        /// Days since 1970-01-01 (Hinnant's days_from_civil).
        var ordinal: Int {
            let y = month <= 2 ? year - 1 : year
            let era = (y >= 0 ? y : y - 399) / 400
            let yoe = y - era * 400
            let mp = (month + 9) % 12
            let doy = (153 * mp + 2) / 5 + day - 1
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
            return era * 146_097 + doe - 719_468
        }

        init(_ year: Int, _ month: Int, _ day: Int) { self.year = year; self.month = month; self.day = day }

        init(ordinal z0: Int) {
            let z = z0 + 719_468
            let era = (z >= 0 ? z : z - 146_096) / 146_097
            let doe = z - era * 146_097
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
            let mp = (5 * doy + 2) / 153
            let d = doy - (153 * mp + 2) / 5 + 1
            let m = mp < 10 ? mp + 3 : mp - 9
            self.init(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d)
        }

        init?(iso: String) {
            let bits = iso.prefix(10).split(separator: "-")
            guard bits.count == 3, let y = Int(bits[0]), let m = Int(bits[1]), let d = Int(bits[2]),
                  (1...12).contains(m), (1...31).contains(d) else { return nil }
            self.init(y, m, d)
        }

        func adding(_ days: Int) -> Day { Day(ordinal: ordinal + days) }
        /// 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday).
        var weekday: Int { ((ordinal % 7) + 11) % 7 }
        var iso: String { String(format: "%04d-%02d-%02d", year, month, day) }

        static func < (a: Day, b: Day) -> Bool { a.ordinal < b.ordinal }
    }

    /// One parsed period key.
    struct Period {
        let kind: VatKind
        let year: Int
        /// The month, or the quarter, or 0 for a year.
        let index: Int

        init?(_ key: String) {
            guard key.count >= 4, let year = Int(key.prefix(4)) else { return nil }
            self.year = year
            switch VatKind(key: key) {
            case .year:
                guard key.count == 4 else { return nil }
                kind = .year; index = 0
            case .quarter:
                guard key.count == 7, let q = Int(key.suffix(1)), (1...4).contains(q) else { return nil }
                kind = .quarter; index = q
            case .month:
                guard key.count == 7, let m = Int(key.suffix(2)), (1...12).contains(m) else { return nil }
                kind = .month; index = m
            }
        }

        init(kind: VatKind, year: Int, index: Int) { self.kind = kind; self.year = year; self.index = index }

        var key: String {
            switch kind {
            case .month: String(format: "%04d-%02d", year, index)
            case .quarter: "\(year)-Q\(index)"
            case .year: String(year)
            }
        }

        var next: Period {
            switch kind {
            case .month: index == 12 ? Period(kind: .month, year: year + 1, index: 1) : Period(kind: .month, year: year, index: index + 1)
            case .quarter: index == 4 ? Period(kind: .quarter, year: year + 1, index: 1) : Period(kind: .quarter, year: year, index: index + 1)
            case .year: Period(kind: .year, year: year + 1, index: 0)
            }
        }

        /// The first day after the period (its end is exclusive, as `alvPeriodBoundsUtc`).
        var end: Day {
            switch kind {
            case .month: index == 12 ? Day(year + 1, 1, 1) : Day(year, index + 1, 1)
            case .quarter: index == 4 ? Day(year + 1, 1, 1) : Day(year, index * 3 + 1, 1)
            case .year: Day(year + 1, 1, 1)
            }
        }

        var deadline: Day {
            switch kind {
            case .month: return VatDue.nextBusinessDay(twelfth(afterMonth: index))
            case .quarter: return VatDue.nextBusinessDay(twelfth(afterMonth: index * 3))
            case .year: return VatDue.nextBusinessDay(Day(year + 1, 2, 28))
            }
        }

        /// The 12th of the second month after `month` of the period's year.
        private func twelfth(afterMonth month: Int) -> Day {
            let total = month - 1 + 2
            return Day(year + total / 12, total % 12 + 1, 12)
        }
    }

    // MARK: Holidays

    static func easter(_ year: Int) -> Day {
        let a = year % 19, b = year / 100, c = year % 100
        let d = b / 4, e = b % 4, f = (b + 8) / 25, g = (b - f + 1) / 3
        let h = (19 * a + b - d - g + 15) % 30
        let i = c / 4, k = c % 4
        let l = (32 + 2 * e + 2 * i - h - k) % 7
        let m = (a + 11 * h + 22 * l) / 451
        let value = h + l - 7 * m + 114
        return Day(year, value / 31, value % 31 + 1)
    }

    /// Easter Sunday (Anonymous Gregorian algorithm), "YYYY-MM-DD".
    public static func easterSunday(_ year: Int) -> String { easter(year).iso }

    static func holidayDays(_ year: Int) -> [Day] {
        let easter = easter(year)
        let midsummerEve = (19...25).map { Day(year, 6, $0) }.first { $0.weekday == 5 }
        return [Day(year, 1, 1), Day(year, 1, 6), easter.adding(-2), easter.adding(1), Day(year, 5, 1),
                easter.adding(39)] + (midsummerEve.map { [$0] } ?? [])
            + [Day(year, 12, 6), Day(year, 12, 24), Day(year, 12, 25), Day(year, 12, 26)]
    }

    /// Every Finnish public holiday a deadline moves off, "YYYY-MM-DD".
    public static func holidays(_ year: Int) -> [String] { holidayDays(year).map(\.iso) }

    static func nextBusinessDay(_ day: Day) -> Day {
        var candidate = day
        while candidate.weekday == 0 || candidate.weekday == 6 || holidayDays(candidate.year).contains(candidate) {
            candidate = candidate.adding(1)
        }
        return candidate
    }

    // MARK: Deadlines

    /// The due date of the return for `key` ("2026-08", "2026-Q3", "2026"), already moved off a
    /// weekend or holiday; nil for a key that is not a period.
    public static func deadline(_ key: String) -> String? { Period(key)?.deadline.iso }

    /// The return actually due as of `today`: the earliest period whose due date is today or later
    /// (in early October a monthly filer sees August, due 12.10.).
    public static func nextDueKey(today: String, kind: VatKind) -> String {
        guard let asOf = Day(iso: today) else { return "" }
        let back = kind == .year ? 3 : kind == .quarter ? 2 : 1
        var period = Period(kind: kind, year: asOf.year - back, index: kind == .year ? 0 : 1)
        while period.deadline < asOf { period = period.next }
        return period.key
    }

    /// Filing is possible once the period is over (the server refuses earlier: PERIOD_NOT_ENDED).
    public static func periodEnded(_ key: String, today: String) -> Bool {
        guard let period = Period(key), let asOf = Day(iso: today) else { return false }
        return period.end <= asOf
    }

    /// "Elokuu 2026", "Q3/2026", "2026": the period as OmaVero names it in the steps.
    public static func label(_ key: String) -> String {
        guard let period = Period(key) else { return key }
        switch period.kind {
        case .month: return "\(MonthKey.names[period.index - 1]) \(period.year)"
        case .quarter: return "Q\(period.index)/\(period.year)"
        case .year: return String(period.year)
        }
    }

    /// "12.10.", or "1.3.2027" when the deadline falls in a later year than the period.
    public static func dueDateText(_ dueIso: String, periodYear: Int) -> String {
        guard let day = Day(iso: dueIso) else { return dueIso }
        let short = "\(day.day).\(day.month)."
        return day.year == periodYear ? short : "\(short)\(day.year)"
    }

    // MARK: Period choice

    public struct Option: Hashable, Sendable {
        public let key: String
        public let label: String
    }

    /// The picker's label for a period: "Elokuu 2026", "Q3 / 2026", "2026".
    public static func optionLabel(_ key: String) -> String {
        guard let period = Period(key), period.kind == .quarter else { return label(key) }
        return "Q\(period.index) / \(period.year)"
    }

    /// The periods of one unit the picker offers: last year and this year (December is filed in
    /// February), plus the shown one so the picker never goes blank.
    public static func periodOptions(kind: VatKind, nowYear: Int, selected: String) -> [Option] {
        var keys: [String] = []
        for year in [nowYear - 1, nowYear] {
            switch kind {
            case .month: keys += (1...12).map { String(format: "%04d-%02d", year, $0) }
            case .quarter: keys += (1...4).map { "\(year)-Q\($0)" }
            case .year: keys.append(String(year))
            }
        }
        if Period(selected) != nil, VatKind(key: selected) == kind, !keys.contains(selected) {
            keys.append(selected)
            keys.sort()
        }
        return keys.map { Option(key: $0, label: optionLabel($0)) }
    }
}

/// "Ilmoita ja maksa" and the ALV page's notes (web `lib/vat-due.ts`, `components/VatFilingCard.tsx`).
public enum VatFiling {
    public static func stateLabel(_ state: PeriodClose.VatState, nothingToPay: Bool) -> String {
        switch state {
        case .paid: "Maksettu"
        case .filed: nothingToPay ? "Ilmoitettu" : "Ilmoitettu, maksamatta"
        case .open: "Ilmoittamatta"
        }
    }

    /// A filed return owes what was filed (that is what OmaVero asks for until it is corrected).
    public static func amountToPay(amount: Decimal, filedAt: String?, filedAmount: Decimal?) -> Decimal {
        guard filedAt != nil, let filedAmount else { return amount }
        return max(filedAmount, 0)
    }

    /// A sentence ending in a date like "12.10." already carries its full stop.
    private static func endSentence(_ text: String) -> String { text.hasSuffix(".") ? text : text + "." }

    public static func fileStepText(dueIso: String, periodYear: Int) -> String {
        endSentence("Kirjoita kentät tältä sivulta ja lähetä ilmoitus viimeistään \(VatDue.dueDateText(dueIso, periodYear: periodYear))")
    }

    /// Nil when there is nothing to pay.
    public static func payStepText(amount: Decimal, dueIso: String, periodYear: Int) -> String? {
        guard amount > 0 else { return nil }
        return endSentence("Maksa \(Money.format(amount)) viimeistään \(VatDue.dueDateText(dueIso, periodYear: periodYear))")
    }

    public static func filedNote(filedOn: String, amount: Decimal, dueIso: String, nothingToPay: Bool, periodYear: Int) -> String {
        let filed = filedOn.isEmpty ? "Ilmoitettu." : "Ilmoitettu \(filedOn)."
        guard !nothingToPay, let pay = payStepText(amount: amount, dueIso: dueIso, periodYear: periodYear) else { return filed }
        return "\(filed) \(pay)"
    }

    /// Which mark the undo button clears: the payment first, then the filing (which clears both).
    public static func undo(state: PeriodClose.VatState, nothingToPay: Bool) -> PeriodClose.VatState {
        state == .paid && !nothingToPay ? .paid : .filed
    }

    public static func undoTitle(state: PeriodClose.VatState, nothingToPay: Bool) -> String {
        undo(state: state, nothingToPay: nothingToPay) == .paid ? "Peru maksettu-merkintä" : "Peru ilmoitettu-merkintä"
    }

    public static let notEndedNote = "Kausi on vielä kesken. Ilmoita, kun kausi on päättynyt."

    /// TF-11: pending receipts dated in the period are not in the figures yet.
    public static func pendingNote(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1
            ? "1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä."
            : "\(count) kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä."
    }

    private static func receipts(_ count: Int) -> String { "\(count) \(count == 1 ? "kuitti" : "kuittia")" }

    /// "Myynnin ALV kahdesta lähteestä": receipts and invoices, and what was left out.
    public static func salesSourcesNote(receiptSalesVat: Decimal, invoiceSalesVat: Decimal, excludedReceipts: Int, creditNotes: Int) -> String {
        var parts = ["Kuiteista \(Money.format(receiptSalesVat)) · myyntilaskuista \(Money.format(invoiceSalesVat)). Laskut lasketaan laskun päivän mukaan (suoriteperuste)."]
        if excludedReceipts > 0 {
            parts.append("\(receipts(excludedReceipts)) jätettiin pois, koska sama pankkitapahtuma on jo kohdistettu laskulle.")
        }
        if creditNotes > 0 {
            parts.append(creditNotes == 1 ? "1 hyvityslasku vähentää myyntiä tällä kaudella." : "\(creditNotes) hyvityslaskua vähentävät myyntiä tällä kaudella.")
        }
        return parts.joined(separator: " ")
    }

    /// F39: purchase invoices in the return, and what was left out or may count twice.
    public static func purchaseNote(count: Int, vat: Decimal, skipped: Int, suspected: Int, unusable: Int) -> String {
        var parts: [String] = []
        if count > 0 {
            parts.append("\(count) ostolaskun ALV \(Money.format(vat)) on mukana vähennettävässä verossa laskun päivän mukaan.")
        }
        if skipped > 0 {
            parts.append(skipped == 1
                ? "1 ostolasku jätettiin pois, koska sama osto on jo mukana kuittina."
                : "\(skipped) ostolaskua jätettiin pois, koska samat ostot ovat jo mukana kuitteina.")
        }
        if suspected > 0 {
            parts.append(suspected == 1
                ? "1 ostolaskulle löytyy samansuuruinen kuitti. Jos se on sama osto, liitä kuitti laskuun, niin ALV ei lasketa kahdesti."
                : "\(suspected) ostolaskulle löytyy samansuuruinen kuitti. Jos ne ovat samoja ostoja, liitä kuitit laskuihin, niin ALV ei lasketa kahdesti.")
        }
        if unusable > 0 {
            parts.append(unusable == 1
                ? "1 ostolaskuun liitetyssä kuitissa ei ole päivää tai ALV-erittelyä, joten laskun ALV on mukana. Täydennä kuitti, niin lasku jää pois."
                : "\(unusable) ostolaskuun liitetyissä kuiteissa ei ole päivää tai ALV-erittelyä, joten laskujen ALV on mukana. Täydennä kuitit, niin laskut jäävät pois.")
        }
        return parts.joined(separator: " ")
    }

    public static func reviewTitle(_ count: Int) -> String { "\(receipts(count)) ilman ALV-erittelyä" }

    public static func reviewText(salesGross: Decimal, purchasesGross: Decimal) -> String {
        "Myynnit \(Money.format(salesGross)) · Ostot \(Money.format(purchasesGross)). Lisää ALV-tiedot kuiteille, jotta ne lasketaan mukaan."
    }

    public static let notRegisteredNote = "Et ole merkinnyt olevasi ALV-rekisterissä. Tämä raportti on vain arvio - ALV-ilmoitusta ei tarvitse antaa, jos et ole ALV-rekisterissä."
}

extension ReportDrill {
    /// A Raportit data-quality row (web "Ilman ALV-erittelyä" / "Ilman päivää").
    public struct QualityRow: Equatable, Hashable, Sendable {
        public let title: String
        public let count: Int
        public let drill: ReportDrill
        public init(title: String, count: Int, drill: ReportDrill) { self.title = title; self.count = count; self.drill = drill }
    }

    /// The receipts list has no "no VAT" or "no date" filter: the VAT gaps open the year's
    /// receipts, and undated ones (which belong to no year) the whole list.
    public static func dataQuality(missingVat: Int?, undated: Int?, year: String) -> [QualityRow] {
        var rows: [QualityRow] = []
        if let missingVat, missingVat > 0 {
            rows.append(QualityRow(title: "Ilman ALV-erittelyä", count: missingVat, drill: .receipts(period: year, tab: "", category: "")))
        }
        if let undated, undated > 0 {
            rows.append(QualityRow(title: "Ilman päivää", count: undated, drill: .receipts(period: "", tab: "", category: "")))
        }
        return rows
    }
}
