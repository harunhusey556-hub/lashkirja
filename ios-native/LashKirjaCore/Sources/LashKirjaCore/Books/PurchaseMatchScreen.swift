import Foundation

/// "Kohdista ostolaskujen maksut": every open ostolasku with the bank payment the matcher proposes
/// for it, as the web page `kirjanpito/ostolaskut/kohdistus` lists them (`PurchaseMatchList.tsx`).
public enum PurchaseMatch {
    /// "Varma": the exact open amount and a strong supplier match. The web gate scores 0.7 for an
    /// amount plus any name match and 0.9 for a viite hit, so only the weakest name matches wait for a look.
    public static let sureScore = 0.8

    /// One open ostolasku and the payment proposed for it, if any.
    public struct Row: Sendable, Hashable, Identifiable {
        public let invoice: PurchaseInvoice
        public let suggestion: PurchaseMatchResult.Suggestion?
        public var id: String { invoice.id }
    }

    /// The rows of the screen: proposals first, then the rest, each by due date. Only open and
    /// overdue ostolaskut count; a paid or cancelled one never waits for a payment.
    public static func rows(invoices: [PurchaseInvoice], suggestions: [PurchaseMatchResult.Suggestion]) -> [Row] {
        let byInvoice = Dictionary(suggestions.map { ($0.invoiceId, $0) }, uniquingKeysWith: { _, newer in newer })
        return invoices
            .filter { ($0.displayStatus == .open || $0.displayStatus == .overdue) && !$0.isCreditNote }
            .map { Row(invoice: $0, suggestion: byInvoice[$0.id]) }
            .sorted { a, b in
                if (a.suggestion != nil) != (b.suggestion != nil) { return a.suggestion != nil }
                return a.invoice.dueDate < b.invoice.dueDate
            }
    }

    public static func isSure(_ suggestion: PurchaseMatchResult.Suggestion) -> Bool {
        (suggestion.score ?? 0) >= sureScore
    }

    /// The proposals "Hyväksy kaikki varmat" records: sure ones that carry what a payment needs.
    public static func sureSuggestions(_ suggestions: [PurchaseMatchResult.Suggestion]) -> [PurchaseMatchResult.Suggestion] {
        suggestions.filter { isSure($0) && $0.canAccept }
    }

    /// "Hyväksy kaikki varmat (3)", or without the number when none is known to be sure yet.
    public static func bulkTitle(sureCount: Int) -> String {
        sureCount > 0 ? "Hyväksy kaikki varmat (\(sureCount))" : "Hyväksy kaikki varmat"
    }

    /// The line after "Hyväksy kaikki varmat", as the web's toast.
    public static func bulkSummary(accepted: Int, failed: Int) -> String {
        if accepted == 0 && failed == 0 { return "Ei varmoja maksuja kohdistettavaksi." }
        return "Kohdistettiin \(accepted) maksua." + (failed > 0 ? " \(failed) ei onnistunut, tarkista ne." : "")
    }

    /// "Pankki · Tukku Oy · 25.1.2026 · 124,00 €" under a proposed row.
    public static func paymentLine(_ suggestion: PurchaseMatchResult.Suggestion) -> String {
        var parts = ["Pankki"]
        if let name = PurchaseBankLinkText.nonEmpty(suggestion.counterparty) { parts.append(name) }
        if let date = suggestion.paidDate { parts.append(APIDate.displayDay(date)) }
        if let amount = suggestion.amount { parts.append(Money.format(amount)) }
        return parts.joined(separator: " · ")
    }

    /// "summa sama, nimi vastaa · varma": the matcher's reasons, and the word when the proposal is sure.
    public static func reasonLine(_ suggestion: PurchaseMatchResult.Suggestion) -> String? {
        let reasons = suggestion.reasons.joined(separator: ", ")
        guard !reasons.isEmpty else { return nil }
        return isSure(suggestion) ? "\(reasons) · varma" : reasons
    }

    public static let emptyTitle = "Ei avoimia ostolaskuja"
    public static let emptyBody = "Kun ostolaskuja on maksamatta, niiden pankkimaksut ehdotetaan tässä."
}

/// `GET /api/purchase-invoices/match` for the Kohdistus screen: the proposals, the open ostolaskut
/// they belong to, and nothing else.
public struct PurchaseMatchData: Sendable, Equatable {
    public let rows: [PurchaseMatch.Row]
    public let suggestions: [PurchaseMatchResult.Suggestion]

    public init(invoices: [PurchaseInvoice], suggestions: [PurchaseMatchResult.Suggestion]) {
        self.suggestions = suggestions
        rows = PurchaseMatch.rows(invoices: invoices, suggestions: suggestions)
    }

    public var proposed: [PurchaseMatch.Row] { rows.filter { $0.suggestion != nil } }
    public var waiting: [PurchaseMatch.Row] { rows.filter { $0.suggestion == nil } }
    public var sureCount: Int { PurchaseMatch.sureSuggestions(suggestions).count }
}
