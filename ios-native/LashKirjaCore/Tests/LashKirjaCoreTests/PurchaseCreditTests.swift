import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

// PublicPurchaseInvoice (app/src/lib/purchase-invoices.ts): gross 124, 62 already credited.
private func purchase(
    status: String = "open", display: String = "open", gross: Decimal = 124, credited: Decimal = 0, open: Decimal = 124,
    isCreditNote: Bool = false, creditsInvoiceId: String? = nil, notes: String = "[]"
) throws -> PurchaseInvoice {
    let credits = creditsInvoiceId.map { "\"\($0)\"" } ?? "null"
    return try decode(PurchaseInvoice.self, """
    {"id":"pi1","supplierName":"Tukku Oy","invoiceNumber":"A-12","issueDate":"2026-09-01","dueDate":"2026-09-15",
     "status":"\(status)","displayStatus":"\(display)","gross":\(gross),"vat":24,"net":100,"paid":0,"credited":\(credited),"open":\(open),
     "payments":[],"isCreditNote":\(isCreditNote),"creditsInvoiceId":\(credits),"creditNotes":\(notes)}
    """)
}

@Test func purchaseDecodesCreditFields() throws {
    let i = try purchase(credited: 72, open: 52, notes: #"[{"id":"c1","issueDate":"2026-10-02","gross":-62,"invoiceNumber":"H-1"},{"id":"c2","issueDate":"2026-10-05","gross":-10,"invoiceNumber":null}]"#)
    #expect(i.credited == 72)
    #expect(!i.isCreditNote && i.creditsInvoiceId == nil)
    #expect(i.creditNotes.map(\.id) == ["c1", "c2"])
    #expect(i.creditNotes[0].gross == -62)
    #expect(i.creditNotesNewestFirst.map(\.id) == ["c2", "c1"])
    #expect(i.creditNotes[0].title == "H-1" && i.creditNotes[1].title == "Hyvityslasku")
}

@Test func anOlderServerHasNoCreditFields() throws {
    let i = try decode(PurchaseInvoice.self, """
    {"id":"pi2","supplierName":"X","issueDate":"2026-09-01","dueDate":"2026-09-02","status":"open","displayStatus":"open","gross":10,"open":10}
    """)
    #expect(i.credited == 0 && !i.isCreditNote && i.creditNotes.isEmpty && i.creditsInvoiceId == nil)
    #expect(i.creditTag == nil)
    // A negative total is a credit note even when the flag is missing.
    let negative = try decode(PurchaseInvoice.self, """
    {"id":"pi3","supplierName":"X","issueDate":"2026-09-01","dueDate":"2026-09-01","status":"paid","displayStatus":"credited","gross":-10}
    """)
    #expect(negative.isCreditNote)
}

@Test func creditedStatusIsNotReadAsOpen() throws {
    let credited = try purchase(status: "credited", display: "credited", credited: 124, open: 0)
    #expect(credited.status == .credited)
    #expect(credited.displayStatus == .credited)
    #expect(credited.displayStatus.label == "Hyvitetty")
    // Nothing left to pay or credit.
    #expect(!credited.canRecordPayment && !credited.canMarkPaid && !credited.canCredit)
    #expect(!credited.canReopen)
    #expect(PurchaseStatusCounts(open: 1, overdue: 0, paid: 0, cancelled: 0, credited: 2).count(.credited) == 2)
    #expect(PurchaseStatusCounts(open: 1, overdue: 0, paid: 0, cancelled: 0, credited: 2).total == 3)
    let counts = try decode(PurchaseInvoiceCountsResponse.self, #"{"counts":{"open":1,"overdue":0,"paid":2,"credited":3,"cancelled":0}}"#).counts
    #expect(counts.credited == 3 && counts.total == 6)
}

@Test func creditedRowsStillListUnderAll() throws {
    let note = try purchase(status: "paid", display: "credited", gross: -62, open: 0, isCreditNote: true, creditsInvoiceId: "pi0")
    let open = try purchase()
    let groups = PurchaseFilter.groups([open, note], filter: .all)
    #expect(groups.map(\.status) == [.open, .credited])
    #expect(groups.last?.label == "Hyvitetyt")
}

@Test func creditNoteAndPartlyCreditedRowsAreTagged() throws {
    let note = try purchase(status: "paid", display: "credited", gross: -62, open: 0, isCreditNote: true, creditsInvoiceId: "pi0")
    #expect(note.creditTag == .creditNote)
    #expect(PurchaseCreditTag.creditNote.label == "Hyvityslasku")
    #expect(note.rowSecondary == "A-12 · Hyvityslasku 1.9.2026")
    #expect(!note.canCredit && !note.canReopen)
    // A cancelled credit note is just cancelled.
    let cancelled = try purchase(status: "cancelled", display: "cancelled", gross: -62, open: 0, isCreditNote: true)
    #expect(cancelled.creditTag == nil)

    let partly = try purchase(credited: 62, open: 62)
    #expect(partly.creditTag == .partlyCredited)
    #expect(PurchaseCreditTag.partlyCredited.label == "Osittain hyvitetty")
    #expect(partly.rowSecondary == "A-12 · eräpäivä 15.9.2026 · hyvitetty 62,00\u{00A0}€, avoinna 62,00\u{00A0}€")
    // Overdue keeps its own badge.
    #expect(try purchase(display: "overdue", credited: 62, open: 62).creditTag == nil)
    #expect(try purchase().creditTag == nil)
}

@Test func creditableIsWhatIsLeftAndOnlyOpenOrPaidInvoicesOfferIt() throws {
    #expect(try purchase(credited: 62, open: 62).creditable == 62)
    #expect(try purchase().canCredit)
    #expect(try purchase(status: "paid", display: "paid", open: 0).canCredit)
    #expect(try !purchase(status: "cancelled", display: "cancelled").canCredit)
    #expect(try !purchase(credited: 124, open: 0).canCredit)
    // Credit notes make deleting the invoice impossible, as on the server.
    let withNotes = try purchase(credited: 10, open: 114, notes: #"[{"id":"c1","issueDate":"2026-10-02","gross":-10,"invoiceNumber":null}]"#)
    #expect(!withNotes.canDelete)
    #expect(try purchase().canDelete)
}

@Test func creditFormStartsWithTheRemainderAndBuildsTheBody() throws {
    let invoice = try purchase(credited: 62, open: 62)
    var form = PurchaseCreditForm(invoice: invoice, today: "2026-10-12")
    #expect(form.amount == "62,00" && form.date == "2026-10-12")
    form.amount = "40,50"
    form.vat = "8"
    form.reason = "  Palautus "
    form.number = " H-7 "
    guard case .body(let body) = form.body(for: invoice) else { Issue.record("expected a body"); return }
    #expect(body.amount == Decimal(string: "40.5") && body.vat == 8)
    #expect(body.date == "2026-10-12" && body.reason == "Palautus" && body.supplierNumber == "H-7")
    let object = try encodedObject(body)
    #expect(Set(object.keys) == ["amount", "vat", "date", "reason", "supplierNumber"])
    // VAT and number are left out when empty: the server takes the pro rata VAT.
    form.vat = ""
    form.number = ""
    guard case .body(let bare) = form.body(for: invoice) else { Issue.record("expected a body"); return }
    #expect(Set(try encodedObject(bare).keys) == ["amount", "date", "reason"])
}

@Test func creditFormRefusesWithTheWebsWording() throws {
    let invoice = try purchase(credited: 62, open: 62)
    var form = PurchaseCreditForm(invoice: invoice, today: "2026-10-12")
    form.reason = "Palautus"
    func problem() -> String? {
        if case .invalid(let text) = form.body(for: invoice) { return text }
        return nil
    }
    #expect(problem() == nil)
    form.amount = ""
    #expect(problem() == "Anna hyvityksen summa, esim. 62,00.")
    form.amount = "0"
    #expect(problem() == "Anna hyvityksen summa, esim. 62,00.")
    form.amount = "12,345"
    #expect(problem() == "Summassa saa olla enintään kaksi desimaalia.")
    form.amount = "62,01"
    #expect(problem()?.hasPrefix("Hyvitettävissä on enintään 62,00") == true)
    form.amount = "62"
    form.vat = "63"
    #expect(problem() == "ALV on virheellinen.")
    form.vat = "-1"
    #expect(problem() == "ALV on virheellinen.")
    form.vat = ""
    form.reason = "ab"
    #expect(problem() == "Kirjoita hyvityksen syy.")
    form.reason = "Palautus"
    form.date = "2026-08-31"
    #expect(problem() == "Hyvityksen päivä ei voi olla ennen laskun päivää.")
    form.date = "2026-10-12"
    form.number = String(repeating: "1", count: 41)
    #expect(problem() == "Numero saa olla enintään 40 merkkiä.")
}

@Test func creditResponseHasTheNoteAndTheInvoice() throws {
    let note = #"{"id":"c1","supplierName":"Tukku Oy","issueDate":"2026-10-12","dueDate":"2026-10-12","status":"paid","displayStatus":"credited","gross":-62,"isCreditNote":true,"creditsInvoiceId":"pi1"}"#
    let invoice = #"{"id":"pi1","supplierName":"Tukku Oy","issueDate":"2026-09-01","dueDate":"2026-09-15","status":"open","displayStatus":"open","gross":124,"credited":62,"open":62}"#
    let response = try decode(PurchaseCreditResponse.self, #"{"creditNote":\#(note),"invoice":\#(invoice)}"#)
    #expect(response.creditNote.isCreditNote && response.creditNote.creditsInvoiceId == "pi1")
    #expect(response.invoice.credited == 62 && response.invoice.open == 62)
    #expect(PurchaseCreditForm.createdMessage == "Hyvityslasku luotu")
}

// MARK: Sales: a part credit shows

private func sales(status: String = "sent", display: String = "sent", gross: Decimal = 124, credited: String = "", open: Decimal = 124, kind: String = "invoice") throws -> Invoice {
    let creditedJSON = credited.isEmpty ? "" : "\"credited\":\(credited),"
    return try decode(Invoice.self, """
    {"id":"i1","number":7,"reference":"1232","status":"\(status)","displayStatus":"\(display)","issueDate":"2026-09-01","dueDate":"2026-09-15",
     "sentAt":null,"paidAt":null,"notes":null,"currency":"EUR","net":100,"vat":24,"gross":\(gross),"paid":0,\(creditedJSON)"open":\(open),
     "closedReason":null,"updatedAt":"2026-10-01T00:00:00.000Z","documentKind":"\(kind)","creditsInvoice":null,
     "customer":{"id":"c1","name":"Asiakas","email":null,"businessId":null},"lines":[],"payments":[],"sends":[],"activity":[]}
    """)
}

@Test func aPartlyCreditedSalesInvoiceSaysSo() throws {
    let partly = try sales(credited: "20", open: 104)
    #expect(partly.isPartlyCredited)
    #expect(InvoiceCreditDisplay.partlyCreditedLabel == "Osittain hyvitetty")
    #expect(partly.creditedRowSuffix == ", hyvitetty 20,00\u{00A0}€")
    #expect(partly.openAndCreditedLine == "Avoinna 104,00\u{00A0}€, hyvitetty 20,00\u{00A0}€")
}

@Test func creditedSalesInvoicesThatAreNotPartlyCreditedStaySilent() throws {
    // Nothing credited, an old server without the field.
    #expect(try !sales().isPartlyCredited)
    #expect(try sales().creditedRowSuffix == nil && sales().openAndCreditedLine == nil)
    // Fully credited: the status already says "Hyvitetty".
    #expect(try !sales(status: "credited", display: "credited", credited: "124", open: 0).isPartlyCredited)
    // A draft and a credit note never read as part credited.
    #expect(try !sales(status: "draft", display: "draft", credited: "20").isPartlyCredited)
    #expect(try !sales(credited: "20", kind: "credit_note").isPartlyCredited)
}
