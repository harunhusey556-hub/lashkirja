import Foundation

extension JobsQueue {
    /// Failed background jobs (a read, a bank fetch, an email check) still on the list.
    public static func failedCount(_ jobs: [BackgroundJob]) -> Int {
        jobs.filter { $0.status == "failed" }.count
    }

    /// Koti's "Tuonnit ja virheet" row: "1 tuonti tai haku epäonnistui".
    public static func failedSummary(_ count: Int) -> String {
        count == 1 ? "1 tuonti tai haku epäonnistui" : "\(count) tuontia tai hakua epäonnistui"
    }
}

extension PeriodClose {
    /// The month "Kuukauden sulku" opens on: the asked one (from Koti), never past this month;
    /// none or an unreadable one opens on last month.
    public static func startMonth(_ requested: String?, current: String) -> String {
        guard let requested, isMonthKey(requested) else { return defaultMonth(current: current) }
        return min(requested, current)
    }

    static func isMonthKey(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
              parts[0].allSatisfy(\.isNumber), let m = Int(parts[1]) else { return false }
        return (1...12).contains(m)
    }
}

extension BankFeed {
    /// The bulk action that confirms every ready receipt suggestion.
    public static func confirmAllLabel(_ count: Int) -> String { "Hyväksy kuittiehdotukset (\(count))" }
}
