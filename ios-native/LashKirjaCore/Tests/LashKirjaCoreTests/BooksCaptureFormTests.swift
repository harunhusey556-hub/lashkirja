import Testing
import Foundation
@testable import LashKirjaCore

private func extracted(_ json: String) throws -> Extracted {
    try JSONDecoder().decode(Extracted.self, from: Data(json.utf8))
}

@Test func newReceiptWithoutReadVatGetsTheDefaultRowOfTheDate() throws {
    let form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.55,"type":"meno","category":"tarvikkeet"}"#)))
    #expect(form.vendor == "K-Market")
    #expect(form.totalText == "12,55")
    #expect(form.category == "tarvikkeet")
    #expect(form.vatRows.count == 1)
    #expect(form.vatRows[0].rate == Decimal(string: "25.5"))
    #expect(form.vatRows[0].amountText == "2,55")
    #expect(form.vatRows[0].auto)
    #expect(form.vatRows[0].defaulted)
}

@Test func newReceiptKeepsReadVatRows() throws {
    let form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"A","date":"2025-10-03","totalAmount":12.9,"vatDetails":[{"rate":14,"amount":1.58}]}"#)))
    #expect(form.vatRows.count == 1)
    #expect(form.vatRows[0].rate == 14)
    #expect(form.vatRows[0].amountText == "1,58")
    #expect(form.vatRows[0].auto) // equals the VAT of the total
    #expect(!form.vatRows[0].defaulted)
}

@Test func defaultedRateFollowsTheDate() throws {
    var form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"A","date":"2026-10-03","totalAmount":124}"#)))
    form.setDate("2024-08-01")
    #expect(form.date == "2024-08-01")
    #expect(form.vatRows[0].rate == 24)
    #expect(form.vatRows[0].amountText == "24,00")
    // A rate chosen by hand no longer follows the date.
    form.setRate(10, at: 0)
    form.setDate("2026-10-03")
    #expect(form.vatRows[0].rate == 10)
}

@Test func vatFollowsTheTotalOnANewReceipt() throws {
    var form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: nil))
    #expect(form.vatRows.count == 1)
    #expect(form.vatRows[0].amountText == "")
    form.setTotal("10,00")
    #expect(form.vatRows[0].amountText == "2,03")
}

@Test func emptiedVatAmountFollowsTheTotalAgain() throws {
    var form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"A","date":"2026-10-03","totalAmount":10}"#)))
    form.setVatAmount("1,00", at: 0)
    #expect(!form.vatRows[0].auto)
    form.setVatAmount(" ", at: 0)
    #expect(form.vatRows[0].auto)
    form.setTotal("20")
    #expect(form.vatRows[0].amountText == "4,06")
}

@Test func pickingTheRateOfASingleRowRecomputesIt() throws {
    var form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"A","date":"2026-10-03","totalAmount":10}"#)))
    form.setVatAmount("1,00", at: 0)
    form.setRate(0, at: 0)
    #expect(form.vatRows[0].amountText == "0,00")
    #expect(form.vatRows[0].auto)
}

@Test func newReceiptDraftCarriesTheFormAndChecksIt() throws {
    var form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.55,"type":"meno","category":"oma"}"#)))
    form.notes = " Kahvit "
    guard case .draft(let draft) = form.makeDraft(uploadId: "u1") else { Issue.record("expected a draft"); return }
    #expect(draft.uploadId == "u1")
    #expect(draft.totalAmount == Decimal(string: "12.55"))
    #expect(draft.vatDetails == [VatDetail(rate: Decimal(string: "25.5")!, amount: Decimal(string: "2.55")!)])
    #expect(draft.category == "oma")
    #expect(draft.date == "2026-10-03")
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
    #expect(json["notes"] as? String == "Kahvit")

    var empty = form
    empty.vendor = ""
    empty.category = ""
    empty.setVatAmount("", at: 0)
    empty.setTotal("")
    guard case .invalid(let errors) = empty.makeDraft(uploadId: "u1") else { Issue.record("expected invalid"); return }
    #expect(errors["vendor"] == "Myyjä on pakollinen.")
    #expect(errors["category"] == "Valitse kategoria.")
    #expect(errors["totalAmount"] == "Summa on pakollinen.")

    var big = form
    big.setVatAmount("50", at: 0)
    guard case .invalid(let bigErrors) = big.makeDraft(uploadId: "u1") else { Issue.record("expected invalid"); return }
    #expect(bigErrors["vat-0"] == ReceiptVat.tooLargeMessage)

    var blank = form
    blank.addVatRow()
    guard case .invalid(let blankErrors) = blank.makeDraft(uploadId: "u1") else { Issue.record("expected invalid"); return }
    #expect(blankErrors["vat-1"] == ReceiptVat.missingMessage)

    var none = form
    none.removeVatRow(at: 0)
    guard case .draft(let noVat) = none.makeDraft(uploadId: "u1") else { Issue.record("expected a draft"); return }
    #expect(noVat.vatDetails.isEmpty)
}
