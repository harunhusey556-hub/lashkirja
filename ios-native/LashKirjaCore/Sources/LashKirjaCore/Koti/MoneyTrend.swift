import Foundation

/// The trend line and the "+12 % vs. elokuu" line on Koti's money cards (`lib/koti-design.ts`
/// moneyTrend, `components/ds/charts` sparkGeometry).
public struct MoneyTrend: Equatable, Sendable {
    public enum Metric: Sendable { case income, expenses }

    /// Oldest first, the shown month last (with the card's own figure). Empty below two months.
    public let points: [Double]
    /// Against the previous month; nil when that month had nothing to compare with.
    public let percent: Int?
    public let previousMonth: String

    public static func make(rows: [Dashboard.CashflowMonth], month: String, source: String, metric: Metric, value: Decimal) -> MoneyTrend {
        let previousMonth = MonthKey.shift(month, by: -1)
        let history = rows.filter { $0.month <= month && $0.source == source }.sorted { $0.month < $1.month }
        func figure(_ row: Dashboard.CashflowMonth) -> Decimal { metric == .income ? row.income : row.expenses }
        let points = history.map { NSDecimalNumber(decimal: $0.month == month ? value : figure($0)).doubleValue }
        var percent: Int?
        if let previous = history.first(where: { $0.month == previousMonth }) {
            let base = NSDecimalNumber(decimal: figure(previous)).doubleValue
            if base > 0 {
                let change = (NSDecimalNumber(decimal: value).doubleValue - base) / base * 100 + 1e-8
                percent = Int((change + 0.5).rounded(.down)) // JavaScript Math.round
            }
        }
        return MoneyTrend(points: points.count > 1 ? points : [], percent: percent, previousMonth: previousMonth)
    }

    public struct Point: Equatable, Sendable { public let x: Double; public let y: Double }
    public struct Geometry: Equatable, Sendable { public let points: [Point] }

    /// Unit coordinates (0…1, y down) with the web's padding; a flat line sits in the middle.
    public static func geometry(_ values: [Double]) -> Geometry? {
        let clean = values.filter(\.isFinite)
        guard !clean.isEmpty else { return nil }
        guard clean.count > 1 else { return Geometry(points: [Point(x: 0.5, y: 0.5)]) }
        let lo = clean.min()!, hi = clean.max()!, span = hi - lo
        let padX = 0.03, padY = 0.14
        let points = clean.enumerated().map { index, value in
            Point(x: padX + Double(index) / Double(clean.count - 1) * (1 - padX * 2),
                  y: span > 0 ? padY + (1 - (value - lo) / span) * (1 - padY * 2) : 0.5)
        }
        return Geometry(points: points)
    }
}
