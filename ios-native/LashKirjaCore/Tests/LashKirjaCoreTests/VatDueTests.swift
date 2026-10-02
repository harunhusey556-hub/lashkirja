import Testing
import Foundation
@testable import LashKirjaCore

// Mirrors the web's lib/vat-deadline.test.ts, lib/vat-due.test.ts and lib/alv-period-choice.test.ts.

@Test func easterSundayMatchesTheHistoricalRecord() {
    #expect(VatDue.easterSunday(2026) == "2026-04-05")
    #expect(VatDue.easterSunday(2027) == "2027-03-28")
    #expect(VatDue.easterSunday(2004) == "2004-04-11")
}

@Test func finnishHolidaysIncludeTheMovableFeastsAndMidsummerEve() {
    let holidays = VatDue.holidays(2026)
    for day in ["2026-01-01", "2026-01-06", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14",
                "2026-06-19", "2026-12-06", "2026-12-24", "2026-12-25", "2026-12-26"] {
        #expect(holidays.contains(day), "\(day)")
    }
    #expect(holidays.count == 11)
}

@Test func monthlyDeadlineIsTheTwelfthOfTheSecondMonthAfter() {
    #expect(VatDue.deadline("2026-09") == "2026-11-12")
    #expect(VatDue.deadline("2026-08") == "2026-10-12")
    // 12.12.2026 is a Saturday: on to Monday.
    #expect(VatDue.deadline("2026-10") == "2026-12-14")
    // 12.4.2004 was Easter Monday: on to Tuesday.
    #expect(VatDue.deadline("2004-02") == "2004-04-13")
    #expect(VatDue.deadline("2026-11") == "2027-01-12")
}

@Test func quarterlyAndYearlyDeadlines() {
    #expect(VatDue.deadline("2026-Q3") == "2026-11-12")
    #expect(VatDue.deadline("2026-Q4") == "2027-02-12")
    // 28.2.2027 is a Sunday: on to Monday 1.3.
    #expect(VatDue.deadline("2026") == "2027-03-01")
    #expect(VatDue.deadline("nonsense") == nil)
    #expect(VatDue.deadline("2026-13") == nil)
}

@Test func nextDueIsTheEarliestPeriodNotYetPastItsDeadline() {
    #expect(VatDue.nextDueKey(today: "2026-09-28", kind: .month) == "2026-08")
    #expect(VatDue.nextDueKey(today: "2026-10-12", kind: .month) == "2026-08")
    #expect(VatDue.nextDueKey(today: "2026-10-13", kind: .month) == "2026-09")
    #expect(VatDue.nextDueKey(today: "2026-09-28", kind: .quarter) == "2026-Q3")
    #expect(VatDue.nextDueKey(today: "2027-01-15", kind: .year) == "2026")
    #expect(VatDue.nextDueKey(today: "2027-03-02", kind: .year) == "2027")
}

@Test func periodKindAndProfileValue() {
    #expect(VatKind(key: "2026-08") == .month)
    #expect(VatKind(key: "2026-Q3") == .quarter)
    #expect(VatKind(key: "2026") == .year)
    #expect(VatKind(profile: "quarter") == .quarter)
    #expect(VatKind(profile: "year") == .year)
    #expect(VatKind(profile: nil) == .month)
    #expect(VatKind(profile: "weekly") == .month)
}

@Test func aPeriodHasEndedOnTheDayAfterItsLastDay() {
    #expect(!VatDue.periodEnded("2026-09", today: "2026-09-30"))
    #expect(VatDue.periodEnded("2026-09", today: "2026-10-01"))
    #expect(!VatDue.periodEnded("2026-Q4", today: "2026-12-31"))
    #expect(VatDue.periodEnded("2026-Q4", today: "2027-01-01"))
    #expect(!VatDue.periodEnded("2026", today: "2026-12-31"))
    #expect(VatDue.periodEnded("2025", today: "2026-01-01"))
}

