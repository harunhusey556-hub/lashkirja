import Testing
import Foundation
@testable import LashKirjaCore

@Test func decodesRealProfitLoss() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/profit-loss.json"))
    let report = try JSONDecoder().decode(ProfitLoss.self, from: data)
    #expect(report.from == "2026-01")
    #expect(report.total.incomeNet == Decimal(string: "160.72"))
    #expect(report.total.profitNet == Decimal(string: "160.72"))
    #expect(report.total.incomeByCategory.first?.category == "Myyntilaskut")
    #expect(report.filledMonths(year: "2026").count == 12)
    #expect(report.filledMonths(year: "2026").allSatisfy { $0.incomeNet == 0 || $0.month != nil })
}

/// M048: a year with nothing booked has no figures, so Raportit says so once instead of drawing a
/// blank chart and picking a December of 0,00 €.
@Test func aYearWithoutDocumentsHasNoFigures() throws {
    func report(receipts: Int, invoices: Int, creditNotes: String) throws -> ProfitLoss {
        let total = #"{"month":null,"incomeNet":0,"incomeVat":0,"incomeGross":0,"expenseNet":0,"expenseVat":0,"expenseGross":0,"profitNet":0,"incomeByCategory":[],"expenseByCategory":[],"receiptCount":\#(receipts),"invoiceCount":\#(invoices)\#(creditNotes)}"#
        return try JSONDecoder().decode(ProfitLoss.self, from: Data(#"{"from":"2025-01","to":"2025-12","total":\#(total),"months":[]}"#.utf8))
    }
    let empty = try report(receipts: 0, invoices: 0, creditNotes: #","creditNoteCount":0"#)
    #expect(!empty.hasFigures)
    // An older server without the credit-note count.
    let older = try report(receipts: 0, invoices: 0, creditNotes: "")
    #expect(!older.hasFigures)
    let oneReceipt = try report(receipts: 1, invoices: 0, creditNotes: #","creditNoteCount":0"#)
    #expect(oneReceipt.hasFigures)
    let oneInvoice = try report(receipts: 0, invoices: 1, creditNotes: "")
    #expect(oneInvoice.hasFigures)
    let oneCreditNote = try report(receipts: 0, invoices: 0, creditNotes: #","creditNoteCount":1"#)
    #expect(oneCreditNote.hasFigures)
}

/// S1: rent and other bills with no receipt are expenses now, so a year holding only those has figures.
@Test func aYearWithOnlyPurchaseInvoicesHasFigures() throws {
    let total = #"{"month":null,"incomeNet":0,"incomeVat":0,"incomeGross":0,"expenseNet":800,"expenseVat":0,"expenseGross":800,"profitNet":-800,"incomeByCategory":[],"expenseByCategory":[{"category":"vuokra","gross":800,"vat":0,"net":800,"count":1}],"receiptCount":0,"invoiceCount":0,"creditNoteCount":0,"purchaseInvoiceCount":1}"#
    let report = try JSONDecoder().decode(ProfitLoss.self, from: Data(#"{"from":"2026-01","to":"2026-12","total":\#(total),"months":[]}"#.utf8))
    #expect(report.total.purchaseInvoiceCount == 1)
    #expect(report.hasFigures)
}

/// X085: Kausi names its periods as the rest of the app does; the keys the package route reads stay.
@Test func packagePeriodsAreNamedAsElsewhere() {
    let options = ReportPackage.options(year: 2026)
    let months = (1...12).map { String(format: "2026-%02d", $0) }
    #expect(options.map(\.key) == months + ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4", "2026"])
    let titles = Dictionary(uniqueKeysWithValues: options.map { ($0.key, $0.title) })
    #expect(titles["2026-01"] == "Tammikuu 2026")
    #expect(titles["2026-09"] == "Syyskuu 2026")
    #expect(titles["2026-Q3"] == "Q3 2026")
    #expect(titles["2026"] == "Vuosi 2026")
    // Another year's months carry their own year, as the current year's do.
    let earlier = Dictionary(uniqueKeysWithValues: ReportPackage.options(year: 2025).map { ($0.key, $0.title) })
    #expect(earlier["2025-12"] == "Joulukuu 2025")
}
