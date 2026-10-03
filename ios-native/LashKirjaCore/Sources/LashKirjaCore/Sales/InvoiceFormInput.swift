import Foundation

/// A field of the invoice form, for an error shown at the field and for moving focus to it.
/// Lines are named by their id, so an error stays on its line when lines are reordered.
public enum InvoiceFormField: Hashable, Sendable {
    case customer, dueDate, lines, notes
    case description(UUID), quantity(UUID), unitPrice(UUID), vatRate(UUID)
}

/// The invoice form's choices, figures and checks (web `InvoiceForm.tsx`, server `createInvoice`).
public enum InvoiceForm {
    // MARK: Payment term

    /// One tap each; anything else is "Muu", picked as a due date.
    public static let paymentTerms = [7, 14, 21, 30]
    /// Server `MAX_PAYMENT_TERM_DAYS`.
    public static let maxPaymentTermDays = 365

    public enum TermChoice: Hashable, Sendable {
        case days(Int), other

        public var label: String {
            switch self {
            case .days(let days): "\(days) pv"
            case .other: "Muu"
            }
        }
    }

    public static func termChoice(_ days: Int) -> TermChoice {
        paymentTerms.contains(days) ? .days(days) : .other
    }

    /// Calendar-day arithmetic on "YYYY-MM-DD", as the server's `addDaysUtc` does it.
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static func utcDay(_ text: String) -> Date? {
        let parts = text.split(separator: "-")
        guard text.count == 10, parts.count == 3,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        let components = DateComponents(year: y, month: m, day: d)
        guard components.isValidDate(in: utc), let date = utc.date(from: components) else { return nil }
        return date
    }

    private static func utcString(_ date: Date) -> String {
        let c = utc.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The due date the server will store for this issue date and term.
    public static func dueDate(issueDate: String, termDays: Int) -> String? {
        guard let issue = utcDay(issueDate), let due = utc.date(byAdding: .day, value: termDays, to: issue) else { return nil }
        return utcString(due)
    }

    /// A due date picked by hand, as the term the create call sends; nil when the server would refuse it.
    public static func termDays(issueDate: String, dueDate: String) -> Int? {
        guard let issue = utcDay(issueDate), let due = utcDay(dueDate),
              let days = utc.dateComponents([.day], from: issue, to: due).day,
              (0...maxPaymentTermDays).contains(days) else { return nil }
        return days
    }

    /// "Eräpäivä 17.10.2026 · 14 pv" under the term choice.
    public static func dueSummary(issueDate: String, termDays: Int) -> String? {
        guard let due = dueDate(issueDate: issueDate, termDays: termDays) else { return nil }
        return "Eräpäivä \(APIDate.displayDay(due)) · \(termDays == 0 ? "heti" : "\(termDays) pv")"
    }

    // MARK: Units

    /// The server takes any unit up to 16 characters; these cover most lines.
    public static let units = ["kpl", "h", "pv", "kk", "km", "vk", "krt", "erä", "m²", "kg"]
    public static let maxUnitLength = 16

    /// The units offered, plus the line's own when it is something else (a catalog product's).
    public static func unitOptions(current: String) -> [String] {
        let trimmed = current.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || units.contains(trimmed) ? units : units + [trimmed]
    }

    // MARK: Figures

    /// Half away from zero to cents, like the server's `roundHalfAwayFromZero` on cents.
    static func cents(_ value: Decimal) -> Decimal {
        var input = value
        var output = Decimal()
        NSDecimalRound(&output, &input, 2, .plain)
        return output
    }

    /// The line's net as the server stores it: quantity × price, rounded once to cents.
    public static func lineNet(_ line: InvoiceDraft.Line) -> Decimal {
        cents(line.quantity * line.unitPrice)
    }

    /// The line with its own VAT, for the live figure on the line card. The invoice total
    /// rounds VAT once per rate (`InvoiceDraft.totals`), so lines can differ from it by a cent.
    public static func lineGross(_ line: InvoiceDraft.Line, vatRegistered: Bool) -> Decimal {
        let net = lineNet(line)
        guard vatRegistered else { return net }
        return net + cents(net * line.vatRate / 100)
    }

    /// "12,50": a price in the entry field.
    public static func priceText(_ value: Decimal) -> String {
        var input = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &input, 2, .plain)
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.minimumIntegerDigits = 1
        formatter.usesGroupingSeparator = false
        let text = formatter.string(from: NSDecimalNumber(decimal: rounded)) ?? "\(rounded)"
        return text.replacingOccurrences(of: ".", with: ",")
    }

