import Testing
import Foundation
@testable import LashKirjaCore

private func receipt(_ json: String) throws -> Receipt {
    try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
}

private let stored = #"{"id":"r1","vendor":"K-Market","date":"2026-10-02T00:00:00.000Z","category":"tarvikkeet","type":"meno","notes":null,"reference":null,"invoiceNumber":"A-1","createdAt":"2026-10-02T10:00:00.000Z","updatedAt":"2026-10-02T10:00:00.123Z","totalAmount":12.55,"vatDetails":"[{\"rate\":25.5,\"amount\":2.55}]"}"#

private func json(_ patch: ReceiptPatch) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Any]
}

@Test func receiptAmountParsesFinnishAndGroupedInput() {
    #expect(ReceiptAmount.parse("24,90") == Decimal(string: "24.9"))
    #expect(ReceiptAmount.parse("1.234,50") == Decimal(string: "1234.5"))
    #expect(ReceiptAmount.parse("1,234.50") == Decimal(string: "1234.5"))
    #expect(ReceiptAmount.parse("1 234,50 €") == Decimal(string: "1234.5"))
    #expect(ReceiptAmount.parse("") == nil)
    #expect(ReceiptAmount.parse("abc") == nil)
    #expect(ReceiptAmount.field(Decimal(string: "1234.5")!) == "1234,50")
    #expect(ReceiptAmount.field(Decimal(string: "0.2")!) == "0,20")
}

@Test func vatInGrossUsesWholeCents() {
    #expect(ReceiptVat.vatInGross(Decimal(string: "12.55")!, rate: Decimal(string: "25.5")!) == Decimal(string: "2.55"))
    #expect(ReceiptVat.vatInGross(100, rate: 24) == Decimal(string: "19.35"))
    #expect(ReceiptVat.vatInGross(10, rate: 0) == 0)
}

@Test func vatRateChoicesFollowTheDate() {
    #expect(ReceiptVat.rateChoices(forDate: "2026-10-02") == [Decimal(string: "25.5")!, Decimal(string: "13.5")!, 10, 0])
    #expect(ReceiptVat.rateChoices(forDate: "2025-05-01") == [Decimal(string: "25.5")!, 14, 10, 0])
    #expect(ReceiptVat.rateChoices(forDate: "2024-08-31") == [24, 14, 10, 0])
    #expect(ReceiptVat.rateChoices(forDate: "2026-10-02", including: 24).contains(24))
    #expect(ReceiptVat.isSupported(Decimal(string: "13.5")!))
    #expect(!ReceiptVat.isSupported(12))
    #expect(ReceiptVat.rateLabel(Decimal(string: "25.5")!) == "25,5 %")
}

@Test func formFromStoredReceipt() throws {
    let form = ReceiptForm(receipt: try receipt(stored))
    #expect(form.vendor == "K-Market")
    #expect(form.date == "2026-10-02")
    #expect(form.totalText == "12,55")
    #expect(form.vatRows.count == 1)
    #expect(form.vatRows[0].auto) // equals the VAT of the total, so it keeps following it
    #expect(form.invoiceNumber == "A-1")
    #expect(form.isKnownCategory)
}

@Test func unchangedFormMakesNoPatch() throws {
    let r = try receipt(stored)
    let form = ReceiptForm(receipt: r)
    #expect(form.makePatch(baseline: form, expectedUpdatedAt: r.updatedAt) == .unchanged)
}

@Test func patchCarriesOnlyChangedFieldsAndVersion() throws {
    let r = try receipt(stored)
    let baseline = ReceiptForm(receipt: r)
    var form = baseline
    form.vendor = "  Lidl "
    form.notes = "Kahvit"
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: r.updatedAt) else {
        Issue.record("expected a patch"); return
    }
    let body = try json(patch)
    #expect(body["vendor"] as? String == "Lidl")
    #expect(body["notes"] as? String == "Kahvit")
    #expect(body["expectedUpdatedAt"] as? String == "2026-10-02T10:00:00.123Z")
    #expect(body["totalAmount"] == nil)
    #expect(body["vatDetails"] == nil)
    #expect(body["category"] == nil)
    #expect(body.count == 3)
}

@Test func clearedOptionalTextIsSentAsNull() throws {
    let r = try receipt(stored)
    let baseline = ReceiptForm(receipt: r)
    var form = baseline
    form.invoiceNumber = "  "
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected a patch"); return
    }
    let body = try json(patch)
    #expect(body["invoiceNumber"] is NSNull)
    #expect(body["expectedUpdatedAt"] == nil)
}

