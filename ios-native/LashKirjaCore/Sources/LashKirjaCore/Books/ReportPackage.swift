import Foundation

/// The accountant package's periods for one year (Raportit's Kausi), keyed as
/// `GET /api/export/package?month=` reads them: "YYYY-MM", "YYYY-Qn" and "YYYY". Named as the rest
/// of the app names periods ('Syyskuu 2026', 'Q3 2026', 'Vuosi 2026'), not '09/2026' (X085).
public enum ReportPackage {
    public struct Option: Hashable, Sendable {
        public let key: String
        public let title: String
    }

    /// The twelve months, the four quarters, then the whole year.
    public static func options(year: Int) -> [Option] {
        let y = String(year)
        let months = (1...12).map { m -> Option in
            let key = String(format: "%@-%02d", y, m)
            return Option(key: key, title: "\(MonthKey.name(key)) \(y)")
        }
        let quarters = (1...4).map { q -> Option in
            let key = "\(y)-Q\(q)"
            return Option(key: key, title: VatPeriod.title(key))
        }
        return months + quarters + [Option(key: y, title: VatPeriod.title(y))]
    }
}
