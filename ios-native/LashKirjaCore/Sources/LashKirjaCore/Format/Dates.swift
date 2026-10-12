import Foundation

/// Server dates are "YYYY-MM-DD" and months "YYYY-MM", in Helsinki time.
public enum APIDate {
    private static let zone = TimeZone(identifier: "Europe/Helsinki")!

    /// Built once per format and used under a lock: rows format dates on every render, and a
    /// DateFormatter costs far more to build than to use.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var formatters: [String: DateFormatter] = [:]

    private static func with<T>(_ format: String, _ use: (DateFormatter) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        if let f = formatters[format] { return use(f) }
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = format
        f.isLenient = false
        formatters[format] = f
        return use(f)
    }

    public static func day(_ s: String) -> Date? {
        with("yyyy-MM-dd") { f in
            guard let date = f.date(from: s), f.string(from: date) == s else { return nil }
            return date
        }
    }

    public static func dayString(_ d: Date) -> String { with("yyyy-MM-dd") { $0.string(from: d) } }
    public static func month(_ d: Date) -> String { with("yyyy-MM") { $0.string(from: d) } }

    /// A calendar day as the Date a DatePicker shows on that same day. The picker draws its
    /// selection in the device zone, so Helsinki midnight from `day` showed 13.10 as 12.10 on any
    /// device west of Helsinki. Noon, because some zones skip midnight on a DST change.
    public static func pickerDate(_ s: String, in zone: TimeZone = .current) -> Date? {
        guard day(s) != nil else { return nil }
        let parts = s.split(separator: "-").compactMap { Int($0) }
        return calendar(zone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    /// The calendar day a DatePicker selection shows, as "YYYY-MM-DD", with no zone conversion.
    public static func pickerDay(_ d: Date, in zone: TimeZone = .current) -> String {
        let c = calendar(zone).dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func calendar(_ zone: TimeZone) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        return c
    }

    /// "2.10.2026", the Finnish short date. Takes "YYYY-MM-DD" or an ISO timestamp.
    public static func displayDay(_ s: String) -> String {
        guard let d = day(String(s.prefix(10))) else { return s }
        return with("d.M.yyyy") { $0.string(from: d) }
    }

    /// "2.10.2026 klo 12.05" in Helsinki time, from a server timestamp (with or without fractions).
    public static func timestamp(_ iso: String) -> String {
        lock.lock()
        let date = isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
        lock.unlock()
        guard let date else { return iso }
        return with("d.M.yyyy 'klo' H.mm") { $0.string(from: date) }
    }

    /// A server timestamp as a date (with or without fractions).
    public static func instant(_ iso: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        return isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
    }

    nonisolated(unsafe) private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoPlain = ISO8601DateFormatter()

    /// "2026-10" from a day or a timestamp.
    public static func monthOf(_ s: String) -> String { String(s.prefix(7)) }
}
