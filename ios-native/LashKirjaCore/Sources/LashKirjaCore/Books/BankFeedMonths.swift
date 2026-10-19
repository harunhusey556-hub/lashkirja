import Foundation

extension BankFeed {
    /// The month groups with only the rows "Vaatii toimia" and the search leave; empty months drop
    /// out, so the feed's month chips offer only months that have something to show.
    public static func shownMonths(_ months: [Month], onlyOpen: Bool, search: String) -> [Month] {
        let needle = search.trimmingCharacters(in: .whitespaces)
        return months.compactMap { group in
            let rows = group.rows.filter { row in
                (!onlyOpen || needsAction(row)) && (needle.isEmpty || row.title.localizedCaseInsensitiveContains(needle))
            }
            return rows.isEmpty ? nil : Month(month: group.month, rows: rows, open: group.open)
        }
    }

    /// Every row of `month` is loaded, so its Tulot and Menot can be told: no page is left, or the
    /// loaded rows already reach an older month (the server pages by date, newest first). Undated
    /// rows ("") have no place in that order and wait for the last page.
    public static func monthComplete(_ month: String, in months: [Month], hasMore: Bool) -> Bool {
        guard hasMore else { return true }
        guard !month.isEmpty else { return false }
        return months.contains { !$0.month.isEmpty && $0.month < month }
    }
}
