import Foundation

/// "YYYY-MM" month keys and their Finnish names.
public enum MonthKey {
    public static let names = ["Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu",
                               "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu"]
    private static let shortNames = ["Tam", "Hel", "Maa", "Huh", "Tou", "Kes", "Hei", "Elo", "Syy", "Lok", "Mar", "Jou"]

    private static func parts(_ key: String) -> (year: Int, month: Int)? {
        let bits = key.split(separator: "-")
        guard bits.count == 2, let y = Int(bits[0]), let m = Int(bits[1]), (1...12).contains(m) else { return nil }
        return (y, m)
    }

    public static func shift(_ key: String, by months: Int) -> String {
        guard let (y, m) = parts(key) else { return key }
        let index = y * 12 + (m - 1) + months
        return String(format: "%04d-%02d", index / 12, index % 12 + 1)
    }

    public static func name(_ key: String) -> String {
        guard let (_, m) = parts(key) else { return key }
        return names[m - 1]
    }

    public static func short(_ key: String) -> String {
        guard let (_, m) = parts(key) else { return key }
        return shortNames[m - 1]
    }

    /// "Lokakuu" this year, "Maaliskuu 2025" otherwise.
    public static func title(_ key: String, currentYear: String) -> String {
        guard let (y, _) = parts(key) else { return key }
        return String(y) == currentYear ? name(key) : "\(name(key)) \(y)"
    }

    public static func current(_ now: Date = Date()) -> String { APIDate.month(now) }
}
