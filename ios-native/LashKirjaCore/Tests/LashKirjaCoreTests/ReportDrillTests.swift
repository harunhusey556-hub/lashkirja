import Testing
import Foundation
@testable import LashKirjaCore

@Test func aReportCategoryOpensTheRowsBehindIt() {
    #expect(ReportDrill.target(kind: .expense, category: "tarvikkeet", year: "2026") == .receipts(period: "2026", tab: "meno", category: "tarvikkeet"))
    #expect(ReportDrill.target(kind: .income, category: "muut_tulot", year: "2026") == .receipts(period: "2026", tab: "tulo", category: "muut_tulot"))
    // Sales and credit notes are invoices of that year, credit notes on their own chip (as the web links them).
    #expect(ReportDrill.target(kind: .income, category: "Myyntilaskut", year: "2026") == .invoices(period: "2026", status: .all))
    #expect(ReportDrill.target(kind: .income, category: "Hyvityslaskut", year: "2026") == .invoices(period: "2026", status: .credited))
    // Uncategorised has no category to filter by: the year's receipts of that kind.
    #expect(ReportDrill.target(kind: .expense, category: "Luokittelematon", year: "2026") == .receipts(period: "2026", tab: "meno", category: ""))
}

private func row(_ name: String, count: Int) -> ProfitLoss.Category {
    ProfitLoss.Category(category: name, gross: 0, vat: 0, net: 0, count: count)
}

private func period(_ month: String?, income: [ProfitLoss.Category] = [], expense: [ProfitLoss.Category] = [],
                    invoices: Int = 0, creditNotes: Int? = 0, incomeNet: Decimal = 0, expenseNet: Decimal = 0) -> ProfitLoss.Period {
    ProfitLoss.Period(month: month, incomeNet: incomeNet, incomeVat: 0, incomeGross: 0, expenseNet: expenseNet, expenseVat: 0,
                      expenseGross: 0, profitNet: incomeNet - expenseNet, incomeByCategory: income, expenseByCategory: expense,
                      receiptCount: 0, invoiceCount: invoices, creditNoteCount: creditNotes)
}

@Test func reportIncomeOpensEveryListItLivesIn() {
    // Invoiced sales and cash-sale receipts: two labelled destinations.
    let both = period("2026-09", income: [row("Myyntilaskut", count: 3), row("muut_tulot", count: 2)], invoices: 3)
    #expect(ReportDrill.incomeTargets(both, key: "2026-09") == [.invoices(period: "2026-09", status: .all), .receipts(period: "2026-09", tab: "tulo", category: "")])
    #expect(ReportDrill.incomeTargets(both, key: "2026-09").map(\.label) == ["Laskut", "Tulokuitit"])
    // A month of credit notes only still opens the invoices.
    let credits = period("2026-08", income: [row("Hyvityslaskut", count: 1)], creditNotes: 1)
    #expect(ReportDrill.incomeTargets(credits, key: "2026-08") == [.invoices(period: "2026-08", status: .all)])
    // An older server without the credit-note count: the category rows still count.
    let legacy = period("2026-07", income: [row("Hyvityslaskut", count: 1)], creditNotes: nil)
    #expect(ReportDrill.incomeTargets(legacy, key: "2026-07") == [.invoices(period: "2026-07", status: .all)])
    // Nothing behind the figure, no link.
    #expect(ReportDrill.incomeTargets(period("2026-06"), key: "2026-06").isEmpty)
}

@Test func reportExpensesAreReceiptsOnly() {
    #expect(ReportDrill.expenseTarget(period("2026-09", expense: [row("tarvikkeet", count: 4)]), key: "2026") == .receipts(period: "2026", tab: "meno", category: ""))
    #expect(ReportDrill.expenseTarget(period("2026-09"), key: "2026") == nil)
    let month = period("2026-09", income: [row("muut_tulot", count: 1)], expense: [row("vuokra", count: 1)])
    #expect(ReportDrill.monthTargets(month).map(\.label) == ["Tulokuitit", "Menokuitit"])
    #expect(ReportDrill.monthTargets(period(nil, expense: [row("vuokra", count: 1)])).isEmpty)
}

@Test func reportChartSelectsTheLatestMonthWithFigures() {
    let months = [period("2026-01", incomeNet: 10), period("2026-02", expenseNet: 5), period("2026-03")]
    #expect(ReportDrill.defaultMonth(months) == "2026-02")
    #expect(ReportDrill.defaultMonth([period("2026-01"), period("2026-02")]) == "2026-02")
    #expect(ReportDrill.defaultMonth([]) == nil)
}

@Test func kotiCardsOpenTheMonthsRowsOnTheBooksBasis() {
    #expect(ReportDrill.koti(income: true, source: "tiliote", invoiceCount: 2, month: "2026-09") == .bankFeed(month: "2026-09"))
    #expect(ReportDrill.koti(income: false, source: "tiliote", invoiceCount: 0, month: "2026-09") == .bankFeed(month: "2026-09"))
    // Sales are invoices when the month has any; otherwise the income receipts.
    #expect(ReportDrill.koti(income: true, source: "kuitit", invoiceCount: 2, month: "2026-09") == .invoices(period: "2026-09", status: .all))
    #expect(ReportDrill.koti(income: true, source: "kuitit", invoiceCount: 0, month: "2026-09") == .receipts(period: "2026-09", tab: "tulo", category: ""))
    #expect(ReportDrill.koti(income: false, source: "kuitit", invoiceCount: 2, month: "2026-09") == .receipts(period: "2026-09", tab: "meno", category: ""))
}