@Test func autoVatFollowsTheTotal() throws {
    let r = try receipt(stored)
    let baseline = ReceiptForm(receipt: r)
    var form = baseline
    form.setTotal("20,00")
    #expect(form.vatRows[0].amountText == "4,06")
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected a patch"); return
    }
    let body = try json(patch)
    #expect((body["totalAmount"] as? NSNumber)?.doubleValue == 20)
    let vat = try #require(body["vatDetails"] as? [[String: Any]])
    #expect((vat[0]["amount"] as? NSNumber)?.doubleValue == 4.06)
    #expect((vat[0]["rate"] as? NSNumber)?.doubleValue == 25.5)
}

@Test func handTypedVatStopsFollowing() throws {
    var form = ReceiptForm(receipt: try receipt(stored))
    form.setVatAmount("2,00", at: 0)
    form.setTotal("30")
    #expect(form.vatRows[0].amountText == "2,00")
    #expect(!form.vatRows[0].auto)
}

@Test func vatRowsAddAndRemove() throws {
    var form = ReceiptForm(receipt: try receipt(stored))
    form.removeVatRow(at: 0)
    #expect(form.vatRows.isEmpty)
    form.addVatRow()
    #expect(form.vatRows.count == 1)
    #expect(form.vatRows[0].rate == Decimal(string: "25.5"))
    #expect(form.vatRows[0].amountText == "2,55")
    form.addVatRow()
    #expect(form.vatRows.count == 2)
    #expect(form.vatRows[1].amountText == "")
    #expect(!form.vatRows[0].auto)
    form.setRate(Decimal(string: "13.5")!, at: 1)
    #expect(form.vatRows[1].rate == Decimal(string: "13.5"))
}

@Test func removedVatIsSentAsEmptyList() throws {
    let baseline = ReceiptForm(receipt: try receipt(stored))
    var form = baseline
    form.removeVatRow(at: 0)
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected a patch"); return
    }
    #expect((try json(patch)["vatDetails"] as? [Any])?.isEmpty == true)
}

@Test func formValidationMirrorsTheWeb() throws {
    let baseline = ReceiptForm(receipt: try receipt(stored))
    var form = baseline
    form.vendor = " "
    form.totalText = "0"
    form.category = ""
    guard case .invalid(let errors) = form.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected invalid"); return
    }
    #expect(errors["vendor"] == "Myyjä on pakollinen.")
    #expect(errors["totalAmount"] == "Summan pitää olla suurempi kuin nolla.")
    #expect(errors["category"] == "Valitse kategoria.")

    var vat = baseline
    vat.addVatRow()
    guard case .invalid(let vatErrors) = vat.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected invalid"); return
    }
    #expect(vatErrors["vat-1"] == "Anna ALV-summa tai poista rivi.")

    var big = baseline
    big.setVatAmount("50", at: 0)
    guard case .invalid(let bigErrors) = big.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected invalid"); return
    }
    #expect(bigErrors["vat-0"] == "ALV-summa ei voi olla suurempi kuin kuitin summa.")

    var rate = baseline
    rate.setRate(12, at: 0)
    guard case .invalid(let rateErrors) = rate.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected invalid"); return
    }
    #expect(rateErrors["vat-0"]?.contains("ei ole tuettu") == true)
}

@Test func offListStoredRateDoesNotBlockOtherEdits() throws {
    let old = try receipt(#"{"id":"r2","vendor":"X","date":"2026-10-02","category":"muut","type":"meno","createdAt":"a","updatedAt":"b","totalAmount":10,"vatDetails":[{"rate":12,"amount":1.07}]}"#)
    let baseline = ReceiptForm(receipt: old)
    var form = baseline
    form.notes = "ok"
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: nil) else {
        Issue.record("expected a patch"); return
    }
    #expect(try json(patch)["vatDetails"] == nil)
}

@Test func receiptCategoriesMatchTheWeb() {
    #expect(ReceiptCategory.all.count == 21)
    #expect(ReceiptCategory.label(for: "puhelin/netti") == "Puhelin & data")
    #expect(ReceiptCategory.label(for: "oma juttu") == "oma juttu")
    #expect(ReceiptCategory.isKnown("muut"))
}

@Test func saveFailureClassification() {
    let conflict = LKError(status: 409, code: "CONFLICT", message: "Tiedot ovat muuttuneet toisessa näkymässä. Lataa tiedot uudelleen ennen tallennusta.")
    #expect(ReceiptSaveFailure(conflict) == .versionConflict(conflict.message))
    let locked = LKError(status: 409, code: "PERIOD_LOCKED", message: "Kausi lokakuu 2026 on suljettu")
    #expect(ReceiptSaveFailure(locked) == .periodLocked(locked.message))
    let fields = LKError(status: 400, code: "VALIDATION_ERROR", message: "Virhe", fields: ["vendor": "Liian pitkä"])
    #expect(ReceiptSaveFailure(fields) == .fields(["vendor": "Liian pitkä"], "Virhe"))
    let other = LKError(status: 500, message: "Palvelinvirhe")
    #expect(ReceiptSaveFailure(other) == .other("Palvelinvirhe"))
}
