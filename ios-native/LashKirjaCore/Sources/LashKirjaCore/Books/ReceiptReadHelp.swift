import Foundation

extension ReceiptCurrency {
    /// "5 707,79 PLN": an amount in the document's own currency, grouped like the euro figures.
    public static func formatOriginal(_ amount: Decimal, currency: String?) -> String {
        Money.format(amount).replacingOccurrences(of: "€", with: code(currency))
    }

    /// The figure the foreign document printed, beside its euro total; nil for a euro receipt.
    /// The owner read "1 319,18" next to a bare "PLN" as złoty (Shell Polska, 2026-10-15): the
    /// euro total and the document's own figure must each say their currency.
    public static func originalLine(currency: String?, originalAmount: Decimal?) -> String? {
        guard isForeign(currency), let originalAmount else { return nil }
        return formatOriginal(originalAmount, currency: currency)
    }
}

/// A receipt the reading did not get right: what the owner is offered and told (2026-10-15,
/// "if the AI could not read it, what can the user do?").
public enum ReceiptReadHelp {
    /// Below this the reading was a guess (the Kymenlaakson Sähkö bills came back at 0,1).
    public static let confidenceFloor = 0.5

    /// "Lue uudelleen" is offered up front when the stored file was read poorly or not at all.
    /// A receipt typed by hand (no score, every field filled) is the owner's own and is not.
    public static func needsReread(_ r: Receipt) -> Bool {
        guard r.hasOriginalFile else { return false }
        if r.vendor?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true { return true }
        if r.totalAmount == nil { return true }
        if let confidence = r.confidence, confidence < confidenceFloor { return true }
        return false
    }

    public static let hint = "Tiedostoa ei saatu luettua kunnolla. Lue se uudelleen – jos jokin on yhä väärin, korjaa se Muokkaa-kohdasta. Korjattu myyjä muistetaan seuraavalla kerralla."
}
