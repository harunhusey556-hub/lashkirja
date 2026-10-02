import Foundation

/// The receipt categories of the web app (`lib/receipt-categories.ts`), in the same order.
public struct ReceiptCategory: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String

    public static let all: [ReceiptCategory] = [
        .init(id: "myynti", label: "Myynti"),
        .init(id: "tarvikkeet", label: "Tarvikkeet & ostot"),
        .init(id: "vuokra", label: "Vuokra & toimitilat"),
        .init(id: "sähkö", label: "Sähkö"),
        .init(id: "vesi", label: "Vesi & jätevesi"),
        .init(id: "puhelin/netti", label: "Puhelin & data"),
        .init(id: "ohjelmistot", label: "ATK & ohjelmistot"),
        .init(id: "polttoaine", label: "Polttoaine"),
        .init(id: "rahti", label: "Rahti & kuljetus"),
        .init(id: "matkakulut", label: "Matkakulut"),
        .init(id: "markkinointi", label: "Markkinointi"),
        .init(id: "koulutus", label: "Koulutus"),
        .init(id: "vakuutus", label: "Vakuutukset"),
        .init(id: "työeläke", label: "TyEL / työeläke"),
        .init(id: "työllisyysrahasto", label: "Työllisyysrahasto"),
        .init(id: "pankki", label: "Pankki- & palvelumaksut"),
        .init(id: "verot", label: "Verot & ennakkomaksut"),
        .init(id: "kuntavero", label: "Kunnallisvero"),
        .init(id: "rahoitus", label: "Rahoitus & lainat"),
        .init(id: "palkka", label: "Palkat"),
        .init(id: "muut", label: "Muut"),
    ]

    public static func isKnown(_ id: String?) -> Bool {
        guard let id else { return false }
        return all.contains { $0.id == id }
    }

    /// The Finnish label of a known category; a custom one shows as typed.
    public static func label(for id: String) -> String {
        all.first { $0.id == id }?.label ?? id
    }
}

/// Amounts as the receipt form reads and shows them (`lib/receipt-vat.ts`).
public enum ReceiptAmount {
    /// "24,90", "1 234,50 €", and both "1.234,50" and "1,234.50" (the last separator is the decimal mark).
    public static func parse(_ text: String) -> Decimal? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for junk in ["€", " ", "\u{00A0}", "\u{2009}", "\u{202F}"] { t = t.replacingOccurrences(of: junk, with: "") }
        if let comma = t.lastIndex(of: ","), let dot = t.lastIndex(of: ".") {
            t = comma > dot ? t.replacingOccurrences(of: ".", with: "") : t.replacingOccurrences(of: ",", with: "")
        }
        return Money.parse(t)
    }

    /// A stored amount as field text: "1234,50", "0,20".
    public static func field(_ value: Decimal) -> String {
        let r = rounded(value, 2)
        let negative = r < 0
        let text = NSDecimalNumber(decimal: negative ? -r : r).stringValue
        let parts = text.split(separator: ".", maxSplits: 1)
        var cents = parts.count > 1 ? String(parts[1]) : "00"
        while cents.count < 2 { cents += "0" }
        return "\(negative ? "-" : "")\(parts[0]),\(cents)"
    }

    static func rounded(_ value: Decimal, _ scale: Int) -> Decimal {
        var v = value
        var r = Decimal()
        NSDecimalRound(&r, &v, scale, .plain)
        return r
    }

    static func cents(_ value: Decimal) -> Decimal { rounded(value * 100, 0) }
}

/// VAT rules of the receipt form, as the server checks them (`lib/receipt-vat.ts`).
public enum ReceiptVat {
    /// Rates the VAT return knows (current and legacy) plus the explicit 0 %.
    public static let supportedRates: [Decimal] = [0, 10, Decimal(string: "13.5")!, 14, 24, Decimal(string: "25.5")!]

    public static func isSupported(_ rate: Decimal) -> Bool { supportedRates.contains(rate) }

    /// The general rate on the receipt date: 24 % before 1.9.2024, then 25,5 %.
    public static func defaultRate(forDate date: String) -> Decimal {
        !date.isEmpty && date < "2024-09-01" ? 24 : Decimal(string: "25.5")!
    }

