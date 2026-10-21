import Foundation

/// The tabs of the kuitit list (`lib/receipt-tabs.ts`): five mutually exclusive ones over the kuitit,
/// and "Laskut", the bills filed as ostolaskut, which the other five leave out.
public enum ReceiptTab: String, CaseIterable, Sendable, Identifiable {
    case all, tulo, meno, linked, unlinked, laskut
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "Kaikki"
        case .tulo: "Tulot"
        case .meno: "Menot"
        case .linked: "Kohdistettu"
        case .unlinked: "Ei kohdistettu"
        case .laskut: "Laskut"
        }
    }

    public func count(in counts: ReceiptCounts.Counts) -> Int {
        switch self {
        case .all: counts.all
        case .tulo: counts.tulo
        case .meno: counts.meno
        case .linked: counts.linked
        case .unlinked: counts.unlinked
        case .laskut: counts.laskut ?? 0
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
    /// A figure's list: every document the figure counts, the bills filed as ostolaskut too (no
    /// `kind`). Raportit's Menot counted 35 and its list showed 34 kuittia (X079); never remembered.
    public var drill = false

    public init() {}

    /// The list a link opens on (a report figure, a month, a tab): exactly its filters, nothing remembered.
    public static func drilled(month: String = "", tab: ReceiptTab = .all, category: String = "", missingVat: Bool = false) -> ReceiptListQuery {
        var query = ReceiptListQuery()
        query.month = month
        query.tab = tab
        query.category = category
        query.missingVat = missingVat
        query.drill = true
        return query
    }

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

    /// The month/search/category scope shared by the list and the tab counts. Kuitit counts the
    /// kuitit (`kind=receipt`), a drill every document; the Laskut chip's own number comes back in
    /// the same answer.
    public func countsQuery() -> [String: String] {
        var q: [String: String] = drill ? [:] : ["kind": "receipt"]
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
        // The Laskut chip lists the bills filed as ostolaskut instead of the kuitit.
        case .laskut: q["kind"] = "invoice"
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

    /// The review queue on top of the list (`reviewStatus=pending`): kuitit only, as the web's;
    /// a bill filed as an ostolasku is not waiting here for approval.
    public static func pendingQueue(offset: Int = 0) -> [String: String] {
        var q = ["reviewStatus": "pending", "kind": "receipt"]
        if offset > 0 { q["offset"] = String(offset) }
        return q
    }

    /// The rejected receipts under the review queue (F38), 200 at a time.
    public static func rejectedQueue(offset: Int = 0) -> [String: String] {
        var q = ["reviewStatus": "rejected"]
        if offset > 0 { q["offset"] = String(offset) }
        return q
    }

    /// The count behind "N odottaa" on the Kirjanpito hub: the same queue, counted.
    public static let pendingCountQuery = ["reviewStatus": "pending", "kind": "receipt"]

    /// The empty list's sentence; the Laskut chip talks about laskut.
    public var emptyText: String {
        let narrowed = !trimmedSearch.isEmpty || !month.isEmpty || !category.isEmpty
            || source != .all || !minAmount.isEmpty || !maxAmount.isEmpty || missingVat
        if tab == .laskut { return narrowed ? "Ei hakua vastaavia laskuja." : "Ei laskuja." }
        return isFiltered ? "Ei hakua vastaavia kuitteja." : "Ei kuitteja."
    }

    /// The header over the rows: "12 kuittia", "3 laskua".
    public func countHeader(_ total: Int) -> String {
        if tab == .laskut { return total == 1 ? "1 lasku" : "\(total) laskua" }
        return "\(total) kuittia"
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

    /// A bank row's second line on the receipt: the server's Finnish reasons in the words of
    /// "Valitse pankkitapahtuma" ("Miksi: summa sama · veloitettu 1 päivä oston jälkeen", X039);
    /// from a server without them, the codes and the score ("summa, myyjä · 90 %").
    public static func detail(_ tx: Receipt.LinkedTransaction) -> String {
        if let why = BankMatchText.why(tx.explanation ?? []) { return why }
        let words = Self.reasons(tx.bestReasons)
        let score = Self.percent(tx.bestScore)
        return words.isEmpty ? score : "\(words) · \(score)"
    }

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

// MARK: Pages

/// Kuitit a page at a time: 50 rows by `?cursor=` from a server that pages, otherwise 200 rows
/// by `offset` while the server says `truncated` (an older server ignores `cursor` and `limit`).
public struct ReceiptListPaging: Sendable, Equatable {
    public private(set) var cursor = CursorPaging()
    /// An older server's "more rows after these" (offset paging).
    public private(set) var truncated = false

    public init() {}

    public var hasMore: Bool { cursor.hasMore || truncated }

    /// The first page's query. A reload asks for as many rows as were loaded (up to 200), so
    /// acting on a row deep in the list does not fold it back to 50; a first visit asks for 50,
    /// the same query the launch prefetch fills the cache with. Only the newest-first order pages
    /// by cursor (a paging server refuses another sort with 400): any other sort keeps the
    /// older 200-row pages by offset.
    public static func firstQuery(_ query: ReceiptListQuery, loadedRows: Int = 0) -> [String: String] {
        guard pagesByCursor(query) else { return query.listQuery() }
        return CursorPaging.firstQuery(query.listQuery(), loadedRows: loadedRows)
    }

    public static func pagesByCursor(_ query: ReceiptListQuery) -> Bool { query.sort == .dateDesc }

    public mutating func firstPage(_ list: ReceiptList) {
        cursor.firstPage(next: list.nextCursor)
        truncated = list.nextCursor == nil && (list.truncated ?? false)
    }

    /// The query of the page after `loaded` rows; nil when there is none.
    public func nextQuery(_ query: ReceiptListQuery, loaded: Int) -> [String: String]? {
        if let next = cursor.nextQuery(query.listQuery()) { return next }
        if truncated { return query.listQuery(offset: loaded) }
        return nil
    }

    public mutating func nextPage(_ list: ReceiptList) {
        if cursor.hasMore {
            cursor.nextPage(next: list.nextCursor)
            truncated = false
        } else {
            truncated = list.truncated ?? false
        }
    }

    /// The header's number: the server's count, else the tab's count, else the rows loaded.
    public static func total(_ list: ReceiptList, tab: ReceiptTab, counts: ReceiptCounts.Counts?) -> Int {
        if let count = list.count { return count }
        if let counts, tab != .laskut || counts.laskut != nil { return tab.count(in: counts) }
        return list.receipts.count
    }
}

/// A Kuitit row's words, made once per row instead of on every redraw (the date formatter is the
/// costly part). Equatable, so a row whose words did not change is not drawn again.
public struct ReceiptRowText: Sendable, Equatable {
    public let title: String
    /// "12.10.2026 · Ruoka ja juoma"
    public let detail: String
    public let amount: Decimal?
    public let isIncome: Bool
    public let linked: Bool
    /// "Ostolasku" on a bill filed as one, nil on a kuitti.
    public let kindTag: String?

    public init(_ receipt: Receipt) {
        title = receipt.title
        detail = [receipt.date.map(APIDate.displayDay), receipt.category.map(ReceiptCategory.label(for:))]
            .compactMap { $0 }.joined(separator: " · ")
        amount = receipt.totalAmount
        isIncome = receipt.isIncome
        // W27: a bill paid from the bank through its ostolasku shows the link mark too.
        linked = receipt.isBankMatched
        // A figure's list (`drill`) shows the bills among the kuitit, so a bill says what it is (X079).
        kindTag = receipt.kind == .invoice ? ReceiptDocumentKind.invoice.title : nil
    }
}

/// One sign for one figure on every screen (X001 X038 X068 X080): money out reads −9,43 €, money
/// back reads 50,00 €. A receipt's booked total is turned the way the Kuitit row turns it: a meno
/// total is negated, so a credit note's negative meno total reads as the refund it is.
public enum MoneyDirection {
    public static func receiptAmount(_ total: Decimal, isIncome: Bool) -> Decimal {
        isIncome ? total : -total
    }

    /// A bank row the API sends without its sign (the bank row pickers). The caller knows the
    /// direction: the picker is shared with purchase invoices, whose payments are money out.
    public static func rowAmount(_ amount: Decimal, moneyIn: Bool) -> Decimal {
        moneyIn ? abs(amount) : -abs(amount)
    }
}

extension Receipt {
    /// The total with its cash sign (`MoneyDirection`); nil without a total.
    public var shownAmount: Decimal? { totalAmount.map { MoneyDirection.receiptAmount($0, isIncome: isIncome) } }

    /// Its bank row brings money in: a tulo, or a meno credit note's refund (the server's
    /// `receiptDirection`, which picks the rows the bank row picker lists).
    public var bankMoneyIn: Bool {
        guard let shown = shownAmount, shown != 0 else { return isIncome }
        return shown > 0
    }
}
