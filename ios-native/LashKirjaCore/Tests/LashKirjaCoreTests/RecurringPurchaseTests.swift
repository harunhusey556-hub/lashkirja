import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func object(_ value: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

private let listJSON = #"""
{"recurring":[
 {"id":"rp1","supplierName":"Kiinteistö Oy Kivi","supplierBusinessId":"1572860-0","supplierIban":"FI2112345600000785","reference":"1232","category":"Vuokra","notes":null,
  "grossAmount":1004,"vatRate":25.5,"netAmount":800,"vatAmount":204,"interval":"monthly","dayOfMonth":1,"dueDays":14,
  "startDate":"2026-01-01","endDate":null,"active":true,"nextRunDate":"2026-11-01","lastRunAt":"2026-10-01T03:00:00.000Z","runCount":10,
  "lastInvoice":{"id":"pi10","issueDate":"2026-10-01","dueDate":"2026-10-15","status":"open","grossAmount":1004}},
 {"id":"rp2","supplierName":"Siivous Ky","grossAmount":120,"vatRate":0,"interval":"quarterly","dayOfMonth":5,"dueDays":7,
  "startDate":"2026-02-05","active":false,"nextRunDate":"2026-11-05","runCount":0,"lastInvoice":null},
 {"id":"rp3","supplierName":"Vakuutus Oy","grossAmount":360.5,"vatRate":0,"interval":"yearly","dayOfMonth":15,"dueDays":30,
  "startDate":"2026-03-15","endDate":"2026-12-31","active":true,"nextRunDate":null}
]}
"""#

@Test func decodesRecurringPurchaseListWithMissingFields() throws {
    let list = try decode(RecurringPurchaseList.self, listJSON)
    #expect(list.recurring.count == 3)
    let rent = list.recurring[0]
    #expect(rent.supplierName == "Kiinteistö Oy Kivi")
    #expect(rent.grossAmount == 1004)
    #expect(rent.vatRate == Decimal(string: "25.5"))
    #expect(rent.netAmount == 800)
    #expect(rent.vatAmount == 204)
    #expect(rent.interval == .monthly)
    #expect(rent.dayOfMonth == 1)
    #expect(rent.runCount == 10)
    #expect(rent.lastInvoice?.id == "pi10")
    #expect(rent.lastInvoice?.grossAmount == 1004)
    #expect(rent.lastInvoice?.status == .open)
    let paused = list.recurring[1]
    #expect(paused.active == false)
    #expect(paused.supplierIban == nil)
    // Net and VAT fall back to the rate split when the server leaves them out.
    #expect(paused.netAmount == 120)
    #expect(paused.vatAmount == 0)
    #expect(paused.lastInvoice == nil)
    let ended = list.recurring[2]
    #expect(ended.nextRunDate == nil)
    #expect(ended.runCount == 0)
    #expect(ended.grossAmount == Decimal(string: "360.5"))
    #expect(list.activeCount == 2)
}

@Test func recurringPurchaseListOrdersActiveFirstThenByNextDate() throws {
    let list = try decode(RecurringPurchaseList.self, listJSON)
    #expect(list.ordered.map(\.id) == ["rp1", "rp3", "rp2"])
}

@Test func recurringPurchaseScheduleLabels() throws {
    #expect(RecurringPurchaseSchedule.label(interval: .monthly, dayOfMonth: 5, startDate: "2026-01-05") == "Joka kuukausi 5. päivä")
    #expect(RecurringPurchaseSchedule.label(interval: .quarterly, dayOfMonth: 1, startDate: "2026-01-01") == "Joka neljännes 1. päivä")
    #expect(RecurringPurchaseSchedule.label(interval: .yearly, dayOfMonth: 15, startDate: "2026-03-15") == "Joka vuosi 15.3.")
    let list = try decode(RecurringPurchaseList.self, listJSON)
    #expect(list.recurring[0].scheduleText == "Joka kuukausi 1. päivä")
    #expect(list.recurring[0].secondary(today: "2026-10-03") == "Joka kuukausi 1. päivä · seuraava 1.11.")
    #expect(list.recurring[2].secondary(today: "2026-10-03") == "Joka vuosi 15.3. · päättynyt")
    #expect(list.recurring[1].secondary(today: "2026-10-03") == "Joka neljännes 5. päivä · seuraava 5.11.")
}

@Test func recurringPurchaseCountLabel() {
    #expect(RecurringPurchaseText.countLabel(0) == "Ei vielä")
    #expect(RecurringPurchaseText.countLabel(1) == "1 toistuva")
    #expect(RecurringPurchaseText.countLabel(4) == "4 toistuvaa")
}

@Test func vatRateFromNetAndVatPicksNearestAllowedRate() {
    #expect(PurchaseVatRate.allowed == [Decimal(string: "25.5")!, 14, Decimal(string: "13.5")!, 10, 0])
    #expect(PurchaseVatRate.nearest(net: 800, vat: 204) == Decimal(string: "25.5"))
    #expect(PurchaseVatRate.nearest(net: 100, vat: 24) == Decimal(string: "25.5"))
    #expect(PurchaseVatRate.nearest(net: 100, vat: 14) == 14)
    #expect(PurchaseVatRate.nearest(net: 100, vat: Decimal(string: "13.5")!) == Decimal(string: "13.5"))
    #expect(PurchaseVatRate.nearest(net: 100, vat: 10) == 10)
    #expect(PurchaseVatRate.nearest(net: 100, vat: 0) == 0)
    #expect(PurchaseVatRate.nearest(net: 0, vat: 0) == 0)
    // Only VAT (net 0): the highest rate is the closest guess.
    #expect(PurchaseVatRate.nearest(net: 0, vat: 5) == Decimal(string: "25.5"))
    #expect(PurchaseVatRate.label(Decimal(string: "25.5")!) == "25,5 %")
    #expect(PurchaseVatRate.label(0) == "0 %")
}

@Test func vatSplitRoundsLikeTheServer() {
    let rent = PurchaseVatRate.split(gross: 1004, rate: Decimal(string: "25.5")!)
    #expect(rent.vat == 204)
    #expect(rent.net == 800)
    // 100 € at 25,5 %: 20.318… → 20,32 €.
    let hundred = PurchaseVatRate.split(gross: 100, rate: Decimal(string: "25.5")!)
    #expect(hundred.vat == Decimal(string: "20.32"))
    #expect(hundred.net == Decimal(string: "79.68"))
    #expect(PurchaseVatRate.split(gross: 50, rate: 0).vat == 0)
}

@Test func recurringPurchaseNextDatePreview() {
    // The day has not come yet this month: the first invoice is this month.
    #expect(RecurringPurchaseSchedule.firstRun(startDate: "2026-10-03", dayOfMonth: 5, interval: .monthly) == "2026-10-05")
    // Already past: the next interval.
    #expect(RecurringPurchaseSchedule.firstRun(startDate: "2026-10-03", dayOfMonth: 1, interval: .monthly) == "2026-11-01")
    #expect(RecurringPurchaseSchedule.firstRun(startDate: "2026-10-03", dayOfMonth: 1, interval: .quarterly) == "2027-01-01")
    #expect(RecurringPurchaseSchedule.firstRun(startDate: "2026-12-20", dayOfMonth: 1, interval: .yearly) == "2027-12-01")
    #expect(RecurringPurchaseSchedule.dueDate(issue: "2026-10-25", dueDays: 14) == "2026-11-08")
    #expect(RecurringPurchaseSchedule.dueDate(issue: "2026-10-01", dueDays: 0) == "2026-10-01")

    #expect(RecurringPurchaseSchedule.preview(startDate: "2026-10-03", dayOfMonth: 5, interval: .monthly, dueDays: 14, endDate: nil, coveredPeriod: nil, today: "2026-10-03")
            == "Ensimmäinen ostolasku 5.10.2026, eräpäivä 19.10.2026.")
    // A start in the past: the first one is made straight away.
    #expect(RecurringPurchaseSchedule.preview(startDate: "2026-10-01", dayOfMonth: 1, interval: .monthly, dueDays: 14, endDate: nil, coveredPeriod: nil, today: "2026-10-03")
            == "Ensimmäinen ostolasku 1.10.2026, eräpäivä 15.10.2026. Se luodaan heti, kun tallennat.")
    // Made from an invoice: its month is already covered, so the next one comes a period later.
    #expect(RecurringPurchaseSchedule.preview(startDate: "2026-10-01", dayOfMonth: 1, interval: .monthly, dueDays: 14, endDate: nil, coveredPeriod: "2026-10", today: "2026-10-03")
            == "Seuraava ostolasku 1.11.2026, eräpäivä 15.11.2026.")
    // Ends before anything would be made.
    #expect(RecurringPurchaseSchedule.preview(startDate: "2026-10-03", dayOfMonth: 1, interval: .monthly, dueDays: 14, endDate: "2026-10-31", coveredPeriod: nil, today: "2026-10-03")
            == "Päättymispäivä on ennen ensimmäistä ostolaskua, joten yhtään ostolaskua ei luoda.")
}

@Test func recurringPurchaseFormValidates() {
    var form = RecurringPurchaseForm(today: "2026-10-03")
    #expect(form.vatRate == Decimal(string: "25.5"))
    #expect(form.interval == .monthly)
    #expect(form.dayOfMonth == 3)
    #expect(form.dueDays == 14)
    var result = form.validate()
    #expect(result.errors[.supplierName] == "Anna toimittajan nimi.")
    #expect(result.errors[.gross] == "Anna summa, esim. 850,00.")
    #expect(result.input == nil)

    form.supplierName = "  Kiinteistö Oy Kivi "
    form.gross = "1004,00"
    form.businessId = "1572860-1"
    form.iban = "FI21 1234 5600 0007 86"
    form.reference = "1233"
    form.endDate = "2026-09-30"
    result = form.validate()
    #expect(result.errors[.businessId] == "Toimittajan Y-tunnus ei ole kelvollinen.")
    #expect(result.errors[.iban] == "Toimittajan IBAN ei ole kelvollinen.")
    #expect(result.errors[.reference] == "Viitenumero ei täsmää.")
    #expect(result.errors[.endDate] == "Päättymispäivä ei voi olla ennen aloitusta.")

    form.businessId = "1572860-0"
    form.iban = "fi21 1234 5600 0007 85"
    form.reference = "123 2"
    form.endDate = nil
    form.dayOfMonth = 29
    #expect(form.validate().errors[.dayOfMonth] == "Päivä on 1–28.")
    form.dayOfMonth = 1
    form.dueDays = 91
    #expect(form.validate().errors[.dueDays] == "Eräaika on 0–90 päivää.")
    form.dueDays = 14
    form.gross = "10,001"
    #expect(form.validate().errors[.gross] == "Summassa saa olla enintään kaksi desimaalia.")
    form.gross = "1004"
    result = form.validate()
    #expect(result.errors.isEmpty)
    let input = result.input!
    #expect(input.supplierName == "Kiinteistö Oy Kivi")
    #expect(input.supplierIban == "FI2112345600000785")
    #expect(input.supplierBusinessId == "1572860-0")
    #expect(input.reference == "1232")
    #expect(input.grossAmount == 1004)
}

@Test func recurringPurchaseInputEncodesTheContractShape() throws {
    var form = RecurringPurchaseForm(today: "2026-10-03")
    form.supplierName = "Vuokranantaja"
    form.gross = "850"
    form.vatRate = 0
    let input = form.validate().input!
    let created = try object(input.body(forEdit: false))
    #expect(Set(created.keys) == ["supplierName", "grossAmount", "vatRate", "interval", "dayOfMonth", "dueDays", "startDate"])
    #expect(created["interval"] as? String == "monthly")
    #expect(created["startDate"] as? String == "2026-10-03")
    #expect((created["grossAmount"] as? NSNumber)?.doubleValue == 850)
    // An edit clears what was emptied, so the server forgets the old value.
    let edited = try object(input.body(forEdit: true))
    #expect(edited["supplierIban"] is NSNull)
    #expect(edited["endDate"] is NSNull)
    #expect(edited["fromPurchaseInvoiceId"] == nil)
    #expect(try object(RecurringPurchaseActivePatch(active: false)).keys.sorted() == ["active"])
}

private let invoiceJSON = #"""
{"id":"pi9","supplierName":"Kiinteistö Oy Kivi","supplierBusinessId":"1572860-0","supplierIban":"FI2112345600000785","invoiceNumber":"A-9",
 "reference":"1232","issueDate":"2026-09-30","dueDate":"2026-10-21","status":"open","displayStatus":"open",
 "gross":1004,"vat":204,"net":800,"paid":0,"open":1004,"category":"Vuokra","notes":"syyskuu","payments":[],"recurringPurchaseId":null}
"""#

@Test func recurringPurchaseFormPrefillsFromAnInvoice() throws {
    let invoice = try decode(PurchaseInvoice.self, invoiceJSON)
    let form = RecurringPurchaseForm(from: invoice)
    #expect(form.supplierName == "Kiinteistö Oy Kivi")
    #expect(form.businessId == "1572860-0")
    #expect(form.iban == "FI2112345600000785")
    #expect(form.reference == "1232")
    #expect(form.gross == "1\u{00A0}004,00" || form.gross == "1004,00")
    #expect(form.vatRate == Decimal(string: "25.5"))
    #expect(form.category == "Vuokra")
    // Issued on the 30th: the schedule keeps to the 28th, the last day every month has.
    #expect(form.dayOfMonth == 28)
    #expect(form.dueDays == 21)
    #expect(form.startDate == "2026-09-30")
    #expect(form.fromPurchaseInvoiceId == "pi9")
    #expect(form.coveredPeriod == "2026-09")
    let body = try object(form.validate().input!.body(forEdit: false))
    #expect(body["fromPurchaseInvoiceId"] as? String == "pi9")
    #expect((body["vatRate"] as? NSNumber)?.doubleValue == 25.5)
}

@Test func recurringPurchaseFormEditsAnExistingTemplate() throws {
    let rent = try decode(RecurringPurchaseList.self, listJSON).recurring[0]
    let form = RecurringPurchaseForm(editing: rent)
    #expect(form.supplierName == rent.supplierName)
    #expect(form.iban == "FI2112345600000785")
    #expect(form.dayOfMonth == 1)
    #expect(form.startDate == "2026-01-01")
    #expect(form.endDate == nil)
    #expect(form.category == "Vuokra")
    #expect(form.fromPurchaseInvoiceId == nil)
    #expect(form.validate().errors.isEmpty)
}

@Test func dueDaysBetweenInvoiceDatesIsClamped() {
    #expect(RecurringPurchaseSchedule.days(from: "2026-09-30", to: "2026-10-21") == 21)
    #expect(RecurringPurchaseSchedule.days(from: "2026-10-21", to: "2026-09-30") == -21)
}

@Test func purchaseInvoiceRecurringTagIsReadBesideTheInvoice() throws {
    let tagged = try decode(PurchaseInvoiceTaggedResponse.self, #"{"invoice":{"id":"pi1","supplierName":"A","gross":10,"recurringPurchaseId":"rp1"}}"#)
    #expect(tagged.invoice.id == "pi1")
    #expect(tagged.recurringPurchaseId == "rp1")
    let old = try decode(PurchaseInvoiceTaggedResponse.self, #"{"invoice":{"id":"pi1","supplierName":"A","gross":10}}"#)
    #expect(old.recurringPurchaseId == nil)

    let list = try decode(PurchaseInvoiceTaggedList.self, #"{"invoices":[{"id":"a","gross":1,"recurringPurchaseId":"rp1"},{"id":"b","gross":2}],"aging":null}"#)
    #expect(list.list.invoices.count == 2)
    #expect(list.recurringIds == ["a": "rp1"])
}

@Test func recurringPurchaseRunAndUnavailableTexts() throws {
    let made = try decode(RecurringPurchaseRunResult.self, #"{"created":true,"purchaseInvoiceId":"pi11"}"#)
    #expect(made.message == "Ostolasku luotiin.")
    let none = try decode(RecurringPurchaseRunResult.self, #"{"created":false}"#)
    #expect(none.message == "Tämän kauden ostolasku on jo luotu.")
    #expect(RecurringPurchaseText.isUnavailable(LKError(status: 404, message: "Not found")))
    #expect(!RecurringPurchaseText.isUnavailable(LKError(status: 400, message: "x")))
    #expect(RecurringPurchaseText.deleteMessage.contains("säilyvät"))
}
