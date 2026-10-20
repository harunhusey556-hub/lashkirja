import Foundation

/// The line under the customer on an invoice row, on Myynti and on the customer's own list:
/// "Lasku 2 · eräpäivä 3.10.2026". The row's badge already says "Myöhässä", so the line does not
/// say it again (M100). The customer's list printed the invoice date without a label beside
/// Myynti's due date, and the same invoice read as two days (X027).
public enum InvoiceRowText {
    /// A credit note and a draft by their number alone: neither is waiting for a payment by a day.
    public static func secondary(number: Int, status: InvoiceStatus, dueDate: String, isCreditNote: Bool = false,
                                 creditedSuffix: String? = nil) -> String {
        if isCreditNote { return "Hyvityslasku \(number)" }
        if status == .draft { return "Lasku \(number)" }
        return "Lasku \(number) · eräpäivä \(APIDate.displayDay(dueDate))" + (creditedSuffix ?? "")
    }
}

extension Invoice {
    /// The Myynti row's line, with what a part credit took off.
    public var rowSecondary: String {
        InvoiceRowText.secondary(number: number, status: displayStatus, dueDate: dueDate, isCreditNote: isCreditNote,
                                 creditedSuffix: creditedRowSuffix)
    }
}

extension CustomerDetail.InvoiceSummary {
    /// The customer detail's row line. The summary carries no document kind or credit, so a credit
    /// note reads as its number with the due date.
    public var rowSecondary: String {
        InvoiceRowText.secondary(number: number, status: displayStatus, dueDate: dueDate)
    }
}
