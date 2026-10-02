import Foundation

/// Server dates are "YYYY-MM-DD" and months "YYYY-MM", in Helsinki time.
public enum APIDate {
    private static let zone = TimeZone(identifier: "Europe/Helsinki")!

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = format
        f.isLenient = false
        return f
    }

    public static func day(_ s: String) -> Date? {
        let f = formatter("yyyy-MM-dd")
        guard let date = f.date(from: s), f.string(from: date) == s else { return nil }
        return date
    }

    public static func dayString(_ d: Date) -> String { formatter("yyyy-MM-dd").string(from: d) }
    public static func month(_ d: Date) -> String { formatter("yyyy-MM").string(from: d) }

    /// "2.10.2026", the Finnish short date.
    public static func displayDay(_ s: String) -> String {
        guard let d = day(s) else { return s }
        return formatter("d.M.yyyy").string(from: d)
    }
}
