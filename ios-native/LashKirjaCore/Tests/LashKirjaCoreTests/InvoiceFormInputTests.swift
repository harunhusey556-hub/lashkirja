import Testing
import Foundation
@testable import LashKirjaCore

private let d255 = Decimal(string: "25.5")!
private let d135 = Decimal(string: "13.5")!

private func customer(_ json: String) throws -> Customer {
    try JSONDecoder().decode(Customer.self, from: Data(json.utf8))
}

private func line(_ description: String = "Ripsienpidennys", quantity: Decimal = 1, price: Decimal = 50, vat: Decimal = d255) -> InvoiceDraft.Line {
    InvoiceDraft.Line(description: description, quantity: quantity, unit: "kpl", unitPrice: price, vatRate: vat)
}

// MARK: - Payment term and due date (server `dueDateFor`: issue date + term, calendar days)

@Test func invoiceFormDueDateIsTheIssueDatePlusTheTerm() {
    #expect(InvoiceForm.dueDate(issueDate: "2026-10-03", termDays: 14) == "2026-10-17")
    #expect(InvoiceForm.dueDate(issueDate: "2026-10-03", termDays: 0) == "2026-10-03")
    #expect(InvoiceForm.dueDate(issueDate: "2026-12-20", termDays: 14) == "2027-01-03")
    #expect(InvoiceForm.dueDate(issueDate: "2028-02-15", termDays: 14) == "2028-02-29")
    #expect(InvoiceForm.dueDate(issueDate: "2026-03-25", termDays: 7) == "2026-04-01")
    #expect(InvoiceForm.dueDate(issueDate: "ei päivä", termDays: 14) == nil)
}

@Test func invoiceFormTermFromAManualDueDate() {
    #expect(InvoiceForm.termDays(issueDate: "2026-10-03", dueDate: "2026-10-17") == 14)
    #expect(InvoiceForm.termDays(issueDate: "2026-10-03", dueDate: "2026-10-03") == 0)
    #expect(InvoiceForm.termDays(issueDate: "2026-12-20", dueDate: "2027-01-19") == 30)
    // Across the spring DST change the count is still whole days.
    #expect(InvoiceForm.termDays(issueDate: "2026-03-20", dueDate: "2026-04-03") == 14)
    #expect(InvoiceForm.termDays(issueDate: "2026-10-03", dueDate: "2026-10-02") == nil)
    #expect(InvoiceForm.termDays(issueDate: "2026-01-01", dueDate: "2027-01-02") == nil)
}

@Test func invoiceFormOffersTheCommonTermsAndMuu() {
    #expect(InvoiceForm.paymentTerms == [7, 14, 21, 30])
    #expect(InvoiceForm.termChoice(14) == .days(14))
    #expect(InvoiceForm.termChoice(45) == .other)
    #expect(InvoiceForm.termChoice(0) == .other)
    #expect(InvoiceForm.TermChoice.days(21).label == "21 pv")
    #expect(InvoiceForm.TermChoice.other.label == "Muu")
}

@Test func invoiceFormDueDateSummary() {
    #expect(InvoiceForm.dueSummary(issueDate: "2026-10-03", termDays: 14) == "Eräpäivä 17.10.2026 · 14 pv")
    #expect(InvoiceForm.dueSummary(issueDate: "2026-10-03", termDays: 0) == "Eräpäivä 3.10.2026 · heti")
}

// MARK: - Units

@Test func invoiceFormUnitsKeepACustomUnit() {
    #expect(InvoiceForm.units.prefix(5) == ["kpl", "h", "pv", "kk", "km"])
    #expect(InvoiceForm.unitOptions(current: "h") == InvoiceForm.units)
    #expect(InvoiceForm.unitOptions(current: "paketti") == InvoiceForm.units + ["paketti"])
    #expect(InvoiceForm.unitOptions(current: "  ") == InvoiceForm.units)
}

// MARK: - Line totals exactly as the server rounds them

