import Foundation

/// Where a report figure leads: the rows that make it up, as the web's report-drill links do
/// (`lib/report-drill.ts`). A figure is offered a destination only when that list holds rows for
/// it, so a tap never opens a list that says it is empty.
public enum ReportDrill: Hashable, Sendable {
    /// Kuitit of a year or month ("" = any), Tulot or Menot ("" = both), one category ("" = all).
    case receipts(period: String, tab: String, category: String)
    /// Kuitit of a year or month that have no VAT breakdown.
    case receiptsMissingVat(period: String)
    /// Myyntilaskut of a year or month ("" = any) on one status chip.
    case invoices(period: String, status: SalesFilter)
    /// Pankkitapahtumat of one month.
    case bankFeed(month: String)
    case purchaseInvoices

    /// The list's short name, for a figure that lives in more than one list.
    public var label: String {
        switch self {
        case .receipts(_, let tab, _): tab == "tulo" ? "Tulokuitit" : tab == "meno" ? "Menokuitit" : "Kuitit"
        case .receiptsMissingVat: "Kuitit"
        case .invoices(_, let status): status == .credited ? "Hyvityslaskut" : "Laskut"
        case .bankFeed: "Pankkitapahtumat"
        case .purchaseInvoices: "Ostolaskut"
        }
    }

    /// The category rows the profit and loss puts sales invoices and credit notes in.
    static let invoiceCategories: Set<String> = ["Myyntilaskut", "Hyvityslaskut"]

    public static func target(kind: ReportCategoryKind, category: String, year: String) -> ReportDrill {
        if kind == .income && category == "Myyntilaskut" { return .invoices(period: year, status: .all) }
        if kind == .income && category == "Hyvityslaskut" { return .invoices(period: year, status: .credited) }
        let tab = kind == .income ? "tulo" : "meno"
        return .receipts(period: year, tab: tab, category: category == "Luokittelematon" ? "" : category)
    }

    // MARK: Report periods (web `incomeDrillTargets`, `expenseDrillTarget`)

    /// Income lives in two lists: invoices (sales and credit notes are not receipts) and the
    /// cash-sale receipts. `key` is the period the lists filter by ("YYYY" or "YYYY-MM").
    public static func incomeTargets(_ period: ProfitLoss.Period, key: String) -> [ReportDrill] {
        let rows = period.incomeByCategory
        let invoiceRows = rows.filter { invoiceCategories.contains($0.category) }.reduce(0) { $0 + $1.count }
        let invoiceDocuments = max(period.invoiceCount + (period.creditNoteCount ?? 0), invoiceRows)
        let receiptRows = rows.filter { !invoiceCategories.contains($0.category) }.reduce(0) { $0 + $1.count }
        var targets: [ReportDrill] = []
        if invoiceDocuments > 0 { targets.append(.invoices(period: key, status: .all)) }
        if receiptRows > 0 { targets.append(.receipts(period: key, tab: "tulo", category: "")) }
        return targets
    }

    /// Expenses are receipts only.
    public static func expenseTarget(_ period: ProfitLoss.Period, key: String) -> ReportDrill? {
        period.expenseByCategory.reduce(0) { $0 + $1.count } == 0 ? nil : .receipts(period: key, tab: "meno", category: "")
    }

    /// Every list a month's result is made of: its income lists, then its expense receipts.
    public static func monthTargets(_ period: ProfitLoss.Period) -> [ReportDrill] {
        guard let key = period.month else { return [] }
        return incomeTargets(period, key: key) + [expenseTarget(period, key: key)].compactMap { $0 }
    }

    /// The month the Raportit chart selects first: the latest one with figures, else the last.
    public static func defaultMonth(_ months: [ProfitLoss.Period]) -> String? {
        months.last { $0.incomeNet != 0 || $0.expenseNet != 0 }?.month ?? months.last?.month
    }

    // MARK: Koti (web `DashboardClient` tulotHref / menotHref)

    /// Koti's Myynti and Kulut cards: on a bank-statement basis the month's bank rows; otherwise
    /// the month's invoices when it has any (sales are invoices), else its receipts.
    public static func koti(income: Bool, source: String, invoiceCount: Int, month: String) -> ReportDrill {
        if source == "tiliote" { return .bankFeed(month: month) }
        if income && invoiceCount > 0 { return .invoices(period: month, status: .all) }
        return .receipts(period: month, tab: income ? "tulo" : "meno", category: "")
    }

    // MARK: ALV (web `kirjanpito/alv` DrillRow, FP-12)

    /// The lists filter by a month or a whole year; a quarter has no list filter of its own.
    public static func alvScope(_ period: String) -> String {
        period.contains("Q") ? "" : period
    }

    /// Field 301: the invoices when sales were invoiced, else the sales receipts.
    public static func alvSales(_ report: AlvReport, period: String) -> ReportDrill {
        let scope = alvScope(period)
        return (report.sources?.invoiceCount ?? 0) > 0
            ? .invoices(period: scope, status: .all)
            : .receipts(period: scope, tab: "tulo", category: "")
    }

    /// "Myyntikuiteista": only when 301 is made of invoices and receipts both.
    public static func alvReceiptSales(_ report: AlvReport, period: String) -> ReportDrill? {
        guard let sources = report.sources, (sources.invoiceCount ?? 0) > 0, (sources.receiptSalesVat ?? 0) != 0 else { return nil }
        return .receipts(period: alvScope(period), tab: "tulo", category: "")
    }

    /// Field 307: the purchase receipts.
    public static func alvDeductible(period: String) -> ReportDrill {
        .receipts(period: alvScope(period), tab: "meno", category: "")
    }

    /// "Ostolaskuista": the part of 307 from purchase invoices, when there is one.
    public static func alvPurchases(_ report: AlvReport) -> ReportDrill? {
        (report.sources?.purchaseInvoiceCount ?? 0) > 0 ? .purchaseInvoices : nil
    }
}
