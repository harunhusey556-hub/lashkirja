import Foundation

/// A list the server hands out a page at a time (`?cursor=`, 50 rows): where the next page starts.
/// A server that does not page answers without a cursor, and the first page is then the whole list.
public struct CursorPaging: Sendable, Equatable {
    public private(set) var nextCursor: String?
    /// Cursors already asked for: a server that hands one back again ends the paging instead of
    /// making the screen ask for the same page forever.
    private var asked: Set<String> = []

    public init() {}

    public var hasMore: Bool { nextCursor != nil }

    /// The server's page: 50 rows, at most 200 in one answer.
    public static let pageSize = 50
    public static let maxPage = 200

    /// The first page's query: `cursor` empty asks a paging server for pages (an older server
    /// ignores it and answers the whole list). A reload asks for as many rows as were loaded
    /// (up to 200), so acting on a row deep in the list does not fold the list back to 50.
    public static func firstQuery(_ base: [String: String] = [:], loadedRows: Int = 0) -> [String: String] {
        var query = base
        query["cursor"] = ""
        query["limit"] = String(min(max(loadedRows, pageSize), maxPage))
        return query
    }

    /// The first page arrived (a load or a refresh): paging starts over from its cursor.
    public mutating func firstPage(next: String?) {
        asked = []
        nextCursor = Self.clean(next)
    }

    /// The page `nextCursor` pointed at arrived with the cursor after it.
    public mutating func nextPage(next: String?) {
        if let current = nextCursor { asked.insert(current) }
        nextCursor = Self.clean(next).flatMap { asked.contains($0) ? nil : $0 }
    }

    /// The query of the page after the loaded ones; nil when there is none.
    public func nextQuery(_ base: [String: String] = [:]) -> [String: String]? {
        guard let cursor = nextCursor else { return nil }
        var query = base
        query["cursor"] = cursor
        return query
    }

    private static func clean(_ cursor: String?) -> String? {
        guard let cursor, !cursor.isEmpty else { return nil }
        return cursor
    }
}

/// Merging pages of the statement list. A page may carry more rows of a statement already shown
/// (the server pages rows, not files): they join that statement, and a row is never shown twice.
public enum StatementPaging {
    public static func merge(_ loaded: [Statement], _ page: [Statement]) -> [Statement] {
        var result = loaded
        var index: [String: Int] = [:]
        for (position, statement) in result.enumerated() { index[statement.id] = position }
        var seenRows = Set(result.flatMap { $0.transactions.map(\.id) })
        for statement in page {
            let added = statement.transactions.filter { seenRows.insert($0.id).inserted }
            if let position = index[statement.id] {
                guard !added.isEmpty else { continue }
                let existing = result[position]
                result[position] = existing.replacingTransactions(existing.transactions + added)
            } else {
                index[statement.id] = result.count
                result.append(statement.replacingTransactions(added))
            }
        }
        return result
    }
}

extension StatementPaging {
    /// A page of feed rows as statements: one per `statementId`, in the order rows arrive, with
    /// the month and account the server filed it under.
    static func group(_ rows: [PagedFeedRow]) -> [Statement] {
        var order: [String] = []
        var byId: [String: (periodMonth: String?, bankAccountId: String?, rows: [BankTransaction])] = [:]
        for item in rows {
            let id = item.row.statementId
            if byId[id] == nil {
                order.append(id)
                byId[id] = (periodMonth: item.periodMonth, bankAccountId: item.bankAccountId, rows: [])
            }
            byId[id]?.rows.append(item.row)
        }
        return order.compactMap { id in
            guard let entry = byId[id] else { return nil }
            let account = entry.bankAccountId.map { Statement.Account(id: $0, name: "", bankName: nil, iban: nil, currency: nil) }
            return Statement(id: id, fileName: "", fileType: nil, periodMonth: entry.periodMonth, uploadedAt: "",
                             bankAccount: account, transactions: entry.rows, totals: nil)
        }
    }
}

extension Statement {
    func replacingTransactions(_ rows: [BankTransaction]) -> Statement {
        Statement(id: id, fileName: fileName, fileType: fileType, periodMonth: periodMonth, uploadedAt: uploadedAt,
                  bankAccount: bankAccount, transactions: rows, totals: totals)
    }
}
