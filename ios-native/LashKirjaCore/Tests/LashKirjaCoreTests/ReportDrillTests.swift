import Testing
@testable import LashKirjaCore

@Test func aReportCategoryOpensTheRowsBehindIt() {
    #expect(ReportDrill.target(kind: .expense, category: "tarvikkeet", year: "2026") == .receipts(period: "2026", tab: "meno", category: "tarvikkeet"))
    #expect(ReportDrill.target(kind: .income, category: "muut_tulot", year: "2026") == .receipts(period: "2026", tab: "tulo", category: "muut_tulot"))
    // Sales and credit notes are invoices, not receipts (as the web links them).
    #expect(ReportDrill.target(kind: .income, category: "Myyntilaskut", year: "2026") == .invoices)
    #expect(ReportDrill.target(kind: .income, category: "Hyvityslaskut", year: "2026") == .invoices)
    // Uncategorised has no category to filter by: the year's receipts of that kind.
    #expect(ReportDrill.target(kind: .expense, category: "Luokittelematon", year: "2026") == .receipts(period: "2026", tab: "meno", category: ""))
}
