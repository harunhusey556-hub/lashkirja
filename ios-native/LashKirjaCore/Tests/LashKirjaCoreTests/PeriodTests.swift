import Testing
import Foundation
@testable import LashKirjaCore

private let monthJSON = #"""
{"month":"2026-08","ended":true,"locked":false,"lockedThrough":"2026-06",
 "items":[
  {"id":"pr1","kind":"pending_receipt","party":"K-Market","amount":12.5,"receiptId":"r1","gaps":["vat"]},
  {"id":"mr1","kind":"missing_receipt","party":"Neste","amount":-40,"date":"2026-08-03","transactionId":"t1"},
  {"id":"di1","kind":"draft_invoice","party":"Asiakas Oy","amount":100,"invoiceId":"i1","number":12}
 ],
 "totals":{"pending_receipt":1,"missing_receipt":1,"draft_invoice":1,"vat_gap":0,"receipt_match":0,"invoice_match":0,"payment_duplicate":0,"overdue_invoice":0},
 "blockingTotal":3,"progress":{"matchable":5,"matched":4,"suggested":0},"hasStatement":true,
 "receiptCount":4,"invoiceCount":1,"purchaseInvoiceCount":0,"hasContent":true,"vatRegistered":true,"vatPeriod":"quarter"}
"""#

@Test func monthStatusDecodes() throws {
    let s = try JSONDecoder().decode(PeriodMonthStatus.self, from: Data(monthJSON.utf8))
    #expect(s.month == "2026-08")
    #expect(s.items.count == 3)
    #expect(s.count(["pending_receipt", "vat_gap"]) == 1)
    #expect(s.progress.matched == 4)
    #expect(s.vatPeriod == "quarter")
}

@Test func monthStepsFollowTheWeb() throws {
    let s = try JSONDecoder().decode(PeriodMonthStatus.self, from: Data(monthJSON.utf8))
    let steps = PeriodClose.steps(s)
    #expect(steps.map(\.key) == ["receipts", "bank", "invoices"])
    #expect(steps[0].state == .open)
    #expect(steps[0].text == "1 kuitti odottaa hyväksyntää")
    #expect(steps[0].items.map(\.id) == ["pr1"])
    #expect(steps[1].text == "1 pankkitapahtuma kesken")
    #expect(steps[2].text == "1 lasku lähettämättä")
}

@Test func stepStateNeedsSomethingToTick() {
    #expect(PeriodClose.stepState(open: 2, hasItems: true) == .open)
    #expect(PeriodClose.stepState(open: 0, hasItems: true) == .done)
    #expect(PeriodClose.stepState(open: 0, hasItems: false) == .none)
}

@Test func vatStepOnlyWhenSomethingToAdd() throws {
    let withGap = monthJSON.replacingOccurrences(of: #""vat_gap":0"#, with: #""vat_gap":2"#)
    let s = try JSONDecoder().decode(PeriodMonthStatus.self, from: Data(withGap.utf8))
    let steps = PeriodClose.steps(s)
    #expect(steps.map(\.key) == ["receipts", "vat", "bank", "invoices"])
    #expect(steps[1].text == "2 kuittia ilman ALV-erittelyä")
}

@Test func subtitleAndButton() {
    var f = PeriodClose.Facts(ended: true, locked: false, blocking: 0, hasContent: true, hasStatement: true, vat: nil)
    #expect(PeriodClose.subtitle(f) == "Kaikki kirjattu. Voit sulkea kuukauden.")
    #expect(PeriodClose.button(f) == nil)
    #expect(PeriodClose.complete(f) == false)
    f.locked = true
    #expect(PeriodClose.subtitle(f) == "Kuukausi on suljettu.")
    #expect(PeriodClose.complete(f))
    f = PeriodClose.Facts(ended: false, locked: false, blocking: 0, hasContent: true, hasStatement: true, vat: nil)
    #expect(PeriodClose.subtitle(f) == "Kuukausi on vielä kesken.")
    #expect(PeriodClose.button(f) == "Kuukauden voi sulkea, kun se on päättynyt.")
    f = PeriodClose.Facts(ended: true, locked: false, blocking: 2, hasContent: true, hasStatement: false, vat: nil)
    #expect(PeriodClose.subtitle(f) == "2 asiaa kesken")
    #expect(PeriodClose.warnings(f) == ["2 asiaa on vielä kesken.", "Tiliotetta ei ole tuotu."])
    f = PeriodClose.Facts(ended: true, locked: false, blocking: 0, hasContent: false, hasStatement: false, vat: nil)
    #expect(PeriodClose.subtitle(f) == "Ei kirjattavaa tässä kuussa.")
    #expect(PeriodClose.button(f) == "Tässä kuussa ei ole kirjattavaa.")
    let vat = PeriodClose.Vat(state: .filed, done: false, changedSinceFiling: false, nothingToPay: false)
    f = PeriodClose.Facts(ended: true, locked: false, blocking: 0, hasContent: true, hasStatement: true, vat: vat)
    #expect(PeriodClose.subtitle(f) == "Kirjaukset on tehty. ALV on ilmoitettu, mutta ei vielä maksettu.")
    #expect(PeriodClose.warnings(f) == ["ALV:ta ei ole merkitty maksetuksi."])
}

@Test func vatFromTheFiling() {
    #expect(PeriodClose.vat(filedAt: nil, paidAt: nil, amount: 10, isRefund: false).state == .open)
    let filedRefund = PeriodClose.vat(filedAt: "2026-09-01", paidAt: nil, amount: 10, isRefund: true)
    #expect(filedRefund.state == .filed && filedRefund.done)
    let filedPayable = PeriodClose.vat(filedAt: "2026-09-01", paidAt: nil, amount: 10, isRefund: false)
    #expect(!filedPayable.done)
    #expect(PeriodClose.vat(filedAt: "2026-09-01", paidAt: "2026-09-02", amount: 10, isRefund: false).done)
}

@Test func vatPeriodEndsInMonth() {
    #expect(PeriodClose.vatPeriodEnding(in: "2026-08", kind: "month") == "2026-08")
    #expect(PeriodClose.vatPeriodEnding(in: "2026-08", kind: "quarter") == nil)
    #expect(PeriodClose.vatPeriodEnding(in: "2026-09", kind: "quarter") == "2026-Q3")
    #expect(PeriodClose.vatPeriodEnding(in: "2026-11", kind: "year") == nil)
    #expect(PeriodClose.vatPeriodEnding(in: "2026-12", kind: "year") == "2026")
}

@Test func defaultMonthIsThePreviousOne() {
    #expect(PeriodClose.defaultMonth(current: "2026-01") == "2025-12")
}

// MARK: Lock

@Test func lockChangeKinds() {
    #expect(PeriodLock.change(current: nil, selected: nil) == .none)
    #expect(PeriodLock.change(current: "2026-05", selected: "2026-07") == .lock)
    #expect(PeriodLock.change(current: "2026-05", selected: "2026-03") == .reopen)
    #expect(PeriodLock.change(current: "2026-05", selected: nil) == .reopen)
    #expect(PeriodLock.change(current: nil, selected: "2026-05") == .lock)
}

@Test func monthNamesAreLowercaseLikeTheWeb() {
    #expect(PeriodLock.formatMonth("2026-03") == "maaliskuu 2026")
    #expect(PeriodLock.monthAfter("2026-12") == "2027-01")
}

@Test func reopenedRange() {
    #expect(PeriodLock.reopenedRange(selected: nil, lockedThrough: "2026-05") == "kaikki kuukaudet toukokuu 2026 asti")
    #expect(PeriodLock.reopenedRange(selected: "2026-04", lockedThrough: "2026-05") == "toukokuu 2026")
    #expect(PeriodLock.reopenedRange(selected: "2026-02", lockedThrough: "2026-05") == "maaliskuu–toukokuu 2026")
    #expect(PeriodLock.reopenedRange(selected: "2025-11", lockedThrough: "2026-02") == "joulukuu 2025–helmikuu 2026")
}

@Test func lockOptionsAreTheLast24FinishedMonths() {
    let options = PeriodLock.options(current: "2026-10", lockedThrough: nil)
    #expect(options.count == 24)
    #expect(options.first == "2026-09")
    #expect(options.last == "2024-10")
    let old = PeriodLock.options(current: "2026-10", lockedThrough: "2023-01")
    #expect(old.count == 25 && old.last == "2023-01")
}

@Test func lockBodyKeepsExplicitNulls() throws {
    let open = PeriodLockBody(month: nil, reopen: true, expectedLockedThrough: nil)
    let text = String(data: try JSONEncoder().encode(open), encoding: .utf8)!
    #expect(text.contains(#""month":null"#))
    #expect(text.contains(#""expectedLockedThrough":null"#))
    #expect(text.contains(#""reopen":true"#))
    let lock = PeriodLockBody(month: "2026-08", reopen: false, expectedLockedThrough: "2026-06")
    let lockText = String(data: try JSONEncoder().encode(lock), encoding: .utf8)!
    #expect(!lockText.contains("reopen"))
    #expect(lockText.contains(#""month":"2026-08""#))
}

@Test func lockStateAndPrecheckDecode() throws {
    let state = try JSONDecoder().decode(PeriodLockState.self, from: Data(#"{"lockedThrough":null}"#.utf8))
    #expect(state.lockedThrough == nil)
    let pre = try JSONDecoder().decode(PeriodPrecheck.self, from: Data(#"{"month":"2026-08","missingDocuments":[{"id":"a","title":"Neste","detail":"40,00 €","href":"/kuitit/kuitti?id=r1"}],"unmatchedTransactions":[],"draftInvoices":[]}"#.utf8))
    #expect(pre.count == 1)
}

@Test func lockConfirmCopy() {
    let lock = PeriodLock.confirmation(month: "2026-08", reopen: false, range: nil)
    #expect(lock.title == "Lukitaanko kaudet elokuu 2026 asti?")
    #expect(lock.message.hasPrefix("Elokuu 2026 ja sitä vanhemmat kaudet muuttuvat vain luettaviksi"))
    #expect(lock.action == "Lukitse")
    let reopen = PeriodLock.confirmation(month: "2026-04", reopen: true, range: "toukokuu 2026")
    #expect(reopen.title == "Avataanko toukokuu 2026?")
    #expect(reopen.action == "Avaa kaudet")
    let all = PeriodLock.confirmation(month: nil, reopen: true, range: "kaikki kuukaudet toukokuu 2026 asti")
    #expect(all.title == "Avataanko kirjanpito uudelleen?")
}

@Test func lockToast() {
    #expect(PeriodLock.toast(previous: "2026-05", now: "2026-04", reopen: true) == "Toukokuu 2026 avattiin.")
    #expect(PeriodLock.toast(previous: nil, now: "2026-08", reopen: false) == "Kirjanpito lukittu elokuu 2026 asti.")
    #expect(PeriodLock.toast(previous: "2026-05", now: nil, reopen: true) == "Kirjanpito avattiin.")
}

@Test func checklistRowTexts() throws {
    let s = try JSONDecoder().decode(PeriodMonthStatus.self, from: Data(monthJSON.utf8))
    #expect(PeriodClose.secondary(s.items[0]) == "Odottaa hyväksyntää")
    #expect(PeriodClose.secondary(s.items[1]) == "Kuitti puuttuu · 3.8.")
    #expect(PeriodClose.secondary(s.items[2]) == "Lasku 12 · lähettämättä")
    let gap = try JSONDecoder().decode(DashboardItem.self, from: Data(#"{"id":"x","kind":"pending_receipt","party":"A","gaps":["amount","vendor"]}"#.utf8))
    #expect(PeriodClose.secondary(gap) == "Lisää summa ja myyjä")
    let vat = try JSONDecoder().decode(DashboardItem.self, from: Data(#"{"id":"y","kind":"vat_gap","party":"A","type":"meno"}"#.utf8))
    #expect(PeriodClose.secondary(vat) == "ALV-erittely puuttuu · vähennys jää pois")
}
