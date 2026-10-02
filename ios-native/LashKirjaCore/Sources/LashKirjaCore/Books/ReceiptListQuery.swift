import Foundation

/// The five mutually exclusive tabs of the kuitit list (`lib/receipt-tabs.ts`).
public enum ReceiptTab: String, CaseIterable, Sendable, Identifiable {
    case all, tulo, meno, linked, unlinked
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "Kaikki"
        case .tulo: "Tulot"
        case .meno: "Menot"
        case .linked: "Kohdistettu"
        case .unlinked: "Ei kohdistettu"
        }
    }

    public func count(in counts: ReceiptCounts.Counts) -> Int {
        switch self {
        case .all: counts.all
        case .tulo: counts.tulo
        case .meno: counts.meno
        case .linked: counts.linked
        case .unlinked: counts.unlinked
        }
    }
}

/// "Järjestys" of the kuitit list.
public enum ReceiptSort: String, CaseIterable, Sendable, Identifiable {
    case dateDesc = "date_desc", dateAsc = "date_asc", amountDesc = "amount_desc", amountAsc = "amount_asc", createdDesc = "created_desc"
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .dateDesc: "Päivä (uusin)"
        case .dateAsc: "Päivä (vanhin)"
        case .amountDesc: "Summa (suurin)"
        case .amountAsc: "Summa (pienin)"
        case .createdDesc: "Lisätty (uusin)"
        }
    }
}

/// The filters of the kuitit list as `GET /api/receipts` and `/api/receipts/counts` read them.
public struct ReceiptListQuery: Sendable, Equatable, Hashable {
    public var search = ""
    /// "YYYY-MM", or empty for every month.
    public var month = ""
    public var tab: ReceiptTab = .all
    /// A category id, or empty for all.
    public var category = ""
    public var sort: ReceiptSort = .dateDesc

    public init() {}

    private var trimmedSearch: String { String(search.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100)) }

    /// The month/search/category scope shared by the list and the tab counts.
    public func countsQuery() -> [String: String] {
        var q: [String: String] = [:]
        if !trimmedSearch.isEmpty { q["q"] = trimmedSearch }
        if !month.isEmpty { q["month"] = month }
        if !category.isEmpty { q["category"] = category }
        return q
    }

    /// The list query; the server returns at most 200 rows from `offset`.
    public func listQuery(offset: Int = 0) -> [String: String] {
        var q = countsQuery()
        switch tab {
        case .tulo, .meno: q["type"] = tab.rawValue
        case .linked, .unlinked: q["linkedStatus"] = tab.rawValue
        case .all: break
        }
        q["sort"] = sort.rawValue
        if offset > 0 { q["offset"] = String(offset) }
        return q
    }

    /// True when anything narrows the list (the empty text then says "no matches", not "no receipts").
    public var isFiltered: Bool { !trimmedSearch.isEmpty || !month.isEmpty || !category.isEmpty || tab != .all }
}

public enum ReceiptPaging {
    /// The next page after the loaded rows; a row that moved between pages is not shown twice.
    public static func append(_ loaded: [Receipt], _ page: [Receipt]) -> [Receipt] {
        var seen = Set(loaded.map(\.id))
        return loaded + page.filter { seen.insert($0.id).inserted }
    }
}

/// The words of the match panel (`components/ReceiptMatchPanel.tsx`).
public enum ReceiptMatchText {
    private static let labels = [
        "viite": "viite", "amount": "summa", "vendor": "myyjä", "date": "päivä",
        "manual": "kohdistettu käsin", "auto_income": "tulo tiliotteelta", "approved": "hyväksytty",
    ]

    /// "summa, myyjä"; an unknown server code is never shown raw.
    public static func reasons(_ codes: [String]?) -> String {
        (codes ?? []).compactMap { labels[$0] }.joined(separator: ", ")
    }

    public static func isStrong(score: Double?, reasons: [String]?) -> Bool {
        if let score, score >= 0.85 { return true }
        let r = reasons ?? []
        return r.contains("viite") && r.contains("amount")
    }

    /// "90 %"
    public static func percent(_ score: Double?) -> String { "\(Int(((score ?? 0) * 100).rounded())) %" }
}
