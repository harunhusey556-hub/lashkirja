import Testing
import Foundation
@testable import LashKirjaCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

@Test func decodesRealInvoiceList() throws {
    let list = try JSONDecoder().decode(InvoiceList.self, from: fixture("invoices.json"))
    #expect(list.invoices.count == 1)
    let invoice = list.invoices[0]
    #expect(invoice.number == 1)
    #expect(invoice.customer.name == "Testi Asiakas Oy")
    #expect(invoice.gross == Decimal(string: "201.7"))
    #expect(invoice.lines.count == 2)
    #expect(list.aging.overdueCount == 0)
}

@Test func decodesRealInvoiceDetail() throws {
    let detail = try JSONDecoder().decode(InvoiceDetailResponse.self, from: fixture("invoice-detail.json"))
    let i = detail.invoice
    #expect(i.displayStatus == .sent)
    #expect(i.paid == 100)
    #expect(i.open == Decimal(string: "101.7"))
    #expect(i.payments.first?.note == "Osamaksu")
    #expect(i.activity.count >= 2)
    #expect(i.lines[1].quantity == 2)
    #expect(i.lines[1].unitPrice == Decimal(string: "35.86"))
}

@Test func statusLabels() {
    #expect(InvoiceStatus.draft.label == "Luonnos")
    #expect(InvoiceStatus.sent.label == "Odottaa maksua")
    #expect(InvoiceStatus.overdue.label == "Myöhässä")
    #expect(InvoiceStatus.paid.label == "Maksettu")
    #expect(InvoiceStatus.credited.label == "Hyvitetty")
    #expect(InvoiceStatus(rawValue: "weird") == nil)
}

@Test func draftTotalsMatchTheServer() {
    // The server: net per VAT rate summed first, VAT rounded once per rate (160,72 € → 40,98 €).
    var draft = InvoiceDraft(customerId: "c", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.lines = [
        InvoiceDraft.Line(description: "Ripsienpidennys", quantity: 1, unit: "kpl", unitPrice: 89, vatRate: Decimal(string: "25.5")!),
        InvoiceDraft.Line(description: "Huolto", quantity: 2, unit: "kpl", unitPrice: Decimal(string: "35.86")!, vatRate: Decimal(string: "25.5")!),
    ]
    let totals = draft.totals
    #expect(totals.net == Decimal(string: "160.72"))
    #expect(totals.vat == Decimal(string: "40.98"))
    #expect(totals.gross == Decimal(string: "201.7"))
}

@Test func draftEncodesStrictBody() throws {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.notes = "  "
    draft.lines = [InvoiceDraft.Line(description: "Huolto", quantity: 1, unit: "kpl", unitPrice: 10, vatRate: 24)]
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
    #expect(Set(json.keys) == ["customerId", "issueDate", "paymentTermDays", "lines"])
    #expect(draft.validationError == nil)
    draft.lines = []
    #expect(draft.validationError == "Lisää vähintään yksi rivi.")
    draft.lines = [InvoiceDraft.Line(description: " ", quantity: 1, unit: "kpl", unitPrice: 10, vatRate: 24)]
    #expect(draft.validationError == "Jokaisella rivillä tarvitaan kuvaus.")
}

@Test func decodesCustomersAndCounts() throws {
    let customers = try JSONDecoder().decode(CustomerList.self, from: fixture("customers.json"))
    #expect(customers.customers.first?.name == "Testi Asiakas Oy")
    #expect(customers.customers.first?.defaultPaymentTermDays == 14)
    let counts = try JSONDecoder().decode(InvoiceCounts.self, from: fixture("invoice-counts.json"))
    #expect(counts.counts["draft"] == 1)
}

@Test func decodesRealCustomerDetail() throws {
    let detail = try JSONDecoder().decode(CustomerDetail.self, from: fixture("customer-detail.json"))
    #expect(detail.customer.name == "Testi Asiakas Oy")
    #expect(detail.openBalance == Decimal(string: "101.7"))
    #expect(detail.invoicedTotal == Decimal(string: "201.7"))
    #expect(detail.invoices.first?.displayStatus == .sent)
}