    /// The rates the form offers for a date (general, reduced, 10 %, 0 %), plus a stored off-list one.
    public static func rateChoices(forDate date: String, including current: Decimal? = nil) -> [Decimal] {
        let reduced: Decimal = !date.isEmpty && date < "2026-01-01" ? 14 : Decimal(string: "13.5")!
        var choices = [defaultRate(forDate: date), reduced, 10, 0]
        if let current, !choices.contains(current) { choices.append(current) }
        return choices
    }

    /// The VAT inside a gross amount, in whole cents.
    public static func vatInGross(_ gross: Decimal, rate: Decimal) -> Decimal {
        ReceiptAmount.rounded(ReceiptAmount.cents(gross) * rate / (100 + rate), 0) / 100
    }

    /// "25,5 %"
    public static func rateLabel(_ rate: Decimal) -> String {
        "\(NSDecimalNumber(decimal: rate).stringValue.replacingOccurrences(of: ".", with: ",")) %"
    }

    public static let missingMessage = "Anna ALV-summa tai poista rivi."
    public static let invalidMessage = "ALV-summa ei ole kelvollinen."
    public static let tooLargeMessage = "ALV-summa ei voi olla suurempi kuin kuitin summa."
    public static func unsupportedMessage(_ rate: Decimal) -> String {
        "ALV-kanta \(rateLabel(rate)) ei ole tuettu. Valitse 25,5, 13,5, 10 tai 0 %."
    }
}

/// One VAT row of the form. `auto` means the amount follows the total and the rate.
/// `defaulted` means the rate is only the default of the receipt date: nobody
/// chose it, so it moves with the date (web `VatRow.defaulted`).
public struct ReceiptVatRow: Sendable, Equatable, Identifiable {
    public let id: UUID
    public var rate: Decimal
    public var amountText: String
    public var auto: Bool
    public var defaulted: Bool

    public init(rate: Decimal, amountText: String, auto: Bool, defaulted: Bool = false) {
        id = UUID()
        self.rate = rate
        self.amountText = amountText
        self.auto = auto
        self.defaulted = defaulted
    }
}

/// What "Tallenna kuitti" of a new receipt sends, or why it cannot.
public enum ReceiptDraftOutcome: Sendable, Equatable {
    /// Field key ("vendor", "totalAmount", "vat-0", …) to its Finnish message.
    case invalid([String: String])
    case draft(ReceiptDraft)
}

/// `PATCH /api/receipts/[id]`: only the changed fields, plus the version that was edited.
public struct ReceiptPatch: Encodable, Sendable, Equatable {
    public enum Value: Sendable, Equatable {
        case text(String?)
        case amount(Decimal)
        case vat([VatDetail])
    }
    public struct Field: Sendable, Equatable { public let key: String; public let value: Value }

    public private(set) var fields: [Field] = []
    public let expectedUpdatedAt: String?

    public init(expectedUpdatedAt: String?) { self.expectedUpdatedAt = expectedUpdatedAt }

    public var isEmpty: Bool { fields.isEmpty }
    public func changes(_ key: String) -> Bool { fields.contains { $0.key == key } }

    mutating func set(_ key: String, _ value: Value) { fields.append(Field(key: key, value: value)) }

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        for field in fields {
            switch field.value {
            case .text(let text):
                if let text { try c.encode(text, forKey: Key(field.key)) } else { try c.encodeNil(forKey: Key(field.key)) }
            case .amount(let amount): try c.encode(amount, forKey: Key(field.key))
            case .vat(let lines): try c.encode(lines, forKey: Key(field.key))
            }
        }
        if let expectedUpdatedAt { try c.encode(expectedUpdatedAt, forKey: Key("expectedUpdatedAt")) }
    }
}

public enum ReceiptPatchOutcome: Sendable, Equatable {
    case unchanged
    /// Field key ("vendor", "totalAmount", "vat-0", …) to its Finnish message.
    case invalid([String: String])
    case patch(ReceiptPatch)
}

/// The edit form of a saved receipt: what the screen shows, as text.
public struct ReceiptForm: Sendable, Equatable {
    public var vendor: String
    /// "YYYY-MM-DD", or empty.
    public var date: String
    public var totalText: String
    public var category: String
    public var type: String
    public var notes: String
    public var reference: String
    public var invoiceNumber: String
    public private(set) var vatRows: [ReceiptVatRow]