    /// "1,5": a quantity in the entry field.
    public static func quantityText(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: ",")
    }

    /// The quantity stepper: whole steps, never below one (a smaller amount is typed).
    public static func steppedQuantity(_ quantity: Decimal, by step: Int) -> Decimal {
        max(1, quantity + Decimal(step))
    }

    // MARK: Validation

    private static func hasMoreDecimals(_ value: Decimal, than allowed: Int) -> Bool {
        var input = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &input, allowed, .plain)
        return rounded != value
    }

    /// Each problem at its field, in the web form's words. `priceTexts` are the price fields as
    /// typed: an empty one is "Hinta puuttuu." although the line's amount reads 0. A line without
    /// a text (restored, edited) is judged by its amount.
    public static func fieldErrors(_ draft: InvoiceDraft, priceTexts: [UUID: String] = [:], vatRegistered: Bool) -> [InvoiceFormField: String] {
        var errors: [InvoiceFormField: String] = [:]
        if draft.customerId.isEmpty { errors[.customer] = "Valitse asiakas." }
        if !(0...maxPaymentTermDays).contains(draft.paymentTermDays) { errors[.dueDate] = "Maksuaika on 0–365 päivää." }
        if draft.lines.isEmpty { errors[.lines] = "Lisää vähintään yksi rivi." }
        if draft.notes.trimmingCharacters(in: .whitespacesAndNewlines).count > 2000 {
            errors[.notes] = "Viesti on liian pitkä (enintään 2000 merkkiä)."
        }
        for line in draft.lines {
            let description = line.description.trimmingCharacters(in: .whitespacesAndNewlines)
            if description.isEmpty {
                errors[.description(line.id)] = "Kuvaus puuttuu."
            } else if description.count > 200 {
                errors[.description(line.id)] = "Kuvaus on liian pitkä (enintään 200 merkkiä)."
            }
            if line.quantity == 0 {
                errors[.quantity(line.id)] = "Määrä puuttuu."
            } else if line.quantity < 0 {
                errors[.quantity(line.id)] = "Määrä ei voi olla negatiivinen."
            } else if hasMoreDecimals(line.quantity, than: 3) {
                errors[.quantity(line.id)] = "Määrässä saa olla enintään kolme desimaalia."
            }
            if let text = priceTexts[line.id], text.trimmingCharacters(in: .whitespaces).isEmpty {
                errors[.unitPrice(line.id)] = "Hinta puuttuu."
            } else if let text = priceTexts[line.id], Money.parse(text) == nil {
                errors[.unitPrice(line.id)] = "Hinta ei ole kelvollinen summa."
            } else if line.unitPrice < 0 {
                errors[.unitPrice(line.id)] = "Hinta ei voi olla negatiivinen."
            } else if hasMoreDecimals(line.unitPrice, than: 2) {
                errors[.unitPrice(line.id)] = "Hinnassa saa olla enintään kaksi desimaalia."
            }
            if vatRegistered, APIDate.day(draft.issueDate) != nil,
               let note = SalesVat.dateNote(line.vatRate, issueDate: draft.issueDate) {
                errors[.vatRate(line.id)] = note
            }
        }
        return errors
    }

    /// The first field with an error, top to bottom as the form shows them.
    public static func firstInvalid(_ errors: [InvoiceFormField: String], lines: [InvoiceDraft.Line]) -> InvoiceFormField? {
        var order: [InvoiceFormField] = [.customer, .dueDate]
        for line in lines {
            order += [.description(line.id), .quantity(line.id), .unitPrice(line.id), .vatRate(line.id)]
        }
        order += [.lines, .notes]
        return order.first { errors[$0] != nil }
    }

    /// The typed fields in the order "Seuraava" walks them: each line, then the message.
    public static func textFieldOrder(lines: [InvoiceDraft.Line]) -> [InvoiceFormField] {
        lines.flatMap { [InvoiceFormField.description($0.id), .quantity($0.id), .unitPrice($0.id)] } + [.notes]
    }

    public static func field(after current: InvoiceFormField?, lines: [InvoiceDraft.Line]) -> InvoiceFormField? {
        let order = textFieldOrder(lines: lines)
        guard let current, let index = order.firstIndex(of: current), index + 1 < order.count else { return nil }
        return order[index + 1]
    }

    /// "Lisää tuotteista" fills the last line when the owner has not typed into it yet, so the
    /// form's starting line does not stay behind empty; nil adds a new line.
    public static func lineForCatalogPick(_ lines: [InvoiceDraft.Line], priceTexts: [UUID: String]) -> Int? {
        guard let last = lines.last,
              last.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (priceTexts[last.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty,
              last.unitPrice == 0 else { return nil }
        return lines.count - 1
    }

    /// One line above the save button; the details are at the fields.
    public static func errorSummary(_ errors: [InvoiceFormField: String]) -> String? {
        switch errors.count {
        case 0: nil
        case 1: errors.values.first
        default: "Tarkista \(errors.count) merkittyä kenttää."
        }
    }

    // MARK: Customer

    private static func folded(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "fi_FI"))
    }

    /// The picker's search: name, Y-tunnus or email, ignoring case and accents.
    public static func customers(_ all: [Customer], matching query: String) -> [Customer] {
        let needle = folded(query.trimmingCharacters(in: .whitespaces))
        guard !needle.isEmpty else { return all }
        return all.filter { customer in
            [customer.name, customer.businessId, customer.email].contains { field in
                field.map { folded($0).contains(needle) } ?? false
            }
        }
    }

    /// The line under the picked customer's name.
    public static func customerDetail(_ customer: Customer) -> String {
        partyDetail(businessId: customer.businessId, email: customer.email)
            ?? "Maksuaika \(customer.defaultPaymentTermDays) pv"
    }

    /// The same line for an edited invoice's customer that is no longer in the list (archived).
    public static func customerDetail(_ party: Invoice.Party) -> String? {
        partyDetail(businessId: party.businessId, email: party.email)
    }

    private static func partyDetail(businessId: String?, email: String?) -> String? {
        func present(_ text: String?) -> String? {
            guard let trimmed = text?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty else { return nil }
            return trimmed
        }
        let parts = [present(businessId).map { "Y-tunnus \($0)" }, present(email)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension Array where Element == InvoiceDraft.Line {
    /// "Kopioi rivi": the copy lands right below, as its own line. Returns the copy's id.
    @discardableResult
    public mutating func duplicateLine(at index: Int) -> UUID? {
        guard indices.contains(index) else { return nil }
        let source = self[index]
        let copy = InvoiceDraft.Line(description: source.description, quantity: source.quantity, unit: source.unit,
                                     unitPrice: source.unitPrice, vatRate: source.vatRate)
        insert(copy, at: index + 1)
        return copy.id
    }

    /// "Siirrä ylös / alas"; a move past either end does nothing.
    public mutating func moveLine(at index: Int, by offset: Int) {
        let target = index + offset
        guard indices.contains(index), indices.contains(target) else { return }
        swapAt(index, target)
    }
}
