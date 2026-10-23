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

@Test func aCopysAnswerCanOpenTheDetail() throws {
    // `POST /api/invoices/{id}/duplicate` answers `{ invoice }`; the copy opens on it, as on the detail
    // route's answer, instead of a spinner page while the detail is fetched again (motion lasku-copy).
    let answer = try JSONDecoder().decode(InvoiceResponse.self, from: fixture("invoice-detail.json"))
    let opened = InvoiceDetailResponse(invoice: answer.invoice)
    #expect(opened.invoice == answer.invoice)
    #expect(opened.invoice.lines.count == 2)
    #expect(opened.paymentDuplicates == nil)
}

/// The detail route's answer as the server shapes it: `barcode` and `barcodeIssue` beside the invoice,
/// never inside it (`app/src/app/api/invoices/[id]/route.ts`).
private func detailAnswer(adding top: [String: Any] = [:], removing gone: [String] = []) throws -> Data {
    let parsed = try JSONSerialization.jsonObject(with: fixture("invoice-detail.json"))
    var answer = try #require(parsed as? [String: Any])
    answer.merge(top) { _, added in added }
    for key in gone { answer.removeValue(forKey: key) }
    return try JSONSerialization.data(withJSONObject: answer)
}

@Test func theBarcodeBesideTheInvoiceLandsOnTheInvoice() throws {
    let code = "421123456000007850002017000000000000000000000013261016"
    let detail = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": code, "barcodeIssue": NSNull()]))
    #expect(detail.invoice.barcode == code)
    #expect(detail.invoice.barcodeIssue == nil)
    #expect(detail.paymentDuplicates?.isEmpty == true)
    // The screen the copy opens on is seeded from the decoded answer: it keeps the barcode.
    #expect(InvoiceDetailResponse(invoice: detail.invoice).invoice.barcode == code)
}

@Test func theIssueBesideTheInvoiceLandsOnTheInvoice() throws {
    let issue = "Lisää yrityksen tilinumero (IBAN) asetuksiin, niin laskuun tulee virtuaaliviivakoodi."
    let detail = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": NSNull(), "barcodeIssue": issue]))
    #expect(detail.invoice.barcode == nil)
    #expect(detail.invoice.barcodeIssue == issue)
}

@Test func aCopysAnswerWithoutPaymentDuplicatesCarriesTheBarcodeToo() throws {
    // `POST /api/invoices/{id}/duplicate` answers `{ invoice, barcode, barcodeIssue }`.
    let code = "421123456000007850002017000000000000000000000013261016"
    let copy = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": code, "barcodeIssue": NSNull()], removing: ["paymentDuplicates"]))
    #expect(copy.invoice.barcode == code)
    #expect(copy.paymentDuplicates == nil)
}

@Test func noBarcodeInTheAnswerLeavesTheInvoiceWithoutOne() throws {
    let detail = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer())
    #expect(detail.invoice.barcode == nil)
    #expect(detail.invoice.barcodeIssue == nil)
    let credit = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": NSNull(), "barcodeIssue": NSNull()]))
    #expect(credit.invoice.barcode == nil)
    #expect(credit.invoice.barcodeIssue == nil)
}

@Test func aStatusOrPaymentAnswerKeepsTheBarcodeTheScreenShows() throws {
    // `POST /api/invoices/{id}/status` and `DELETE /api/invoices/{id}/payments` answer `{ invoice }` alone;
    // the screen replaces its invoice with it, and the barcode row would vanish after Merkitse lähetetyksi.
    let code = "421123456000007850002017000000000000000000000013261016"
    let shown = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": code, "barcodeIssue": NSNull()])).invoice
    let answer = try JSONDecoder().decode(InvoiceResponse.self, from: fixture("invoice-detail.json")).invoice
    #expect(answer.barcode == nil)
    let kept = answer.keepingBarcode(of: shown)
    #expect(kept.barcode == code)
    #expect(kept.barcodeIssue == nil)
    // Only the barcode fields come from the invoice on screen; the rest is the answer's.
    var stripped = kept
    stripped.barcode = nil
    stripped.barcodeIssue = nil
    #expect(stripped == answer)
}

@Test func aStatusAnswerKeepsTheIssueWhenThereWasNoBarcode() throws {
    let issue = "Lisää yrityksen tilinumero (IBAN) asetuksiin, niin laskuun tulee virtuaaliviivakoodi."
    let shown = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": NSNull(), "barcodeIssue": issue])).invoice
    let answer = try JSONDecoder().decode(InvoiceResponse.self, from: fixture("invoice-detail.json")).invoice
    let kept = answer.keepingBarcode(of: shown)
    #expect(kept.barcode == nil)
    #expect(kept.barcodeIssue == issue)
}

@Test func anAnswerThatCarriesItsOwnBarcodeKeepsIt() throws {
    let shown = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": "old-code"])).invoice
    let newer = try JSONDecoder().decode(InvoiceDetailResponse.self, from: detailAnswer(adding: ["barcode": "new-code"])).invoice
    #expect(newer.keepingBarcode(of: shown).barcode == "new-code")
    #expect(newer.keepingBarcode(of: nil).barcode == "new-code")
}

@Test func nothingShownLeavesAStatusAnswerWithoutABarcode() throws {
    let answer = try JSONDecoder().decode(InvoiceResponse.self, from: fixture("invoice-detail.json")).invoice
    let kept = answer.keepingBarcode(of: nil)
    #expect(kept.barcode == nil)
    #expect(kept.barcodeIssue == nil)
    #expect(kept == answer)
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
    draft.lines = [InvoiceDraft.Line(description: "Huolto", quantity: 1, unit: "kpl", unitPrice: 10, vatRate: Decimal(string: "25.5")!)]
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