    public static let limits = (vendor: 300, reference: 40, invoiceNumber: 40, notes: 500)

    public init(receipt r: Receipt) {
        vendor = r.vendor ?? ""
        date = r.date.map { String($0.prefix(10)) } ?? ""
        totalText = r.totalAmount.map(ReceiptAmount.field) ?? ""
        category = r.category ?? ""
        type = r.isIncome ? "tulo" : "meno"
        notes = r.notes ?? ""
        reference = r.reference ?? ""
        invoiceNumber = r.invoiceNumber ?? ""
        // No saved VAT gives no rows: opening a receipt never invents VAT.
        var rows = (r.vatDetails ?? []).map { ReceiptVatRow(rate: $0.rate, amountText: ReceiptAmount.field($0.amount), auto: false) }
        if rows.count == 1, let total = r.totalAmount,
           ReceiptAmount.parse(rows[0].amountText) == ReceiptVat.vatInGross(total, rate: rows[0].rate) {
            rows[0].auto = true
        }
        vatRows = rows
    }

    /// A NEW receipt as the document analysis read it (web `newReceiptVatRows`):
    /// the VAT that was read, else one row at the general rate of the date that
    /// follows the total and the date.
    public init(draft d: ReceiptDraft) {
        vendor = d.vendor
        date = d.date
        totalText = d.totalAmount.map(ReceiptAmount.field) ?? ""
        category = d.category
        type = d.type == "tulo" ? "tulo" : "meno"
        notes = d.notes
        reference = d.reference
        invoiceNumber = d.invoiceNumber
        var rows = d.vatDetails.map { ReceiptVatRow(rate: $0.rate, amountText: ReceiptAmount.field($0.amount), auto: false) }
        if rows.count == 1, let total = d.totalAmount,
           ReceiptAmount.parse(rows[0].amountText) == ReceiptVat.vatInGross(total, rate: rows[0].rate) {
            rows[0].auto = true
        }
        vatRows = rows
        if rows.isEmpty {
            let rate = ReceiptVat.defaultRate(forDate: d.date)
            vatRows = [ReceiptVatRow(rate: rate, amountText: autoAmount(rate), auto: true, defaulted: true)]
        }
    }

    public var isKnownCategory: Bool { ReceiptCategory.isKnown(category) }

    // MARK: VAT rows

    private func autoAmount(_ rate: Decimal) -> String {
        guard let total = ReceiptAmount.parse(totalText), total >= 0 else { return "" }
        return ReceiptAmount.field(ReceiptVat.vatInGross(total, rate: rate))
    }

    /// The total changed: a single row that was not typed by hand follows it.
    public mutating func setTotal(_ text: String) {
        totalText = text
        if vatRows.count == 1, vatRows[0].auto { vatRows[0].amountText = autoAmount(vatRows[0].rate) }
    }

