import Foundation

/// The invoice screen's summary card and tabs: where the invoice stands in one line, how much of
/// it is paid, and which groups (rows, payments, reminder, history) it has, one shown at a time.
public enum InvoiceDetailLayout {
    public enum Tab: String, CaseIterable, Identifiable, Sendable {
        case lines, payments, reminder, history
        public var id: String { rawValue }
    }

    public struct TabItem: Identifiable, Equatable, Sendable {
        public let tab: Tab
        public let title: String
        public var id: Tab { tab }
    }

    public static func dueLine(status: InvoiceStatus, dueDate: String, paidAt: String?, today: String) -> String {
        switch status {
        case .draft:
            return "Luonnos · eräpäivä \(APIDate.displayDay(dueDate))"
        case .credited:
            return "Hyvitetty"
        case .paid:
            return paidAt.map { "Maksettu \(APIDate.displayDay(String($0.prefix(10))))" } ?? "Maksettu"
        case .sent, .overdue:
            let days = daysBetween(today, dueDate)
            if days < 0 { return -days == 1 ? "Myöhässä 1 päivän" : "Myöhässä \(-days) päivää" }
            if days == 0 { return "Erääntyy tänään" }
            if days == 1 { return "Erääntyy huomenna" }
            return "Erääntyy \(days) päivän päästä"
        }
    }

    /// Paid share of the total while the invoice is part paid; nil when nothing or everything is.
    public static func paidFraction(gross: Decimal, paid: Decimal) -> Double? {
        guard gross > 0, paid > 0, paid < gross else { return nil }
        return NSDecimalNumber(decimal: paid / gross).doubleValue
    }

    public static func tabs(payments: Int, activity: Int, overdue: Bool) -> [TabItem] {
        var items = [TabItem(tab: .lines, title: "Rivit"),
                     TabItem(tab: .payments, title: payments > 0 ? "Maksut \(payments)" : "Maksut")]
        if overdue { items.append(TabItem(tab: .reminder, title: "Muistutus")) }
        if activity > 0 { items.append(TabItem(tab: .history, title: "Historia \(activity)")) }
        return items
    }

    public static func initialTab(overdue: Bool) -> Tab { overdue ? .reminder : .lines }

    private static func daysBetween(_ from: String, _ to: String) -> Int {
        guard let a = APIDate.day(String(from.prefix(10))), let b = APIDate.day(String(to.prefix(10))) else { return 0 }
        return Int((b.timeIntervalSince(a) / 86_400).rounded())
    }
}