private func alv(_ sources: String) throws -> AlvReport {
    let json = """
    {"period":{"key":"2026-09"},"vatRegistered":true,
     "field301":{"label":"301","netSales":100,"vat":25.5},"field302":{"label":"302","netSales":0,"vat":0},
     "field303":{"label":"303","netSales":0,"vat":0},"field309":{"label":"309","turnover":0},
     "field307":{"label":"307","amount":10},"field308":{"label":"308","amount":15.5,"isRefund":false}\(sources)}
    """
    return try JSONDecoder().decode(AlvReport.self, from: Data(json.utf8))
}

@Test func alvFieldsOpenTheDocumentsTheyAreMadeOf() throws {
    let invoiced = try alv(#","sources":{"receiptSalesVat":5,"invoiceSalesVat":20.5,"invoiceCount":2,"purchaseInvoiceVat":3,"purchaseInvoiceCount":1}"#)
    #expect(ReportDrill.alvSales(invoiced, period: "2026-09") == .invoices(period: "2026-09", status: .all))
    #expect(ReportDrill.alvReceiptSales(invoiced, period: "2026-09") == .receipts(period: "2026-09", tab: "tulo", category: ""))
    #expect(ReportDrill.alvDeductible(period: "2026-09") == .receipts(period: "2026-09", tab: "meno", category: ""))
    #expect(ReportDrill.alvPurchases(invoiced) == .purchaseInvoices)

    let receiptsOnly = try alv(#","sources":{"receiptSalesVat":25.5,"invoiceSalesVat":0,"invoiceCount":0,"purchaseInvoiceVat":0,"purchaseInvoiceCount":0}"#)
    #expect(ReportDrill.alvSales(receiptsOnly, period: "2026") == .receipts(period: "2026", tab: "tulo", category: ""))
    #expect(ReportDrill.alvReceiptSales(receiptsOnly, period: "2026") == nil)
    #expect(ReportDrill.alvPurchases(receiptsOnly) == nil)

    // A quarter has no list filter: the lists open unfiltered by period.
    #expect(ReportDrill.alvDeductible(period: "2026-Q3") == .receipts(period: "", tab: "meno", category: ""))
    // A server without the sources: the receipts, as before.
    let legacy = try alv("")
    #expect(ReportDrill.alvSales(legacy, period: "2026-09") == .receipts(period: "2026-09", tab: "tulo", category: ""))
}

@Test func invoiceScopeKeepsOnlyPeriodsTheServerReads() {
    #expect(InvoiceScope(month: "2026-09").query == ["month": "2026-09"])
    #expect(InvoiceScope(month: "2026").title == "Vuosi 2026")
    #expect(InvoiceScope(month: "2026-09").title == "Syyskuu 2026")
    #expect(InvoiceScope(month: "2026-Q3").isEmpty)
    #expect(InvoiceScope(month: "2026-13").isEmpty)
    #expect(InvoiceScope(month: "+202").isEmpty)
    #expect(InvoiceScope(customerId: "c1").query == ["customerId": "c1"])
    #expect(InvoiceScope(month: "2026-09", customerId: "c1").title == "Syyskuu 2026 · Asiakkaan laskut")
    #expect(InvoiceScope().title == nil)
}

@Test func invoiceAndCategoryLinksKeepTheirFilters() {
    #expect(AppLink.parse("/laskut?month=2026-09&status=all") == .invoicesFiltered(month: "2026-09", status: "all", customerId: ""))
    #expect(AppLink.parse("/laskut?status=overdue") == .invoicesFiltered(month: "", status: "overdue", customerId: ""))
    #expect(AppLink.parse("/laskut?customerId=c1") == .invoicesFiltered(month: "", status: "", customerId: "c1"))
    #expect(AppLink.parse("/laskut") == .invoices)
    #expect(AppLink.parse("/kuitit?month=2026&type=meno&category=tarvikkeet") == .receipts(month: "2026", type: "meno", category: "tarvikkeet"))
}

@Test func kotiKeepsLastMonthUntilItIsClosed() {
    #expect(Koti.previousMonthLine(.init(month: "2026-08", open: 3)) == "Elokuu: 3 asiaa kesken")
    #expect(Koti.previousMonthLine(.init(month: "2026-08", open: 1)) == "Elokuu: 1 asia kesken")
    #expect(Koti.previousMonthLine(.init(month: "2026-08", open: 0)) == "Elokuu on valmis suljettavaksi")
}

@Test func receiptsWithoutVatAreAskedFromTheServer() {
    var query = ReceiptListQuery()
    query.month = "2026"
    query.missingVat = true
    #expect(query.countsQuery()["vat"] == "missing")
    #expect(query.listQuery()["vat"] == "missing")
    #expect(query.isFiltered)
    // A drill-only narrowing: never stored as the owner's remembered Kuitit filters.
    #expect(!query.remembered.contains("vat"))
    #expect(ReportDrill.receiptsMissingVat(period: "2026").label == "Kuitit")
}
