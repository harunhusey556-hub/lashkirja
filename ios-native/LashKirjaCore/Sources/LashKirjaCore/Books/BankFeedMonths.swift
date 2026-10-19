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

    /// The line under a month's name: its Tulot and Menot (`BankHub.totals`), and whether every
    /// row of the month is in (`monthComplete`).
    public struct MonthLine: Sendable, Equatable {
        public let totals: BankHub.MonthTotals
        public let complete: Bool
    }

    /// Every loaded month's line, in one pass over the rows. Pankki works it out when its rows or
    /// their paging change and the header only reads it: adding up every row in the header ran
    /// again on each update of the screen.
    public static func monthLines(_ statements: [Statement], months: [Month], hasMore: Bool) -> [String: MonthLine] {
        var totals: [String: BankHub.MonthTotals] = [:]
        for statement in statements {
            for row in statement.transactions {
                totals[BankHub.month(of: row, in: statement), default: BankHub.MonthTotals()].add(row)
            }
        }
        var lines: [String: MonthLine] = [:]
        for group in months {
            lines[group.month] = MonthLine(totals: totals[group.month] ?? BankHub.MonthTotals(),
                                           complete: monthComplete(group.month, in: months, hasMore: hasMore))
        }
        return lines
    }
}