    /// The user typed a VAT amount: the row stops following the total. Emptied, it follows again.
    public mutating func setVatAmount(_ text: String, at index: Int) {
        guard vatRows.indices.contains(index) else { return }
        vatRows[index].amountText = text
        vatRows[index].auto = text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// A rate picked by hand is no longer the default of the date. Picking the
    /// rate of a single row asks for the VAT of the total (web editor, F03).
    public mutating func setRate(_ rate: Decimal, at index: Int) {
        guard vatRows.indices.contains(index) else { return }
        vatRows[index].rate = rate
        vatRows[index].defaulted = false
        if vatRows.count == 1, let total = ReceiptAmount.parse(totalText), total >= 0 {
            vatRows[index].amountText = autoAmount(rate)
            vatRows[index].auto = true
        } else if vatRows[index].auto {
            vatRows[index].amountText = autoAmount(rate)
        }
    }

    /// The date changed: a single row whose rate nobody chose follows it (web `followDateRate`).
    public mutating func setDate(_ text: String) {
        date = text
        guard vatRows.count == 1, vatRows[0].defaulted, vatRows[0].auto else { return }
        let rate = ReceiptVat.defaultRate(forDate: text)
        guard rate != vatRows[0].rate else { return }
        vatRows[0].rate = rate
        vatRows[0].amountText = autoAmount(rate)
    }

    /// "Lisää ALV-rivi": the first row computes from the total, a further row starts blank.
    public mutating func addVatRow() {
        let rate = ReceiptVat.defaultRate(forDate: date)
        if vatRows.isEmpty {
            vatRows = [ReceiptVatRow(rate: rate, amountText: autoAmount(rate), auto: true)]
            return
        }
        for i in vatRows.indices { vatRows[i].auto = false }
        vatRows.append(ReceiptVatRow(rate: rate, amountText: "", auto: false))
    }

    public mutating func removeVatRow(at index: Int) {
        guard vatRows.indices.contains(index) else { return }
        vatRows.remove(at: index)
    }

    func vatRowsChanged(from baseline: ReceiptForm) -> Bool {
        guard vatRows.count == baseline.vatRows.count else { return true }
        return zip(vatRows, baseline.vatRows).contains { row, other in
            row.rate != other.rate || ReceiptAmount.parse(row.amountText) != ReceiptAmount.parse(other.amountText)
        }
    }

    // MARK: New receipt

    /// The body of `POST /api/receipts/save` for this form, checked as the web
    /// editor checks a new receipt (`validateReceiptFields` + `vatPayload`).
    public func makeDraft(uploadId: String, forceDuplicate: Bool = false) -> ReceiptDraftOutcome {
        var errors = fieldErrors()
        var lines: [VatDetail] = []
        var vatOK = true
        for (i, row) in vatRows.enumerated() {
            if Self.trimmed(row.amountText).isEmpty { errors["vat-\(i)"] = ReceiptVat.missingMessage; vatOK = false; continue }
            guard let amount = ReceiptAmount.parse(row.amountText), amount >= 0 else {
                errors["vat-\(i)"] = ReceiptVat.invalidMessage; vatOK = false; continue
            }
            if !ReceiptVat.isSupported(row.rate) { errors["vat-\(i)"] = ReceiptVat.unsupportedMessage(row.rate) }
            lines.append(VatDetail(rate: row.rate, amount: ReceiptAmount.rounded(amount, 2)))
        }
        let total = ReceiptAmount.parse(totalText)
        if vatOK, let total, errors["vat-0"] == nil {
            let vatCents = lines.reduce(Decimal(0)) { $0 + ReceiptAmount.cents($1.amount) }
            if vatCents > ReceiptAmount.cents(total) { errors["vat-0"] = ReceiptVat.tooLargeMessage }
        }
        if !errors.isEmpty { return .invalid(errors) }
        var draft = ReceiptDraft(uploadId: uploadId)
        draft.vendor = Self.trimmed(vendor)
        draft.date = date
        draft.totalAmount = total.map { ReceiptAmount.rounded($0, 2) }
        draft.vatDetails = lines
        draft.category = Self.trimmed(category)
        draft.notes = notes
        draft.type = type
        draft.reference = reference
        draft.invoiceNumber = invoiceNumber
        draft.forceDuplicate = forceDuplicate
        return .draft(draft)
    }

    // MARK: Patch

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The field errors of the form, the same rules as the web editor.
    public func fieldErrors() -> [String: String] {
        var errors: [String: String] = [:]
        let v = Self.trimmed(vendor)
        if v.isEmpty { errors["vendor"] = "Myyjä on pakollinen." }
        else if v.count > Self.limits.vendor { errors["vendor"] = "Myyjä saa olla enintään \(Self.limits.vendor) merkkiä." }
        if APIDate.day(date) == nil { errors["date"] = "Valitse päivämäärä." }
        if Self.trimmed(totalText).isEmpty { errors["totalAmount"] = "Summa on pakollinen." }
        else if let amount = ReceiptAmount.parse(totalText) {
            if amount <= 0 { errors["totalAmount"] = "Summan pitää olla suurempi kuin nolla." }
        } else { errors["totalAmount"] = "Summa ei ole kelvollinen." }
        if Self.trimmed(category).isEmpty { errors["category"] = "Valitse kategoria." }
        if Self.trimmed(reference).count > Self.limits.reference { errors["reference"] = "Viitenumero saa olla enintään \(Self.limits.reference) merkkiä." }
        if Self.trimmed(invoiceNumber).count > Self.limits.invoiceNumber { errors["invoiceNumber"] = "Laskun numero saa olla enintään \(Self.limits.invoiceNumber) merkkiä." }
        if Self.trimmed(notes).count > Self.limits.notes { errors["notes"] = "Selite saa olla enintään \(Self.limits.notes) merkkiä." }
        return errors
    }

    /// What to send for this form compared with the receipt as loaded.
    public func makePatch(baseline: ReceiptForm, expectedUpdatedAt: String?) -> ReceiptPatchOutcome {
        var errors = fieldErrors()
        let total = ReceiptAmount.parse(totalText)
        let totalChanged = total != ReceiptAmount.parse(baseline.totalText)
        let vatChanged = vatRowsChanged(from: baseline)

        // VAT: a changed row is held to the save rule; lines sent back as stored are not checked for rate.
        var lines: [VatDetail] = []
        var vatOK = true
        for (i, row) in vatRows.enumerated() {
            if Self.trimmed(row.amountText).isEmpty {
                if vatChanged { errors["vat-\(i)"] = ReceiptVat.missingMessage }
                vatOK = false
                continue
            }
            guard let amount = ReceiptAmount.parse(row.amountText), amount >= 0 else {
                if vatChanged { errors["vat-\(i)"] = ReceiptVat.invalidMessage }
                vatOK = false
                continue
            }
            if vatChanged && !ReceiptVat.isSupported(row.rate) {
                errors["vat-\(i)"] = ReceiptVat.unsupportedMessage(row.rate)
            }
            lines.append(VatDetail(rate: row.rate, amount: ReceiptAmount.rounded(amount, 2)))
        }
        if vatOK, (vatChanged || totalChanged), let total, errors["vat-0"] == nil {
            let vatCents = lines.reduce(Decimal(0)) { $0 + ReceiptAmount.cents($1.amount) }
            if vatCents > ReceiptAmount.cents(total) { errors["vat-0"] = ReceiptVat.tooLargeMessage }
        }
        if !errors.isEmpty { return .invalid(errors) }

        var patch = ReceiptPatch(expectedUpdatedAt: expectedUpdatedAt)
        func required(_ key: String, _ now: String, _ was: String) {
            if Self.trimmed(now) != Self.trimmed(was) { patch.set(key, .text(Self.trimmed(now))) }
        }
        func optional(_ key: String, _ now: String, _ was: String) {
            let t = Self.trimmed(now)
            if t != Self.trimmed(was) { patch.set(key, .text(t.isEmpty ? nil : t)) }
        }
        required("vendor", vendor, baseline.vendor)
        required("date", date, baseline.date)
        if totalChanged, let total { patch.set("totalAmount", .amount(ReceiptAmount.rounded(total, 2))) }
        if vatChanged { patch.set("vatDetails", .vat(lines)) }
        required("category", category, baseline.category)
        if type != baseline.type { patch.set("type", .text(type)) }
        optional("notes", notes, baseline.notes)
        optional("reference", reference, baseline.reference)
        optional("invoiceNumber", invoiceNumber, baseline.invoiceNumber)
        return patch.isEmpty ? .unchanged : .patch(patch)
    }
}

/// How a refused receipt save is shown.
public enum ReceiptSaveFailure: Sendable, Equatable {
    /// Someone saved the receipt in between: offer "Lataa uudelleen".
    case versionConflict(String)
    /// The receipt's month (or the month it would move to) is closed.
    case periodLocked(String)
    /// The server named fields.
    case fields([String: String], String)
    case other(String)

    public init(_ error: LKError) {
        if ["PERIOD_LOCKED", "PERIOD_LOCK_CHANGED", "PERIOD_REOPEN_REQUIRED"].contains(error.code ?? "") {
            self = .periodLocked(error.message)
        } else if error.status == 409, error.code == "CONFLICT" || error.message.contains("Lataa tiedot uudelleen") {
            self = .versionConflict(error.message)
        } else {
            let named = error.fields.filter { $0.key != "isDuplicate" }
            self = named.isEmpty ? .other(error.message) : .fields(named, error.message)
        }
    }

    public var message: String {
        switch self {
        case .versionConflict(let m), .periodLocked(let m), .other(let m), .fields(_, let m): m
        }
    }
}
