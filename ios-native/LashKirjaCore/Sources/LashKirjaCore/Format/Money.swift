import Foundation

/// Euro amounts as the Finnish app shows them: "1 234,56 €", "−8,50 €".
public enum Money {
    private static let nbsp = "\u{00A0}"

    public static func format(_ amount: Decimal, signed: Bool = false) -> String {
        var value = amount
        var rounded = Decimal()
        // Half away from zero, like the web app's Intl.NumberFormat: 0,125 → 0,13.
        NSDecimalRound(&rounded, &value, 2, .plain)
        let negative = rounded < 0
        let absolute = negative ? -rounded : rounded
        let text = NSDecimalNumber(decimal: absolute).stringValue
        let parts = text.split(separator: ".", maxSplits: 1)
        let whole = String(parts[0])
        var cents = parts.count > 1 ? String(parts[1]) : "00"
        while cents.count < 2 { cents += "0" }
        var grouped = ""
        for (i, ch) in whole.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { grouped.append(Character(nbsp)) }
            grouped.append(ch)
        }
        let sign = negative ? "\u{2212}" : (signed && rounded > 0 ? "+" : "")
        return "\(sign)\(String(grouped.reversed())),\(cents)\(nbsp)€"
    }

    /// What a person types: "1 234,56", "12.5", "12,50 €".
    public static func parse(_ text: String) -> Decimal? {
        let cleaned = text
            .replacingOccurrences(of: "€", with: "")
            .replacingOccurrences(of: nbsp, with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ",", with: ".")
            .replacingOccurrences(of: "\u{2212}", with: "-")
        guard !cleaned.isEmpty, cleaned.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil else { return nil }
        return Decimal(string: cleaned, locale: Locale(identifier: "en_US_POSIX"))
    }
}
