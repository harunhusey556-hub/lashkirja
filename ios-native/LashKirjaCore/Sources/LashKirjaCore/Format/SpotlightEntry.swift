import Foundation

/// What one Spotlight result shows and where a tap goes. Built here so the wording and the link
/// are tested; the app only hands these to CoreSpotlight.
public struct SpotlightEntry: Equatable, Sendable {
    /// The link a tap opens (`OpenTarget.url`); also the item's unique identifier.
    public let identifier: String
    public let title: String
    public let detail: String
    public let keywords: [String]

    public init(identifier: String, title: String, detail: String, keywords: [String]) {
        self.identifier = identifier
        self.title = title
        self.detail = detail
        self.keywords = keywords
    }

    /// Name and Y-tunnus; the Y-tunnus is both shown and searchable.
    public static func customer(id: String, name: String, businessId: String?) -> SpotlightEntry? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !name.isEmpty else { return nil }
        let bid = (businessId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return SpotlightEntry(
            identifier: OpenTarget.customer(id).url.absoluteString,
            title: name,
            detail: bid.isEmpty ? "Asiakas" : "Asiakas · Y-tunnus \(bid)",
            keywords: bid.isEmpty ? [name] : [name, bid]
        )
    }

    /// "Lasku 3 · Anna Asiakas", with the amount and status underneath.
    public static func invoice(id: String, number: Int, customerName: String, gross: Decimal, statusLabel: String) -> SpotlightEntry? {
        guard !id.isEmpty else { return nil }
        let customer = customerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return SpotlightEntry(
            identifier: OpenTarget.invoice(id).url.absoluteString,
            title: customer.isEmpty ? "Lasku \(number)" : "Lasku \(number) · \(customer)",
            detail: "\(Money.format(gross)) · \(statusLabel)",
            keywords: ["Lasku \(number)", String(number), customer].filter { !$0.isEmpty }
        )
    }
}
