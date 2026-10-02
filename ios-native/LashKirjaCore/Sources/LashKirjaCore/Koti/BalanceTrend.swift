import Foundation

/// Koti's Rahatilanne card: the month-end bank balances, the words around the hero figure and
/// the chart's vertical range (web `components/charts/BalanceTrendCard.tsx` and `trend.ts`).
///
/// The hero is today's total; dragging across the line reads one month ("Syyskuun lopussa",
/// "−40,00 € edellisestä kuusta"), letting go returns to today.
public struct BalanceTrend: Equatable, Sendable {
    public struct Point: Equatable, Sendable, Identifiable {
        public let month: String
        public let balance: Decimal
        public var id: String { month }
        public var value: Double { NSDecimalNumber(decimal: balance).doubleValue }
        public init(month: String, balance: Decimal) {
            self.month = month
            self.balance = balance
        }
    }

    public enum Direction: Equatable, Sendable { case up, down, flat }

    /// Shown in the chart's place while there are fewer than two months to draw.
    public static let emptyText = "Saldon kehitys näkyy, kun tapahtumia on kahdelta kuukaudelta."

    /// Oldest first. Empty below two months: a lone dot says nothing about a trend.
    public let points: [Point]

    public init(points: [Point]) {
        let sorted = points.sorted { $0.month < $1.month }
        self.points = sorted.count >= 2 ? sorted : []
    }

    public init(_ trend: Dashboard.BankTrend?) {
        self.init(points: (trend?.points ?? []).map { Point(month: $0.month, balance: $0.balance) })
    }

    public var canDraw: Bool { !points.isEmpty }

    public func index(of month: String?) -> Int? {
        guard let month else { return nil }
        return points.firstIndex { $0.month == month }
    }

    /// The month-end balance against the one before it; nil for the first month.
    public func change(at index: Int) -> Decimal? {
        guard index > 0, index < points.count else { return nil }
        return points[index].balance - points[index - 1].balance
    }

    /// Since the end of last month: the newest point against the one before it.
    public var latestChange: Decimal? { change(at: points.count - 1) }

    /// The small line above the hero figure.
    public func caption(selected: String?, accountCount: Int, currentMonth: String) -> String {
        if let i = index(of: selected) {
            let month = points[i].month
            // The current month has no end yet: its point is the balance so far.
            return month >= currentMonth ? "\(MonthKey.name(month)) tähän mennessä" : "\(MonthKey.name(month))n lopussa"
        }
        return "Pankkitilien saldo · \(Koti.accounts(accountCount))"
    }

    /// Today's total, or the month being read.
    public func hero(selected: String?, total: Decimal) -> Decimal {
        index(of: selected).map { points[$0].balance } ?? total
    }

    /// The line under the hero figure: "+120,00 € syyskuun lopusta" for today, "−40,00 €
    /// edellisestä kuusta" while a month is read; nil when there is nothing to compare with.
    public func changeLine(selected: String?) -> String? {
        if let i = index(of: selected) {
            return change(at: i).map { "\(Self.signed($0)) edellisestä kuusta" }
        }
        guard let change = latestChange else { return nil }
        let previous = points[points.count - 2].month
        return "\(Self.signed(change)) \(MonthKey.name(previous).lowercased())n lopusta"
    }

    /// Which way the shown change points (the arrow and its colour).
    public func direction(selected: String?) -> Direction? {
        let amount = index(of: selected).map { change(at: $0) } ?? latestChange
        return amount.map(Self.direction)
    }

    /// The data's own range with air above and below, not zero-based: a balance moving between
    /// 10 000 € and 11 000 € must show its movement. A flat line sits in the middle.
    public var yDomain: ClosedRange<Double>? {
        let values = points.map(\.value).filter(\.isFinite)
        guard let lo = values.min(), let hi = values.max() else { return nil }
        let span = hi - lo
        let pad = span > 0 ? span * 0.16 : max(abs(hi) * 0.1, 1)
        return (lo - pad)...(hi + pad)
    }

    /// One sentence for VoiceOver: "Pankkitilien saldo huhtikuu–syyskuu: nousi 1 200,00 €, nyt 12 300,00 €."
    public func accessibilitySummary(total: Decimal) -> String {
        guard let first = points.first, let last = points.last else {
            return "Pankkitilien saldo \(Money.format(total))."
        }
        let amount = last.balance - first.balance
        let word: String
        switch Self.direction(amount) {
        case .flat: word = "pysyi ennallaan"
        case .up: word = "nousi \(Money.format(amount))"
        case .down: word = "laski \(Money.format(-amount))"
        }
        let span = "\(MonthKey.name(first.month).lowercased())–\(MonthKey.name(last.month).lowercased())"
        return "Pankkitilien saldo \(span): \(word), nyt \(Money.format(total))."
    }

    /// "+1 200,00 €", "−40,00 €", "±0,00 €" (a change, so zero gets its own sign).
    public static func signed(_ amount: Decimal) -> String {
        direction(amount) == .flat ? "±\(Money.format(0))" : Money.format(amount, signed: true)
    }

    static func direction(_ amount: Decimal) -> Direction {
        var value = amount
        var rounded = Decimal()
        NSDecimalRound(&rounded, &value, 2, .plain)
        return rounded > 0 ? .up : rounded < 0 ? .down : .flat
    }
}