@Test func invoiceFormLineNetRoundsHalfAwayFromZero() {
    #expect(InvoiceForm.lineNet(line(quantity: Decimal(string: "1.5")!, price: Decimal(string: "33.33")!)) == Decimal(string: "50")!)
    // 0,001 × 5,00 = 0,005 → 0,01 (server: 1 milli × 500 cents / 1000 = 0,5 cents → 1)
    #expect(InvoiceForm.lineNet(line(quantity: Decimal(string: "0.001")!, price: 5)) == Decimal(string: "0.01")!)
    #expect(InvoiceForm.lineNet(line(quantity: 2, price: Decimal(string: "-0.005")!)) == Decimal(string: "-0.01")!)
    #expect(InvoiceForm.lineNet(line(quantity: 3, price: Decimal(string: "19.99")!)) == Decimal(string: "59.97")!)
}

@Test func invoiceFormLineGrossAddsTheLinesVat() {
    #expect(InvoiceForm.lineGross(line(quantity: 1, price: 100, vat: d255), vatRegistered: true) == Decimal(string: "125.5")!)
    #expect(InvoiceForm.lineGross(line(quantity: 1, price: 100, vat: d255), vatRegistered: false) == 100)
}

// MARK: - Entry text with Finnish separators

@Test func invoiceFormEntryTextUsesTheComma() {
    #expect(InvoiceForm.priceText(Decimal(string: "12.5")!) == "12,50")
    #expect(InvoiceForm.priceText(1234) == "1234,00")
    #expect(InvoiceForm.quantityText(Decimal(string: "1.5")!) == "1,5")
    #expect(InvoiceForm.quantityText(2) == "2")
}

@Test func invoiceFormQuantityStepsByOneAndNeverBelowOne() {
    #expect(InvoiceForm.steppedQuantity(1, by: 1) == 2)
    #expect(InvoiceForm.steppedQuantity(Decimal(string: "1.5")!, by: 1) == Decimal(string: "2.5")!)
    #expect(InvoiceForm.steppedQuantity(1, by: -1) == 1)
    #expect(InvoiceForm.steppedQuantity(Decimal(string: "1.5")!, by: -1) == 1)
    #expect(InvoiceForm.steppedQuantity(0, by: -1) == 1)
}

// MARK: - Validation at the field (web `validateInvoiceForm` wording)

@Test func invoiceFormFieldErrorsNameTheField() {
    var draft = InvoiceDraft(customerId: "", issueDate: "2026-10-03", paymentTermDays: 14)
    let a = line("", quantity: 0)
    let b = line("Huolto", quantity: -1, price: -5)
    let c = line("Kanta", vat: 14)
    draft.lines = [a, b, c]
    let errors = InvoiceForm.fieldErrors(draft, vatRegistered: true)
    #expect(errors[.customer] == "Valitse asiakas.")
    #expect(errors[.description(a.id)] == "Kuvaus puuttuu.")
    #expect(errors[.quantity(a.id)] == "Määrä puuttuu.")
    #expect(errors[.quantity(b.id)] == "Määrä ei voi olla negatiivinen.")
    #expect(errors[.unitPrice(b.id)] == "Hinta ei voi olla negatiivinen.")
    #expect(errors[.vatRate(c.id)] == "ALV 14 % ei ole enää käytössä 1.1.2026 alkaen. Käytä ALV 13,5 %.")
    #expect(errors[.description(b.id)] == nil)
    #expect(InvoiceForm.fieldErrors(draft, vatRegistered: false)[.vatRate(c.id)] == nil)
}

