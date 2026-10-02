/// Where a report figure leads: the rows that make it up, as the web's report-drill links do.
public enum ReportDrill: Equatable, Sendable {
    case receipts(period: String, tab: String, category: String)
    case invoices

    public static func target(kind: ReportCategoryKind, category: String, year: String) -> ReportDrill {
        if kind == .income && (category == "Myyntilaskut" || category == "Hyvityslaskut") { return .invoices }
        let tab = kind == .income ? "tulo" : "meno"
        return .receipts(period: year, tab: tab, category: category == "Luokittelematon" ? "" : category)
    }
}
