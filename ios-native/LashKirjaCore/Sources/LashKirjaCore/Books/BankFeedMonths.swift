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
}
