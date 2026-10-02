import Testing
import Foundation
@testable import LashKirjaCore

private let invoiceJSON = """
{"id":"pi1","supplierName":"Tukku Oy","supplierBusinessId":null,"supplierIban":null,
 "invoiceNumber":"A-12","reference":"1232","issueDate":"2026-09-01","dueDate":"2026-09-15",
 "status":"open","displayStatus":"overdue","gross":124,"vat":24.7,"net":99.3,"paid":24,"open":100,
 "closedReason":null,"category":null,"notes":null,"paidAt":null,"receiptId":null,
 "payments":[{"id":"p1","paidDate":"2026-09-10","amount":24,"source":"bank","transactionId":"t1","note":null}]}
"""

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func invoice(status: String = "open", display: String = "open", paid: Decimal = 0, open: Decimal = 124, number: String? = "A-12") throws -> PurchaseInvoice {
    let numberJSON = number.map { "\"\($0)\"" } ?? "null"
    return try decode(PurchaseInvoice.self, """
    {"id":"x\(display)","supplierName":"S","invoiceNumber":\(numberJSON),"issueDate":"2026-09-01","dueDate":"2026-09-15",
     "status":"\(status)","displayStatus":"\(display)","gross":124,"vat":0,"net":124,"paid":\(paid),"open":\(open),"payments":[]}
    """)
}

@Test func purchaseDecodesTheServerShape() throws {
    let i = try decode(PurchaseInvoice.self, invoiceJSON)
    #expect(i.supplierName == "Tukku Oy")
    #expect(i.displayStatus == .overdue)
    #expect(i.status == .open)
    #expect(i.vat == Decimal(string: "24.7"))
    #expect(i.net == Decimal(string: "99.3"))
    #expect(i.payments.first?.source == "bank")
    #expect(i.payments.first?.amount == 24)
}

@Test func purchaseDecodesLenientlyWhenFieldsAreMissing() throws {
    let i = try decode(PurchaseInvoice.self, """
    {"id":"pi2","supplierName":"X","issueDate":"2026-09-01","dueDate":"2026-09-02","status":"weird","displayStatus":"weird","gross":10}
    """)
    #expect(i.status == .open)
    #expect(i.displayStatus == .open)
    #expect(i.payments.isEmpty)
    #expect(i.open == 0)
    #expect(i.reference == nil)
}

