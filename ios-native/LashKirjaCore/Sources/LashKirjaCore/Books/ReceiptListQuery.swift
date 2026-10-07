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

/// The web's Lähde filter (`receipt-filters.ts`).
public enum ReceiptSourceFilter: String, CaseIterable, Sendable, Identifiable {
    case all = "", ai, ocr, manual
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .all: "Kaikki"
        case .ai: "AI"
        case .ocr: "OCR"
        case .manual: "Manuaalinen"
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
    public var source: ReceiptSourceFilter = .all
    /// Euros as typed ("12,50"); empty for no limit.
    public var minAmount = ""
    public var maxAmount = ""
    /// Only receipts with no VAT breakdown (Raportit's "Ilman ALV-erittelyä"); never remembered.
    public var missingVat = false

    public init() {}

    private static func amount(_ text: String) -> Decimal?? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return .some(nil) }
        guard let value = ReceiptAmount.parse(clean), value >= 0 else { return nil }
        return .some(value)
    }

    /// The server's own refusals (`Virheellinen summa`, `Summarajaus on virheellinen`), checked first.
    public var amountError: String? {
        guard let min = Self.amount(minAmount), let max = Self.amount(maxAmount) else { return "Virheellinen summa" }
        if let min, let max, min > max { return "Summarajaus on virheellinen" }
        return nil
    }

    /// "12,50–1 000 €", as the web's filter chip.
    public var amountLabel: String? {
        guard !minAmount.isEmpty || !maxAmount.isEmpty else { return nil }
        let min = minAmount.trimmingCharacters(in: .whitespaces)
        let max = maxAmount.trimmingCharacters(in: .whitespaces)
        return "\(min.isEmpty ? "0" : min)–\(max.isEmpty ? "∞" : max) €"
    }

    private var trimmedSearch: String { String(search.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100)) }

    /// The month/search/category scope shared by the list and the tab counts.
    public func countsQuery() -> [String: String] {
        var q: [String: String] = [:]
        if !trimmedSearch.isEmpty { q["q"] = trimmedSearch }
        if !month.isEmpty { q["month"] = month }
        if !category.isEmpty { q["category"] = category }
        if source != .all { q["source"] = source.rawValue }
        // Sent as plain numbers: the server reads Number(...), which a comma would break.
        if case let value?? = Self.amount(minAmount) { q["minAmount"] = NSDecimalNumber(decimal: value).stringValue }
        if case let value?? = Self.amount(maxAmount) { q["maxAmount"] = NSDecimalNumber(decimal: value).stringValue }
        if missingVat { q["vat"] = "missing" }
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
    public var isFiltered: Bool {
        !trimmedSearch.isEmpty || !month.isEmpty || !category.isEmpty || tab != .all
            || source != .all || !minAmount.isEmpty || !maxAmount.isEmpty || missingVat
    }
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

    /// Bank amount minus receipt total when they disagree by more than a fee
    /// (2 € or 0,5 %, as `linkAmountGapCents` in lib/fee-tolerance.ts); nil otherwise.
    public static func amountGap(bank: Decimal, receiptTotal: Decimal?) -> Decimal? {
        guard let receiptTotal else { return nil }
        let paid = abs(bank), booked = abs(receiptTotal)
        let diff = paid - booked
        var ratio = booked * Decimal(string: "0.005")!
        var rounded = Decimal()
        NSDecimalRound(&rounded, &ratio, 2, .plain)
        let tolerance = max(Decimal(2), rounded)
        return abs(diff) > tolerance ? diff : nil
    }

    /// "Kohdistettu · summa poikkeaa 1 521,46 €"
    public static func gapTitle(_ gap: Decimal) -> String { "Kohdistettu · summa poikkeaa \(Money.format(abs(gap)))" }
}

// MARK: Kept between visits

extension ReceiptListQuery {
    /// Month, tab, category, source and sort as one stored string (search and
    /// amount limits are not kept). Empty when nothing differs from the defaults.
    public var remembered: String {
        var items: [(String, String)] = []
        if !month.isEmpty { items.append(("month", month)) }
        if tab != .all { items.append(("tab", tab.rawValue)) }
        if !category.isEmpty { items.append(("category", category)) }
        if source != .all { items.append(("source", source.rawValue)) }
        if sort != .dateDesc { items.append(("sort", sort.rawValue)) }
        return items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }.joined(separator: "&")
    }

    /// The filters stored by `remembered`; anything unknown keeps its default.
    public init(remembered: String) {
        self.init()
        for pair in remembered.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard parts.count == 2, let value = String(parts[1]).removingPercentEncoding else { continue }
            switch String(parts[0]) {
            case "month":
                if value.range(of: #"^\d{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil { month = value }
            case "tab": tab = ReceiptTab(rawValue: value) ?? .all
            case "category": category = value
            case "source": source = ReceiptSourceFilter(rawValue: value) ?? .all
            case "sort": sort = ReceiptSort(rawValue: value) ?? .dateDesc
            default: break
            }
        }
    }
}
