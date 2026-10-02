import Foundation

/// ALV filing periods: "YYYY-MM", "YYYY-Qn" or "YYYY", following the owner's `vatPeriod`.
public enum VatPeriod {
    public static func key(for month: String, kind: String?) -> String {
        let year = String(month.prefix(4))
        let m = Int(month.suffix(2)) ?? 1
        switch kind {
        case "quarter": return "\(year)-Q\((m - 1) / 3 + 1)"
        case "year": return year
        default: return month
        }
    }

    /// The period before the one `month` falls in: the one that can be filed now.
    public static func previous(_ month: String, kind: String?) -> String {
        shift(key(for: month, kind: kind), by: -1)
    }

    public static func shift(_ key: String, by delta: Int) -> String {
        if key.count == 4, let y = Int(key) { return String(y + delta) }
        if key.contains("-Q"), let y = Int(key.prefix(4)), let q = Int(key.suffix(1)) {
            let index = y * 4 + (q - 1) + delta
            return "\(index / 4)-Q\(index % 4 + 1)"
        }
        return MonthKey.shift(key, by: delta)
    }

    public static func title(_ key: String) -> String {
        if key.count == 4 { return "Vuosi \(key)" }
        if key.contains("-Q") { return "\(key.suffix(2)) \(key.prefix(4))" }
        return MonthKey.title(key, currentYear: String(MonthKey.current().prefix(4)))
    }
}
