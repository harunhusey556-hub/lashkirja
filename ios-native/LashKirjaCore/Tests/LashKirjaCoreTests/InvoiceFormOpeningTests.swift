import Testing
import Foundation
@testable import LashKirjaCore

// w44: the invoice form opens on this, worked out before its first frame. These are the rules the
// form's `.task` applied one frame later before (the "Lisää → Uusi lasku" flash).

private func customer(_ id: String, term: Int) throws -> Customer {
    try JSONDecoder().decode(Customer.self, from: Data("""
    {"id":"\(id)","name":"Asiakas \(id)","businessId":null,"contactPerson":null,"email":null,"phone":null,
     "addressStreet":null,"addressPostalCode":null,"addressCity":null,"country":"FI",
     "defaultPaymentTermDays":\(term),"notes":null,"archivedAt":null,"updatedAt":"2026-10-01T10:00:00.000Z"}
    """.utf8))
}

private func editedInvoice() throws -> Invoice {
    let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/invoice-detail.json"))
    return try JSONDecoder().decode(InvoiceDetailResponse.self, from: data).invoice
}

@Test func aNewInvoiceOpensWithItsFirstLineAndNoUnsavedChange() {
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [], sellerRegistered: true, kept: nil, today: "2026-10-15")
    #expect(opening.draft.lines.count == 1)
    #expect(opening.draft.lines[0].vatRate == Decimal(string: "25.5")!)
    #expect(opening.draft.issueDate == "2026-10-15")
    #expect(opening.draft.paymentTermDays == 14)
    // Nothing typed yet: the form is not dirty and Peruuta closes without asking.
    #expect(opening.baseline == opening.draft)
    #expect(opening.priceTexts[opening.draft.lines[0].id] == "")
    #expect(!opening.restored)
}

@Test func aSellerOutsideTheVatRegisterOpensOnAZeroRateLine() {
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [], sellerRegistered: false, kept: nil, today: "2026-10-15")
    #expect(opening.draft.lines.map(\.vatRate) == [0])
}

@Test func aPresetCustomerBringsTheirPaymentTerm() throws {
    let customers = [try customer("a", term: 7), try customer("b", term: 30)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: "b", customers: customers, sellerRegistered: true, kept: nil, today: "2026-10-15")
    #expect(opening.draft.customerId == "b")
    #expect(opening.draft.paymentTermDays == 30)
    #expect(opening.baseline == opening.draft)
}

@Test func aKeptDraftComesBackOverTheBaseline() throws {
    var kept = InvoiceDraft(customerId: "a", issueDate: "2026-10-10", paymentTermDays: 7)
    kept.lines = [InvoiceDraft.Line(description: "Huolto", unitPrice: 35)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [try customer("a", term: 7)],
                                      sellerRegistered: true, kept: kept, today: "2026-10-15")
    #expect(opening.restored)
    #expect(opening.draft == kept)
    #expect(opening.priceTexts[kept.lines[0].id] == "35,00")
    // The kept draft is an unsaved change against the empty form.
    #expect(opening.baseline.customerId == "")
    #expect(opening.baseline != opening.draft)
}

@Test func aKeptDraftForAnArchivedCustomerLosesOnlyTheCustomer() throws {
    var kept = InvoiceDraft(customerId: "gone", issueDate: "2026-10-10", paymentTermDays: 7)
    kept.lines = [InvoiceDraft.Line(description: "Huolto", unitPrice: 35)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [try customer("a", term: 7)],
                                      sellerRegistered: true, kept: kept, today: "2026-10-15")
    #expect(opening.restored)
    #expect(opening.draft.customerId == "")
    #expect(opening.draft.lines.map(\.description) == ["Huolto"])
}

@Test func aKeptDraftForAnotherCustomerStaysKeptWhenTheFormIsForThisOne() throws {
    var kept = InvoiceDraft(customerId: "a", issueDate: "2026-10-10", paymentTermDays: 7)
    kept.lines = [InvoiceDraft.Line(description: "Huolto", unitPrice: 35)]
    let customers = [try customer("a", term: 7), try customer("b", term: 21)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: "b", customers: customers, sellerRegistered: true, kept: kept, today: "2026-10-15")
    #expect(!opening.restored)
    #expect(opening.draft.customerId == "b")
    #expect(opening.draft.paymentTermDays == 21)
}

@Test func aKeptDraftFollowsTheSellersVatStatusNow() throws {
    var kept = InvoiceDraft(customerId: "", issueDate: "2026-10-10", paymentTermDays: 14)
    kept.lines = [InvoiceDraft.Line(description: "Huolto", unitPrice: 35)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [], sellerRegistered: false, kept: kept, today: "2026-10-15")
    #expect(opening.draft.lines.map(\.vatRate) == [0])
}

@Test func anEditedInvoiceOpensOnItsOwnLinesAndIsNotDirty() throws {
    let invoice = try editedInvoice()
    var kept = InvoiceDraft(customerId: "", issueDate: "2026-10-10", paymentTermDays: 14)
    kept.lines = [InvoiceDraft.Line(description: "Kesken", unitPrice: 1)]
    let opening = InvoiceForm.opening(existing: invoice, presetCustomerId: nil, customers: [], sellerRegistered: true, kept: kept, today: "2026-10-15")
    // A kept new invoice never replaces an edited one.
    #expect(!opening.restored)
    #expect(opening.draft.customerId == invoice.customer.id)
    #expect(opening.draft.issueDate == "2026-10-02")
    #expect(opening.draft.paymentTermDays == 14)
    #expect(opening.draft.lines.map(\.description) == ["Ripsienpidennys", "Huolto"])
    #expect(opening.draft.lines.map { opening.priceTexts[$0.id] } == ["89,00", "35,86"])
    #expect(opening.baseline == opening.draft)
}

@Test func anOldFourteenPercentLineDatedIn2026OpensAtThirteenAndAHalfWithoutCountingAsAChange() throws {
    var kept = InvoiceDraft(customerId: "", issueDate: "2026-01-05", paymentTermDays: 14)
    kept.lines = [InvoiceDraft.Line(description: "Kirja", unitPrice: 20, vatRate: 14)]
    let opening = InvoiceForm.opening(existing: nil, presetCustomerId: nil, customers: [], sellerRegistered: true, kept: kept, today: "2026-01-05")
    #expect(opening.draft.lines.map(\.vatRate) == [Decimal(string: "13.5")!])
}