@Test func labelsAndDueDateText() {
    #expect(VatDue.label("2026-08") == "Elokuu 2026")
    #expect(VatDue.label("2026-Q3") == "Q3/2026")
    #expect(VatDue.label("2026") == "2026")
    #expect(VatDue.optionLabel("2026-Q3") == "Q3 / 2026")
    #expect(VatDue.dueDateText("2026-10-12", periodYear: 2026) == "12.10.")
    // The deadline falls in a later year than the period: name the year.
    #expect(VatDue.dueDateText("2027-03-01", periodYear: 2026) == "1.3.2027")
}

@Test func periodOptionsCoverThisAndLastYearAndTheShownOne() {
    let months = VatDue.periodOptions(kind: .month, nowYear: 2026, selected: "2026-08")
    #expect(months.count == 24)
    #expect(months.first?.key == "2025-01")
    #expect(months.first?.label == "Tammikuu 2025")
    let quarters = VatDue.periodOptions(kind: .quarter, nowYear: 2026, selected: "2023-Q2")
    #expect(quarters.count == 9)
    #expect(quarters.first?.key == "2023-Q2")
    #expect(VatDue.periodOptions(kind: .year, nowYear: 2026, selected: "2026").map(\.key) == ["2025", "2026"])
}

@Test func filingStateLabels() {
    #expect(VatFiling.stateLabel(.open, nothingToPay: false) == "Ilmoittamatta")
    #expect(VatFiling.stateLabel(.filed, nothingToPay: false) == "Ilmoitettu, maksamatta")
    #expect(VatFiling.stateLabel(.filed, nothingToPay: true) == "Ilmoitettu")
    #expect(VatFiling.stateLabel(.paid, nothingToPay: false) == "Maksettu")
}

@Test func filingStepsEndInOneFullStop() {
    #expect(VatFiling.fileStepText(dueIso: "2026-10-12", periodYear: 2026)
            == "Kirjoita kentät tältä sivulta ja lähetä ilmoitus viimeistään 12.10.")
    #expect(VatFiling.payStepText(amount: 159, dueIso: "2027-03-01", periodYear: 2026)
            == "Maksa \(Money.format(159)) viimeistään 1.3.2027.")
    #expect(VatFiling.payStepText(amount: 0, dueIso: "2026-10-12", periodYear: 2026) == nil)
}

@Test func filedNoteAndAmountToPay() {
    // A filed return owes what was filed, not the live figure.
    #expect(VatFiling.amountToPay(amount: 170, filedAt: "x", filedAmount: 159) == 159)
    #expect(VatFiling.amountToPay(amount: 170, filedAt: "x", filedAmount: -20) == 0)
    #expect(VatFiling.amountToPay(amount: 170, filedAt: nil, filedAmount: 159) == 170)
    #expect(VatFiling.filedNote(filedOn: "5.10.2026", amount: 159, dueIso: "2026-10-12", nothingToPay: false, periodYear: 2026)
            == "Ilmoitettu 5.10.2026. Maksa \(Money.format(159)) viimeistään 12.10.")
    #expect(VatFiling.filedNote(filedOn: "", amount: 0, dueIso: "2026-10-12", nothingToPay: true, periodYear: 2026) == "Ilmoitettu.")
}

@Test func undoClearsPaidFirstThenFiled() {
    #expect(VatFiling.undo(state: .paid, nothingToPay: false) == .paid)
    #expect(VatFiling.undo(state: .paid, nothingToPay: true) == .filed)
    #expect(VatFiling.undo(state: .filed, nothingToPay: false) == .filed)
    #expect(VatFiling.undoTitle(state: .paid, nothingToPay: false) == "Peru maksettu-merkintä")
    #expect(VatFiling.undoTitle(state: .filed, nothingToPay: false) == "Peru ilmoitettu-merkintä")
}