@Test func purchaseDecodesListCountsLinksAndMatch() throws {
    let list = try decode(PurchaseInvoiceList.self, """
    {"invoices":[\(invoiceJSON)],"aging":{"buckets":{"not_due":{"count":0,"openCents":0},"1-30":{"count":1,"openCents":10000}},
     "totalOpenCents":10000,"overdueCents":10000,"overdueCount":1,"totalOpen":100,"overdue":100}}
    """)
    #expect(list.invoices.count == 1)
    #expect(list.aging?.totalOpen == 100)
    #expect(list.aging?.overdueCount == 1)
    #expect(list.aging?.bucket("1-30") == 100)
    #expect(list.aging?.bucket("90+") == 0)

    let counts = try decode(PurchaseInvoiceCountsResponse.self, #"{"counts":{"open":2,"overdue":1,"paid":3,"cancelled":0}}"#).counts
    #expect(counts.total == 6)

    let links = try decode(PurchaseReceiptLinks.self, """
    {"linked":null,"candidates":[{"id":"r1","vendor":"Kauppa","date":"2026-08-12","gross":124,"reviewStatus":"approved","sameAmount":true},
     {"id":"r2","vendor":null,"date":null,"gross":null,"reviewStatus":"pending","sameAmount":false}]}
    """)
    #expect(links.linked == nil)
    #expect(links.candidates[0].text == "Kauppa · 12.8.2026 · 124,00\u{00A0}€")
    #expect(links.candidates[1].text == "Kuitti")

    let match = try decode(PurchaseMatchResult.self, """
    {"applied":[{"invoiceId":"a","supplierName":"S","transactionId":"t","amount":5}],"skippedLocked":[],
     "suggestions":[{"invoiceId":"b","supplierName":"S","transactionId":"u","amount":6,"reason":"amount_and_date"}]}
    """)
    #expect(match.summary == "Kohdistettiin 1 maksua viitenumerolla. 1 mahdollista osumaa vaatii tarkistuksen.")
    let none = try decode(PurchaseMatchResult.self, #"{"applied":[],"suggestions":[]}"#)
    #expect(none.summary == "Ei kohdistettavia maksuja.")
}

@Test func purchaseFilterChipsHideAnEmptyCancelled() {
    let counts = PurchaseStatusCounts(open: 2, overdue: 1, paid: 3, cancelled: 0)
    let chips = PurchaseFilter.chips(counts)
    #expect(chips.map(\.filter) == [.all, .overdue, .open, .paid])
    #expect(chips.first?.count == 6)
    let withCancelled = PurchaseFilter.chips(PurchaseStatusCounts(open: 0, overdue: 0, paid: 0, cancelled: 1))
    #expect(withCancelled.map(\.filter).last == .cancelled)
    #expect(PurchaseFilter.all.queryValue == nil)
    #expect(PurchaseFilter.overdue.queryValue == "overdue")
    #expect(PurchaseFilter.open.label == "Odottaa maksua")
}

@Test func purchaseGroupsFollowTheWebOrder() throws {
    let rows = [try invoice(display: "paid"), try invoice(display: "open"), try invoice(display: "overdue")]
    let all = PurchaseFilter.groups(rows, filter: .all)
    #expect(all.map(\.status) == [.overdue, .open, .paid])
    #expect(all.map(\.label) == ["Myöhässä", "Odottaa maksua", "Maksetut"])
    #expect(PurchaseFilter.groups(rows, filter: .cancelled).isEmpty)
    #expect(PurchaseFilter.groups(rows, filter: .open).first?.items.count == 1)
}

@Test func purchaseRowSecondaryMatchesTheWeb() throws {
    #expect(try invoice(display: "open").rowSecondary == "A-12 · eräpäivä 15.9.")
    #expect(try invoice(display: "overdue", number: nil).rowSecondary == "Myöhässä, eräpäivä 15.9.")
    #expect(try invoice(paid: 24, open: 100).rowSecondary == "A-12 · eräpäivä 15.9. · avoinna 100,00\u{00A0}€")
}

@Test func purchaseStatusLabels() {
    #expect(PurchaseDisplayStatus.open.label == "Odottaa maksua")
    #expect(PurchaseDisplayStatus.overdue.label == "Myöhässä")
    #expect(PurchaseDisplayStatus.paid.label == "Maksettu")
    #expect(PurchaseDisplayStatus.cancelled.label == "Mitätöity")
}

@Test func purchaseReferenceCheckDigit() {
    #expect(PurchaseReference.isValid("1232"))
    #expect(PurchaseReference.isValid("12 344"))
    #expect(!PurchaseReference.isValid("1233"))
    #expect(!PurchaseReference.isValid("0000"))
    #expect(!PurchaseReference.isValid("12a3"))
    #expect(PurchaseReference.normalize(" 12 344 ") == "12344")
}

@Test func purchaseFormValidatesLikeTheWeb() {
    var form = PurchaseInvoiceForm(today: "2026-10-02")
    #expect(form.issueDate == "2026-10-02" && form.dueDate == "2026-10-02")
    var errors = form.validate().errors
    #expect(errors[.supplierName] == "Anna toimittajan nimi.")
    #expect(errors[.gross] == "Anna laskun summa, esim. 124,00.")

    form.supplierName = " Tukku Oy "
    form.gross = "124,00"
    form.vat = "200"
    form.reference = "1233"
    form.dueDate = "2026-10-01"
    errors = form.validate().errors
    #expect(errors[.vat] == "ALV ei voi ylittää summaa.")
    #expect(errors[.reference] == "Viitenumero ei täsmää.")
    #expect(errors[.dueDate] == "Eräpäivä ei voi olla ennen laskun päivää.")

    form.gross = "1,234"
    #expect(form.validate().errors[.gross] == "Summassa saa olla enintään kaksi desimaalia.")
    form.gross = "99999999"
    #expect(form.validate().errors[.gross] == "Summa on liian suuri.")
}

@Test func purchaseFormBuildsTheCreateBody() throws {
    var form = PurchaseInvoiceForm(today: "2026-10-02")
    form.supplierName = " Tukku Oy "
    form.gross = "124,00"
    form.reference = "12 344"
    form.dueDate = "2026-10-16"
    let input = try #require(form.validate().input)
    #expect(input.gross == 124)
    #expect(input.vat == 0)
    #expect(input.reference == "12344")
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
    #expect(json["supplierName"] as? String == "Tukku Oy")
    #expect(json["invoiceNumber"] == nil)
    #expect(json["category"] == nil)
    #expect(json["dueDate"] as? String == "2026-10-16")
}

@Test func purchaseFormEditSendsOnlyChangedFields() throws {
    let existing = try decode(PurchaseInvoice.self, invoiceJSON)
    var form = PurchaseInvoiceForm(editing: existing)
    #expect(form.supplierName == "Tukku Oy")
    #expect(form.gross == "124,00")
    #expect(form.vat == "24,70")
    let unchanged = try #require(form.validate().input)
    #expect(PurchaseInvoicePatch(from: unchanged, existing: existing).isEmpty)

    form.invoiceNumber = ""
    form.notes = "Uusi"
    let patch = PurchaseInvoicePatch(from: try #require(form.validate().input), existing: existing)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Any]
    #expect(json.keys.sorted() == ["invoiceNumber", "notes"])
    #expect(json["invoiceNumber"] is NSNull)
    #expect(json["notes"] as? String == "Uusi")
}

@Test func purchaseStatusChangeAndPaymentBodies() throws {
    let paid = PurchaseStatusChange(status: .paid, closeReason: "  maksettu käteisellä ")
    var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(paid)) as! [String: Any]
    #expect(json["status"] as? String == "paid")
    #expect(json["closeReason"] as? String == "maksettu käteisellä")
    json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(PurchaseStatusChange(status: .open))) as! [String: Any]
    #expect(json.keys.sorted() == ["status"])

    let link = PurchaseReceiptLink(receiptId: nil)
    json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(link)) as! [String: Any]
    #expect(json["receiptId"] is NSNull)

    let payment = PurchasePaymentBody(amount: Decimal(string: "12.5")!, paidDate: "2026-10-02", note: " ")
    json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payment)) as! [String: Any]
    #expect(json["paidDate"] as? String == "2026-10-02")
    #expect(json["note"] == nil)
    #expect(PurchasePaymentBody.problem(amountText: "0") == "Anna maksun summa, esim. 124,00.")
    #expect(PurchasePaymentBody.problem(amountText: "12,345") == "Summassa saa olla enintään kaksi desimaalia.")
    #expect(PurchasePaymentBody.problem(amountText: "12,34") == nil)
}

@Test func purchaseActionsFollowServerRules() throws {
    let open = try invoice()
    #expect(open.canDelete && open.canCancel && open.canRecordPayment)
    #expect(open.markPaidNeedsReason)
    let partly = try decode(PurchaseInvoice.self, invoiceJSON)
    #expect(!partly.canDelete && !partly.canCancel)
    let cancelled = try invoice(status: "cancelled", display: "cancelled", open: 0)
    #expect(!cancelled.canRecordPayment && cancelled.canReopen)
}
