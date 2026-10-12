import Foundation

/// How a part credit shows on a sales invoice. A part credit leaves the invoice "sent" with its full
/// gross (the rest is still owed), so the status alone would hide it (web: `isPartlyCredited`).
public enum InvoiceCreditDisplay {
    public static let partlyCreditedLabel = "Osittain hyvitetty"
}

extension Invoice {
    /// What credit notes have taken off, zero when the server does not say.
    public var creditedAmount: Decimal { credited ?? 0 }

    /// 0 < credited < gross on an invoice that is not a draft, a credit note or fully credited.
    public var isPartlyCredited: Bool {
        !isCreditNote && displayStatus != .credited && displayStatus != .draft
            && creditedAmount > 0 && creditedAmount < gross
    }

    /// The list row's tail: ", hyvitetty 20,00 €"; nil when nothing is credited.
    public var creditedRowSuffix: String? {
        isPartlyCredited ? ", hyvitetty \(Money.format(creditedAmount))" : nil
    }

    /// "Avoinna 62,00 €, hyvitetty 20,00 €" under the detail's status line; nil when nothing is credited.
    public var openAndCreditedLine: String? {
        isPartlyCredited ? "Avoinna \(Money.format(open)), hyvitetty \(Money.format(creditedAmount))" : nil
    }
}
