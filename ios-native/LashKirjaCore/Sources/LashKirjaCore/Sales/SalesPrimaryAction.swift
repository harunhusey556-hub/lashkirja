import Foundation

/// The one thing an invoice is waiting for, shown as the full-width button under its header:
/// a draft waits to be sent, an overdue one for a reminder (when one can go now), an open one for its payment.
public enum InvoicePrimaryAction: Sendable, Equatable {
    case send, reminder, payment

    public var title: String {
        switch self {
        case .send: "Lähetä lasku"
        case .reminder: "Lähetä maksumuistutus"
        case .payment: "Kirjaa maksu"
        }
    }

    public var symbol: String {
        switch self {
        case .send: "paperplane"
        case .reminder: "bell"
        case .payment: "eurosign.circle"
        }
    }

    /// `reminderReady`: the reminder preview is loaded and not waiting for its next allowed date.
    /// A credit note is never sent, reminded or paid from its own screen.
    public static func `for`(status: InvoiceStatus, open: Decimal, isCreditNote: Bool, reminderReady: Bool) -> InvoicePrimaryAction? {
        guard !isCreditNote else { return nil }
        switch status {
        case .draft: return .send
        case .overdue: return open > 0 ? (reminderReady ? .reminder : .payment) : nil
        case .sent: return open > 0 ? .payment : nil
        case .paid, .credited: return nil
        }
    }
}