@Test func invoiceFormRefusesWhatTheServerRefuses() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-03", paymentTermDays: 366)
    let a = line(quantity: Decimal(string: "1.2345")!, price: Decimal(string: "9.999")!)
    let b = line(String(repeating: "x", count: 201))
    draft.lines = [a, b]
    let errors = InvoiceForm.fieldErrors(draft, vatRegistered: true)
    #expect(errors[.dueDate] == "Maksuaika on 0–365 päivää.")
    #expect(errors[.quantity(a.id)] == "Määrässä saa olla enintään kolme desimaalia.")
    #expect(errors[.unitPrice(a.id)] == "Hinnassa saa olla enintään kaksi desimaalia.")
    #expect(errors[.description(b.id)] == "Kuvaus on liian pitkä (enintään 200 merkkiä).")
    draft.lines = []
    #expect(InvoiceForm.fieldErrors(draft, vatRegistered: true)[.lines] == "Lisää vähintään yksi rivi.")
}

@Test func invoiceFormPriceTextMustBeTypedAndReadable() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-03", paymentTermDays: 14)
    let a = line(price: 0)
    let b = line(price: 0)
    let c = line(price: 0)
    let d = line(price: 0)
    draft.lines = [a, b, c, d]
    let texts = [a.id: "", b.id: "12,5x", c.id: "0", d.id: "  "]
    let errors = InvoiceForm.fieldErrors(draft, priceTexts: texts, vatRegistered: true)
    #expect(errors[.unitPrice(a.id)] == "Hinta puuttuu.")
    #expect(errors[.unitPrice(b.id)] == "Hinta ei ole kelvollinen summa.")
    #expect(errors[.unitPrice(c.id)] == nil)
    #expect(errors[.unitPrice(d.id)] == "Hinta puuttuu.")
    // A line without a tracked text is judged by its amount alone (a restored or edited line).
    #expect(InvoiceForm.fieldErrors(draft, vatRegistered: true).isEmpty)
}

@Test func invoiceFormAValidDraftHasNoErrors() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-03", paymentTermDays: 14)
    draft.lines = [line(), line("Huolto", quantity: Decimal(string: "1.5")!, price: Decimal(string: "40.25")!, vat: d135)]
    #expect(InvoiceForm.fieldErrors(draft, vatRegistered: true).isEmpty)
}

@Test func invoiceFormFocusesTheFirstInvalidFieldInScreenOrder() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-03", paymentTermDays: 14)
    let a = line()
    let b = line("", quantity: 0)
    draft.lines = [a, b]
    let errors = InvoiceForm.fieldErrors(draft, vatRegistered: true)
    #expect(InvoiceForm.firstInvalid(errors, lines: draft.lines) == .description(b.id))
    draft.customerId = ""
    #expect(InvoiceForm.firstInvalid(InvoiceForm.fieldErrors(draft, vatRegistered: true), lines: draft.lines) == .customer)
    #expect(InvoiceForm.firstInvalid([:], lines: draft.lines) == nil)
}

@Test func invoiceFormErrorSummaryCountsTheFields() {
    #expect(InvoiceForm.errorSummary([:]) == nil)
    #expect(InvoiceForm.errorSummary([.customer: "Valitse asiakas."]) == "Valitse asiakas.")
    #expect(InvoiceForm.errorSummary([.customer: "a", .lines: "b"]) == "Tarkista 2 merkittyä kenttää.")
}

// MARK: - Line actions

@Test func invoiceFormCopiesALineBelowItWithANewIdentity() {
    let a = line("A")
    let b = line("B")
    var lines = [a, b]
    let copyId = lines.duplicateLine(at: 0)
    #expect(lines.map(\.description) == ["A", "A", "B"])
    #expect(lines[1].id == copyId)
    #expect(lines[1].id != a.id)
    #expect(lines[1].unitPrice == a.unitPrice && lines[1].vatRate == a.vatRate && lines[1].unit == a.unit)
    #expect(lines.duplicateLine(at: 9) == nil)
}

