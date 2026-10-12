import Foundation

/// The currency of a document in the capture form (web `ReceiptEditor`: "Valuutta" and, for a
/// foreign document, "Summa (USD)"). The server keeps euros in `totalAmount` and the figure printed
/// on the document in `originalAmount`.
public enum ReceiptCurrency {
    public static let base = "EUR"

    /// What the picker offers. The web takes any three-letter code; a phone picker lists the ones a
    /// small business meets (the ECB prices all of these) and adds a code the reading found.
    public static let common = ["EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "PLN", "CZK", "JPY", "CAD", "AUD"]

    /// The three-letter upper-case code; anything else (nil, "euro", "€") is euros, as the web
    /// sends "EUR" for a field that is not a code.
    public static func code(_ text: String?) -> String {
        let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return t.count == 3 && t.allSatisfy { $0.isASCII && $0.isLetter } ? t : base
    }

    /// The picker's choices: the common ones, plus `current` when it is none of them.
    public static func choices(including current: String) -> [String] {
        let chosen = code(current)
        return common.contains(chosen) ? common : common + [chosen]
    }

    public static func isForeign(_ text: String?) -> Bool { code(text) != base }

    public static let invalidAmountMessage = "Summa ei ole kelvollinen."

    /// "Summa (USD)": the label of the original figure.
    public static func originalAmountLabel(_ text: String?) -> String { "Summa (\(code(text)))" }
}

/// The rate a reading carried for a non-euro document, kept beside the draft so the form can say
/// which rate priced the euro total ("Kurssi 1 USD = 0,8749 EUR (EKP 10.7.2026)").
public struct ReceiptFxReading: Codable, Sendable, Equatable {
    public let currency: String
    /// Euros for one unit of `currency`.
    public let rate: Double
    public let date: String?
    /// "document" when the document printed the rate; anything else is the ECB's.
    public let source: String?

    public init(currency: String, rate: Double, date: String?, source: String?) {
        self.currency = currency
        self.rate = rate
        self.date = date
        self.source = source
    }

    public var line: String? { ReceiptFx.line(currency: currency, rate: rate, date: date, source: source) }
}
