import Foundation

/// A part of a sales invoice credited, as the web's detail page does it (`creditRemaining`,
/// `creditTotals`, `createCreditNote`). `POST /api/invoices/{id}/credit` has a strict body:
/// `lines: [{ lineId, quantity }]` (up to three decimals), or no body for everything that is left.
/// A part is therefore chosen by quantity per line.
public enum InvoiceCredit {
    /// The request body: only the lines the owner filled in.
    public struct Body: Encodable, Sendable, Equatable {
        public struct Line: Encodable, Sendable, Equatable {
            public let lineId: String
            public let quantity: Decimal
        }
        public let lines: [Line]
    }

    public enum Outcome: Equatable, Sendable {
        case body(Body)
        case invalid(String)
    }

    /// What is left to credit per line id: the quantity less what earlier credit notes reversed.
    /// Floored at zero. A server that sends no `sortOrder` is read in line order.
    public static func remaining(_ invoice: Invoice) -> [String: Decimal] {
        var credited: [Int: Decimal] = [:]
        for note in invoice.creditNotes ?? [] {
            for line in note.lines { credited[line.sortOrder, default: 0] += line.quantity }
        }
        var result: [String: Decimal] = [:]
        for (index, line) in invoice.lines.enumerated() {
            let left = line.quantity - (credited[line.sortOrder ?? index] ?? 0)
            result[line.id] = left > 0 ? left : 0
        }
        return result
    }

    /// The text each line starts with: what is left of it, none for a line already fully credited.
    public static func prefilled(_ invoice: Invoice) -> [String: String] {
        var texts: [String: String] = [:]
        for (id, left) in remaining(invoice) where left > 0 { texts[id] = quantityText(left) }
        return texts
    }

    /// "2", "1,5": at most three decimals, no trailing zeros, a comma as the decimal sign.
    public static func quantityText(_ value: Decimal) -> String {
        var v = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &v, 3, .plain)
        return NSDecimalNumber(decimal: rounded).stringValue.replacingOccurrences(of: ".", with: ",")
    }

    /// A positive quantity of at most three decimals, as the server accepts it.
    static func parseQuantity(_ text: String) -> Decimal? {
        guard let value = Money.parse(text), value > 0 else { return nil }
        var v = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &v, 3, .plain)
        return rounded == value ? value : nil
    }

    /// The body for what the owner typed (line id to text), or the Finnish reason it cannot be sent.
    public static func body(invoice: Invoice, quantities: [String: String]) -> Outcome {
        let left = remaining(invoice)
        var lines: [Body.Line] = []
        for line in invoice.lines {
            let text = (quantities[line.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            guard let quantity = parseQuantity(text) else {
                return .invalid("Rivin määrä on virheellinen (enintään kolme desimaalia): \(line.description)")
            }
            let rest = left[line.id] ?? 0
            if quantity > rest {
                return .invalid("Riviltä \(line.description) on hyvitettävissä enää \(quantityText(rest)) \(line.unit).")
            }
            lines.append(Body.Line(lineId: line.id, quantity: quantity))
        }
        if lines.isEmpty { return .invalid("Valitse vähintään yksi rivi hyvitettäväksi.") }
        return .body(Body(lines: lines))
    }

    /// The gross sum the note will reverse, rounded like the web's `creditTotals` (each line to
    /// cents, VAT once per rate), so the figure shown is the one that lands. Nil while nothing valid is typed.
    public static func total(invoice: Invoice, quantities: [String: String]) -> Decimal? {
        var netByRate: [Decimal: Decimal] = [:]
        for line in invoice.lines {
            let text = (quantities[line.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            guard let quantity = parseQuantity(text) else { return nil }
            netByRate[line.vatRate, default: 0] += cents(quantity * line.unitPrice)
        }
        if netByRate.isEmpty { return nil }
        var gross: Decimal = 0
        for (rate, net) in netByRate { gross += net + cents(net * rate / 100) }
        return gross
    }

    private static func cents(_ value: Decimal) -> Decimal {
        var v = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &v, 2, .plain)
        return rounded
    }

    /// Said under the lines in the credit sheet.
    public static let confirmNote = "Laskulle luodaan numeroitu hyvityslasku. Hyvitystä ei voi perua."
}
