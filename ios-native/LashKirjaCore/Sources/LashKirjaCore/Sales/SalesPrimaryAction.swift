import Foundation

/// The one thing an invoice is waiting for, shown as the full-width button under its header:
/// a draft waits to be sent, an overdue one for a reminder (when one can go now), an open one for its payment,
/// and a sent one with nothing left to collect for "Merkitse maksetuksi".
public enum InvoicePrimaryAction: Sendable, Equatable {
    case send, reminder, payment, markPaid

    public var title: String {
        switch self {
        case .send: "Lähetä lasku"
        case .reminder: "Lähetä maksumuistutus"
        case .payment: "Kirjaa maksu"
        case .markPaid: "Merkitse maksetuksi"
        }
    }

    public var symbol: String {
        switch self {
        case .send: "paperplane"
        case .reminder: "bell"
        case .payment: "eurosign.circle"
        case .markPaid: "checkmark.circle"
        }
    }

    /// `reminderReady`: the reminder preview is loaded and not waiting for its next allowed date.
    /// A credit note is never sent, reminded or paid from its own screen.
    public static func `for`(status: InvoiceStatus, open: Decimal, isCreditNote: Bool, reminderReady: Bool) -> InvoicePrimaryAction? {
        guard !isCreditNote else { return nil }
        switch status {
        case .draft: return .send
        // Nothing left to collect wins over the reminder flow of an invoice late by date (web).
        case .overdue: return open > 0 ? (reminderReady ? .reminder : .payment) : .markPaid
        case .sent: return open > 0 ? .payment : .markPaid
        case .paid, .credited: return nil
        }
    }
}