@Test func invoiceFormMovesALineUpOrDown() {
    let a = line("A"), b = line("B"), c = line("C")
    var lines = [a, b, c]
    lines.moveLine(at: 2, by: -1)
    #expect(lines.map(\.description) == ["A", "C", "B"])
    lines.moveLine(at: 0, by: -1)
    #expect(lines.map(\.description) == ["A", "C", "B"])
    lines.moveLine(at: 2, by: 1)
    #expect(lines.map(\.description) == ["A", "C", "B"])
    lines.moveLine(at: 0, by: 1)
    #expect(lines.map(\.description) == ["C", "A", "B"])
}

// MARK: - Customer search

@Test func invoiceFormCustomerSearchLooksAtNameIdAndEmail() throws {
    let a = try customer(#"{"id":"a","name":"Äänislinnan Kauneus Oy","businessId":"1234567-8","email":"info@aanis.fi","defaultPaymentTermDays":14,"updatedAt":"2026-01-01"}"#)
    let b = try customer(#"{"id":"b","name":"Matti Meikäläinen","defaultPaymentTermDays":7,"updatedAt":"2026-01-01"}"#)
    let all = [a, b]
    #expect(InvoiceForm.customers(all, matching: "").map(\.id) == ["a", "b"])
    #expect(InvoiceForm.customers(all, matching: "aanis").map(\.id) == ["a"])
    #expect(InvoiceForm.customers(all, matching: "MEIKÄ").map(\.id) == ["b"])
    #expect(InvoiceForm.customers(all, matching: "1234567").map(\.id) == ["a"])
    #expect(InvoiceForm.customers(all, matching: "info@").map(\.id) == ["a"])
    #expect(InvoiceForm.customers(all, matching: "zzz").isEmpty)
}

@Test func invoiceFormCustomerCardSubtitle() throws {
    let a = try customer(#"{"id":"a","name":"A Oy","businessId":"1234567-8","email":"a@a.fi","defaultPaymentTermDays":14,"updatedAt":"2026-01-01"}"#)
    let b = try customer(#"{"id":"b","name":"B","defaultPaymentTermDays":7,"updatedAt":"2026-01-01"}"#)
    #expect(InvoiceForm.customerDetail(a) == "Y-tunnus 1234567-8 · a@a.fi")
    #expect(InvoiceForm.customerDetail(b) == "Maksuaika 7 pv")
}

// MARK: - Keyboard order ("Seuraava") and notes

@Test func invoiceFormKeyboardMovesThroughEachLineThenTheMessage() {
    let a = line("A"), b = line("B")
    let order = InvoiceForm.textFieldOrder(lines: [a, b])
    #expect(order == [.description(a.id), .quantity(a.id), .unitPrice(a.id),
                      .description(b.id), .quantity(b.id), .unitPrice(b.id), .notes])
    #expect(InvoiceForm.field(after: .unitPrice(a.id), lines: [a, b]) == .description(b.id))
    #expect(InvoiceForm.field(after: .notes, lines: [a, b]) == nil)
    #expect(InvoiceForm.field(after: nil, lines: [a, b]) == nil)
}

@Test func invoiceFormMessageHasTheServersLimit() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-03", paymentTermDays: 14)
    draft.lines = [line()]
    draft.notes = String(repeating: "x", count: 2001)
    #expect(InvoiceForm.fieldErrors(draft, vatRegistered: true)[.notes] == "Viesti on liian pitkä (enintään 2000 merkkiä).")
}

// MARK: - "Lisää tuotteista" fills the empty last line instead of adding another

@Test func invoiceFormCatalogPickFillsAnUntouchedLastLine() {
    let filled = line("A")
    let blank = InvoiceDraft.Line.new(sellerRegistered: true)
    #expect(InvoiceForm.lineForCatalogPick([filled, blank], priceTexts: [blank.id: ""]) == 1)
    #expect(InvoiceForm.lineForCatalogPick([filled, blank], priceTexts: [blank.id: "5"]) == nil)
    #expect(InvoiceForm.lineForCatalogPick([filled], priceTexts: [:]) == nil)
    #expect(InvoiceForm.lineForCatalogPick([], priceTexts: [:]) == nil)
}
