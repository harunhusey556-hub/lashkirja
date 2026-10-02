import Foundation

/// Raportit shows one category breakdown at a time (Tulot or Menot) behind a picker,
/// instead of two long lists stacked on a phone screen.
public enum ReportCategoryKind: String, CaseIterable, Sendable, Identifiable {
    case income, expense

    public var id: String { rawValue }
    public var title: String { self == .income ? "Tulot" : "Menot" }

    public func rows(_ period: ProfitLoss.Period) -> [ProfitLoss.Category] {
        self == .income ? period.incomeByCategory : period.expenseByCategory
    }

    /// The kinds that have rows; the picker is shown only when both do.
    public static func available(_ period: ProfitLoss.Period) -> [ReportCategoryKind] {
        allCases.filter { !$0.rows(period).isEmpty }
    }

    /// The owner's choice while it still has rows; otherwise Menot, where the categories
    /// are many and worth reading, then Tulot. Nil when the year has no categories at all.
    public static func resolve(_ choice: ReportCategoryKind?, in period: ProfitLoss.Period) -> ReportCategoryKind? {
        GroupChoice.pick(choice, available: available(period), preferred: .expense)
    }
}