@Test func alvNotes() {
    #expect(VatFiling.pendingNote(0) == nil)
    #expect(VatFiling.pendingNote(1) == "1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä.")
    #expect(VatFiling.pendingNote(2) == "2 kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä.")
    #expect(VatFiling.purchaseNote(count: 2, vat: 40, skipped: 1, suspected: 0, unusable: 0)
            == "2 ostolaskun ALV \(Money.format(40)) on mukana vähennettävässä verossa laskun päivän mukaan. 1 ostolasku jätettiin pois, koska sama osto on jo mukana kuittina.")
    #expect(VatFiling.salesSourcesNote(receiptSalesVat: 10, invoiceSalesVat: 50, excludedReceipts: 2, creditNotes: 1)
            == "Kuiteista \(Money.format(10)) · myyntilaskuista \(Money.format(50)). Laskut lasketaan laskun päivän mukaan (suoriteperuste). 2 kuittia jätettiin pois, koska sama pankkitapahtuma on jo kohdistettu laskulle. 1 hyvityslasku vähentää myyntiä tällä kaudella.")
    #expect(VatFiling.reviewTitle(1) == "1 kuitti ilman ALV-erittelyä")
    #expect(VatFiling.reviewText(salesGross: 12, purchasesGross: 30)
            == "Myynnit \(Money.format(12)) · Ostot \(Money.format(30)). Lisää ALV-tiedot kuiteille, jotta ne lasketaan mukaan.")
}

@Test func alvReportDecodesTheNotesFields() throws {
    let json = #"""
    {"period":{"key":"2026-08"},"vatRegistered":true,
     "field301":{"label":"301","netSales":100,"vat":25.5},"field302":{"label":"302","netSales":0,"vat":0},
     "field303":{"label":"303","netSales":0,"vat":0},"field309":{"label":"309","turnover":0},
     "field307":{"label":"307","amount":5},"field308":{"label":"308","amount":20.5,"isRefund":false},
     "review":{"salesGross":12.4,"purchasesGross":30,"count":3},"receiptCount":4,
     "excludedReceiptCount":1,"creditNoteCount":2,"skippedPurchaseInvoiceCount":1,
     "suspectedPurchaseDuplicateCount":0,"purchaseReceiptUnusableCount":1,"pendingReceiptCount":2}
    """#
    let report = try JSONDecoder().decode(AlvReport.self, from: Data(json.utf8))
    #expect(report.review?.count == 3)
    #expect(report.review?.salesGross == Decimal(string: "12.4"))
    #expect(report.excludedReceiptCount == 1)
    #expect(report.creditNoteCount == 2)
    #expect(report.skippedPurchaseInvoiceCount == 1)
    #expect(report.purchaseReceiptUnusableCount == 1)
}

@Test func profitLossDecodesTheDataQualityCounts() throws {
    let period = #"{"month":null,"incomeNet":0,"incomeVat":0,"incomeGross":0,"expenseNet":0,"expenseVat":0,"expenseGross":0,"profitNet":0,"incomeByCategory":[],"expenseByCategory":[],"receiptCount":3,"invoiceCount":0,"missingVatCount":2}"#
    let json = #"{"from":"2026-01","to":"2026-12","total":\#(period),"months":[],"undatedCount":1}"#
    let report = try JSONDecoder().decode(ProfitLoss.self, from: Data(json.utf8))
    #expect(report.total.missingVatCount == 2)
    #expect(report.undatedCount == 1)
    // An older server without the counts still decodes.
    let old = #"{"from":"2026-01","to":"2026-12","total":\#(period.replacingOccurrences(of: ",\"missingVatCount\":2", with: "")),"months":[]}"#
    let plain = try JSONDecoder().decode(ProfitLoss.self, from: Data(old.utf8))
    #expect(plain.total.missingVatCount == nil)
    #expect(plain.undatedCount == nil)
}

@Test func dataQualityRowsLinkToTheYearsReceipts() {
    #expect(ReportDrill.dataQuality(missingVat: 2, undated: 0, year: "2026")
            == [.init(title: "Ilman ALV-erittelyä", count: 2, drill: .receiptsMissingVat(period: "2026"))])
    // Undated receipts are in no year: they open the whole list.
    #expect(ReportDrill.dataQuality(missingVat: 0, undated: 1, year: "2026")
            == [.init(title: "Ilman päivää", count: 1, drill: .receipts(period: "", tab: "", category: ""))])
    #expect(ReportDrill.dataQuality(missingVat: nil, undated: nil, year: "2026").isEmpty)
}
