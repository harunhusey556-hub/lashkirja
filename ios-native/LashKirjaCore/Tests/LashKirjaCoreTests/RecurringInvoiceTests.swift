import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private let listJSON = #"""
{"recurring":[{"id":"r1","name":null,"interval":"monthly","anchorDay":5,"startDate":"2026-01-05","endDate":null,"nextRunAt":"2026-10-05","paymentTermDays":14,"notes":null,"autoSend":true,"active":true,"customer":{"id":"c1","name":"Kauneus Oy","email":"a@b.fi"},"lines":[{"id":"l1","description":"Kuukausimaksu","quantity":1.5,"unit":"kk","unitPrice":49.9,"vatRate":25.5}],"total":74.85,"generatedCount":9,"lastRun":{"issueDate":"2026-09-05","status":"generated","invoiceId":"i9"},"missedRuns":[],"failedSends":[{"issueDate":"2026-09-05","invoiceId":"i9","note":null}]},{"id":"r2","name":"Vuosihuolto","interval":"yearly","anchorDay":1,"startDate":"2025-01-01","endDate":"2026-06-30","nextRunAt":null,"paymentTermDays":7,"notes":null,"autoSend":false,"active":false,"customer":{"id":"c2","name":"Toinen Oy","email":null},"lines":[],"total":0,"generatedCount":1,"lastRun":null}],"dueNow":1}
"""#

@Test func decodesRecurringList() throws {
    let list = try decode(RecurringList.self, listJSON)
    #expect(list.dueNow == 1)
    let r = list.recurring[0]
    #expect(r.title == "Kauneus Oy")
    #expect(r.interval == .monthly)
    #expect(r.lines[0].quantity == Decimal(string: "1.5"))
    #expect(r.lines[0].unitPrice == Decimal(string: "49.9"))
    #expect(r.total == Decimal(string: "74.85"))
    #expect(r.failedSends.count == 1)
    let old = list.recurring[1]
    #expect(old.title == "Vuosihuolto")
    #expect(old.missedRuns.isEmpty)
    #expect(old.failedSends.isEmpty)
    #expect(RecurrenceInterval.quarterly.label == "Neljännesvuosittain")
}

@Test func recurringRowTextAndDueness() throws {
    let list = try decode(RecurringList.self, listJSON)
    let r = list.recurring[0]
    #expect(r.secondary(today: "2026-10-02") == "Kuukausittain · seuraava 5.10. · lähetetään automaattisesti · lähetys epäonnistui")
    #expect(r.isDue(today: "2026-10-02") == false)
    #expect(r.isDue(today: "2026-10-05") == true)
    let old = list.recurring[1]
    #expect(old.secondary(today: "2026-10-02") == "Toinen Oy · Vuosittain · päättynyt")
    #expect(old.isDue(today: "2026-10-02") == false)
    #expect(RecurringInvoice.scheduleDate("2026-12-01", today: "2026-10-02") == "1.12.")
    #expect(RecurringInvoice.scheduleDate("2026-09-01", today: "2026-10-02") == "1.9.2026")
    #expect(RecurringInvoice.scheduleDate("2027-01-01", today: "2026-10-02") == "1.1.2027")
}

@Test func recurringDraftEncodesTheServerShape() throws {
    var draft = RecurringDraft(today: "2026-10-02")
    #expect(draft.validationError == "Valitse asiakas.")
    draft.customerId = "c1"
    draft.name = "  "
    draft.lines = [InvoiceDraft.Line(description: "Kuukausimaksu", quantity: 1, unit: "kk", unitPrice: Decimal(string: "49.9")!, vatRate: Decimal(string: "25.5")!)]
    #expect(draft.validationError == nil)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
    #expect(Set(json.keys) == ["customerId", "name", "interval", "anchorDay", "startDate", "endDate", "paymentTermDays", "autoSend", "lines"])
    #expect(json["name"] is NSNull)
    #expect(json["endDate"] is NSNull)
    #expect(json["interval"] as? String == "monthly")
    #expect(json["startDate"] as? String == "2026-10-02")
    #expect((json["lines"] as? [[String: Any]])?.first?["unit"] as? String == "kk")

    draft.endDate = "2026-01-01"
    #expect(draft.validationError == "Päättymispäivä ei voi olla ennen alkupäivää.")
    draft.endDate = nil
    draft.anchorDay = 32
    #expect(draft.validationError == "Laskutuspäivä on 1-31.")
    draft.anchorDay = 5
    draft.lines = []
    #expect(draft.validationError == "Lisää vähintään yksi rivi.")
    draft.lines = [InvoiceDraft.Line(description: " ", quantity: 1, unit: "kpl", unitPrice: 1, vatRate: 0)]
    #expect(draft.validationError == "Kuvaus puuttuu.")
    draft.lines = [InvoiceDraft.Line(description: "A", quantity: 0, unit: "kpl", unitPrice: 1, vatRate: 0)]
    #expect(draft.validationError == "Määrä puuttuu.")
    draft.lines = [InvoiceDraft.Line(description: "A", quantity: 1, unit: "kpl", unitPrice: -1, vatRate: 0)]
    #expect(draft.validationError == "Hinta ei voi olla negatiivinen.")
}

@Test func recurringDraftFromExisting() throws {
    let r = try decode(RecurringList.self, listJSON).recurring[0]
    let draft = RecurringDraft(r)
    #expect(draft.customerId == "c1")
    #expect(draft.name == "")
    #expect(draft.anchorDay == 5)
    #expect(draft.startDate == "2026-01-05")
    #expect(draft.autoSend)
    #expect(draft.lines.first?.unitPrice == Decimal(string: "49.9"))
}

@Test func recurringActivePatchBody() throws {
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(RecurringActivePatch(active: false))) as! [String: Any]
    #expect(json as NSDictionary == ["active": false] as NSDictionary)
}

private let planJSON = #"""
{"plan":[{"recurringInvoiceId":"r1","name":"Kauneus Oy","customerName":"Kauneus Oy","customerEmail":"a@b.fi","autoSend":true,"grossByDate":[100,100,99],"issueDates":["2026-08-05","2026-09-05","2026-10-05"],"lockedDates":[]},{"recurringInvoiceId":"r2","name":"Vuosihuolto","customerName":"Toinen Oy","customerEmail":null,"autoSend":true,"grossByDate":[50],"issueDates":["2026-10-01"],"lockedDates":["2026-07-01"]}]}
"""#

@Test func runPlanSummaryMatchesTheWeb() throws {
    let plan = try decode(RecurringRunPlan.self, planJSON)
    #expect(plan.invoiceCount == 4)
    #expect(plan.summary == "Kauneus Oy 2 × 100,00\u{00A0}€ + 1 × 99,00\u{00A0}€, Vuosihuolto 50,00\u{00A0}€. 3 lähetetään sähköpostilla. 1 jää luonnokseksi. Lähetettyä laskua ei voi perua, vain hyvittää. Heinäkuu 2026 on suljettu kausi, joten sen lasku jää odottamaan. Avaa kausi kohdassa Kirjanpito > Suljetut kaudet.")
    let lockedOnly = try decode(RecurringRunPlan.self, #"{"plan":[{"recurringInvoiceId":"r","name":"A","customerName":"A","customerEmail":null,"autoSend":false,"grossByDate":[],"issueDates":[],"lockedDates":["2026-07-01","2026-08-01"]}]}"#)
    #expect(lockedOnly.invoiceCount == 0)
    #expect(lockedOnly.lockedOnlyMessage == "Heinäkuu 2026, elokuu 2026 ovat suljettuja kausia, joten laskuja ei voi luoda. Avaa kausi kohdassa Kirjanpito > Suljetut kaudet.")
}

@Test func runResultSummaryMatchesTheWeb() throws {
    let ok = try decode(RecurringRunResult.self, #"{"generated":[{"recurringInvoiceId":"r","issueDate":"2026-10-05","invoiceId":"i","invoiceNumber":3,"gross":10,"sent":true,"sendError":null}],"skipped":[],"truncated":[],"sendRetries":[]}"#)
    #expect(ok.summary.text == "1 lasku luotiin.")
    #expect(ok.summary.isProblem == false)
    let none = try decode(RecurringRunResult.self, #"{"generated":[],"skipped":[{"recurringInvoiceId":"r","issueDate":"2026-10-05","reason":"already_generated"}]}"#)
    #expect(none.summary.text == "Yhtään laskua ei luotu. 1 oli jo luotu.")
    let bad = try decode(RecurringRunResult.self, #"{"generated":[{"recurringInvoiceId":"r","issueDate":"2026-10-05","invoiceId":"i","invoiceNumber":3,"gross":10,"sent":false,"sendError":"x"},{"recurringInvoiceId":"r","issueDate":"2026-09-05","invoiceId":"j","invoiceNumber":4,"gross":10,"sent":false,"sendError":null}],"skipped":[{"recurringInvoiceId":"r","issueDate":"2026-07-05","reason":"period_locked"}],"sendRetries":[{"sent":true}]}"#)
    #expect(bad.summary.text == "2 laskua luotiin. 1 aiemmin lähettämättä jäänyt lasku lähetettiin. Heinäkuu 2026 jäi luomatta, koska kausi on suljettu. Avaa kausi kohdassa Kirjanpito > Suljetut kaudet. Kun kausi on auki, lasku luodaan seuraavalla kerralla. 1 lähetys epäonnistui, lasku on tallessa luonnoksena. Voit lähettää sen laskun sivulta.")
    #expect(bad.summary.isProblem)
}
