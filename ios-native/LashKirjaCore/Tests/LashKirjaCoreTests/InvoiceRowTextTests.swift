import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func invoice(number: Int = 2, display: String, kind: String = "invoice", credited: String = "", open: String = "602.4") throws -> Invoice {
    let creditedJSON = credited.isEmpty ? "" : "\"credited\":\(credited),"
    let status = display == "overdue" ? "sent" : display
    return try decode(Invoice.self, """
    {"id":"i\(number)","number":\(number),"reference":"1232","status":"\(status)","displayStatus":"\(display)","issueDate":"2026-09-03","dueDate":"2026-10-03",
     "sentAt":null,"paidAt":null,"notes":null,"currency":"EUR","net":480,"vat":122.4,"gross":602.4,"paid":0,\(creditedJSON)"open":\(open),
     "closedReason":null,"updatedAt":"2026-10-01T00:00:00.000Z","documentKind":"\(kind)","creditsInvoice":null,
     "customer":{"id":"c1","name":"Kauneus Oy","email":null,"businessId":null},"lines":[],"payments":[],"sends":[],"activity":[]}
    """)
}

// M100: the row's badge says "Myöhässä", so its line names the due date the same way as an open one's.
@Test func anInvoiceRowSaysItsDueDateAndLeavesTheLateStateToItsBadge() throws {
    #expect(try invoice(display: "sent").rowSecondary == "Lasku 2 · eräpäivä 3.10.2026")
    #expect(try invoice(display: "overdue").rowSecondary == "Lasku 2 · eräpäivä 3.10.2026")
    #expect(try !invoice(display: "overdue").rowSecondary.localizedCaseInsensitiveContains("myöhässä"))
    #expect(try invoice(display: "paid", open: "0").rowSecondary == "Lasku 2 · eräpäivä 3.10.2026")
    // A part credit still says what it took off.
    #expect(try invoice(display: "overdue", credited: "20", open: "582.4").rowSecondary == "Lasku 2 · eräpäivä 3.10.2026, hyvitetty 20,00\u{00A0}€")
}

@Test func aDraftAndACreditNoteRowNameOnlyTheirNumber() throws {
    #expect(try invoice(number: 4, display: "draft").rowSecondary == "Lasku 4")
    #expect(try invoice(number: 5, display: "sent", kind: "credit_note").rowSecondary == "Hyvityslasku 5")
    #expect(InvoiceRowText.secondary(number: 5, status: .credited, dueDate: "2026-10-03", isCreditNote: true) == "Hyvityslasku 5")
}

// X027: the customer's list printed the invoice date (3.9.2026) where Myynti prints the due date.
@Test func theCustomersInvoiceRowReadsAsMyyntisRow() throws {
    let detail = try decode(CustomerDetail.self, """
    {"customer":{"id":"c1","name":"Kauneus Oy","defaultPaymentTermDays":30,"updatedAt":"2026-10-01T00:00:00Z"},
     "openBalance":602.4,"openInvoiceCount":1,"invoicedTotal":602.4,"recurringCount":0,
     "invoices":[{"id":"i2","number":2,"status":"sent","displayStatus":"overdue","issueDate":"2026-09-03","dueDate":"2026-10-03","gross":602.4,"open":602.4},
                 {"id":"i4","number":4,"status":"draft","displayStatus":"draft","issueDate":"2026-10-17","dueDate":"2026-11-16","gross":146.84,"open":146.84}]}
    """)
    #expect(detail.invoices.map(\.rowSecondary) == ["Lasku 2 · eräpäivä 3.10.2026", "Lasku 4"])
    #expect(try detail.invoices[0].rowSecondary == invoice(display: "overdue").rowSecondary)
    #expect(!detail.invoices[0].rowSecondary.contains("3.9.2026"))
}

// X003: a blocked reminder names where the owner fixes it, as the web sheet's links do.
@Test func aBlockedReminderNamesItsFix() throws {
    func preview(_ extra: String) throws -> ReminderPreview {
        try decode(ReminderPreview.self, #"{"level":1,"daysLate":15,"open":602.4,"interest":2.85,"fee":5,"total":610.25,"dueDate":"2026-10-31","previousReminders":[]"# + extra + "}")
    }
    #expect(try preview(#","recipient":null"#).blockFix == .customerEmail)
    #expect(try preview(#","recipient":"","mailboxMissing":true"#).blockFix == .customerEmail)
    #expect(try preview(#","recipient":"laskut@kauneus.example","mailboxMissing":true"#).blockFix == .connectMailbox)
    #expect(try preview(#","recipient":"laskut@kauneus.example","mailboxMissing":true"#).blockFix?.title == "Yhdistä sähköposti")
    #expect(try preview(#","recipient":"laskut@kauneus.example","mailboxMissing":false"#).blockFix == nil)
    // Only waiting for the next allowed day: blocked, but nothing to fix.
    let waiting = try preview(#","recipient":"a@b.fi","nextReminderAt":"2099-01-01T00:00:00.000Z","nextReminderNote":"Uuden muistutuksen voi lähettää 1.1.2099 alkaen.""#)
    #expect(waiting.blockedReason() != nil && waiting.blockFix == nil)
}
