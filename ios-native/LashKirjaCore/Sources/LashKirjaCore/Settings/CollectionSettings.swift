import Foundation

/// "Perintä" in the seller form (components/SellerProfileCard.tsx): late interest % per year
/// and the reminder fee, as typed text with the web's checks.
public struct CollectionFields: Equatable, Sendable {
    public var interest: String
    public var fee: String

    public static let interestHint = "Tyhjä korko = korkoa ei peritä. Tavallisesti viitekorko + 8 %-yks. (kuluttajalle + 7)."

    public init(profile: Profile) {
        interest = profile.lateInterestPercent.map(Self.text) ?? ""
        // The server's default fee is 5,00 € (reminderFeeCents @default(500)).
        fee = ReceiptAmount.field(Decimal(profile.reminderFeeCents ?? 500) / 100)
    }

    /// Nil when empty (no interest charged) or not a number.
    public var interestPercent: Decimal? { Self.number(interest) }
    public var feeEuros: Decimal? { Self.number(fee) }

    public var interestError: String? {
        guard !interest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let value = interestPercent, value >= 0, value <= 100 else { return "Anna korko välillä 0-100, esim. 11,5." }
        return nil
    }

    public var feeError: String? {
        guard let value = feeEuros, value >= 0 else { return "Anna muistutusmaksu, esim. 5,00." }
        return nil
    }

    public var isValid: Bool { interestError == nil && feeError == nil }

    /// Writes the typed values into `profile`. A field left as it was shown keeps the stored value,
    /// so a rate shown rounded is not sent back as a change.
    public func apply(to profile: inout Profile, from original: Profile) {
        let shown = CollectionFields(profile: original)
        if interest != shown.interest { profile.lateInterestPercent = interestPercent }
        if fee != shown.fee, let euros = feeEuros {
            var cents = euros * 100
            var rounded = Decimal()
            NSDecimalRound(&rounded, &cents, 0, .plain)
            profile.reminderFeeCents = NSDecimalNumber(decimal: rounded).intValue
        }
    }

    /// lib/format.ts parseFinnishNumber: "11,5", "5 €", "5 eur".
    static func number(_ text: String) -> Decimal? {
        let cleaned = text.replacingOccurrences(of: "eur", with: "", options: .caseInsensitive)
        return Money.parse(cleaned.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// "11,5", "8": at most four decimals, no trailing zeros.
    static func text(_ value: Decimal) -> String {
        var v = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &v, 4, .plain)
        return NSDecimalNumber(decimal: rounded).stringValue.replacingOccurrences(of: ".", with: ",")
    }
}
