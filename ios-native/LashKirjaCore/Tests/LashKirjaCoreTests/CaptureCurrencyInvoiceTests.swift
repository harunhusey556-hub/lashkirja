import Testing
import Foundation
@testable import LashKirjaCore

// W23 (W22's open points D and G): the capture form has a currency, and the owner is told when a
// saved bill became an ostolasku.

private func decodeSave(_ json: String) throws -> ReceiptSaveResult {
    try JSONDecoder().decode(ReceiptSaveResult.self, from: Data(json.utf8))
}

private func extracted(_ json: String) throws -> Extracted {
    try JSONDecoder().decode(Extracted.self, from: Data(json.utf8))
}

/// A dollar bill as the reading hands it over: euros priced by the rate the document printed.
private let usdReading = #"{"vendor":"OpenCode","date":"2026-07-12","totalAmount":43.74,"type":"meno","category":"ohjelmistot","currency":"usd","originalAmount":49.99,"fxRate":0.875,"fxRateDate":"2026-07-12","fxSource":"document"}"#

private func body(_ draft: ReceiptDraft, keepingReading: Bool = false) throws -> [String: Any] {
    let encoder = JSONEncoder()
    if keepingReading { encoder.userInfo[ReceiptDraft.keepsReadingKey] = true }
    guard let json = try JSONSerialization.jsonObject(with: encoder.encode(draft)) as? [String: Any] else {
        throw LKError(status: 0, message: "not a JSON object")
    }
    return json
}

// MARK: The save answer (G)

@Suite struct SaveAnswerInvoiceTests {
    @Test func aBillFiledAsAnOstolaskuNamesItsDueDate() throws {
        let answer = try decodeSave(#"{"ok":true,"receipt":{"id":"r1","vendor":"Sähkö Oy","totalAmount":120},"purchaseInvoice":{"id":"p1","supplierName":"Sähkö Oy","issueDate":"2026-10-01","dueDate":"2026-10-14","status":"open","gross":120,"isCreditNote":false,"payments":[]},"purchaseInvoiceSkipped":null,"fx":null,"autoApproved":true}"#)
        #expect(answer.receipt.id == "r1")
        #expect(answer.approved)
        #expect(answer.purchaseInvoice == ReceiptSaveResult.Filed(id: "p1", dueDate: "2026-10-14", isCreditNote: false))
        #expect(answer.purchaseInvoiceNote == "ostolasku luotu, eräpäivä 14.10.2026")
    }

    @Test func aCreditNoteIsNamedAsOne() throws {
        let answer = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":{"id":"p2","dueDate":"2026-10-14","isCreditNote":true},"purchaseInvoiceSkipped":null}"#)
        #expect(answer.purchaseInvoiceNote == "hyvityslasku luotu")
    }

    @Test func aBillWithoutAUsableDueDateStillSaysItWasFiled() throws {
        let answer = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":{"id":"p1"}}"#)
        #expect(answer.purchaseInvoiceNote == "ostolasku luotu")
        let odd = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":{"id":"p1","dueDate":"huomenna"}}"#)
        #expect(odd.purchaseInvoiceNote == "ostolasku luotu")
    }

    @Test func aDuplicateBillIsSaidAndOtherReasonsAreNot() throws {
        let duplicate = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":null,"purchaseInvoiceSkipped":"duplicate"}"#)
        #expect(duplicate.purchaseInvoice == nil)
        #expect(duplicate.purchaseInvoiceNote == "ostolaskua ei luotu, sama lasku on jo ostolaskuissa")
        for reason in ["not_an_invoice", "sales_document", "no_supplier", "no_date", "no_amount", "already_filed"] {
            let answer = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":null,"purchaseInvoiceSkipped":"\#(reason)"}"#)
            #expect(answer.purchaseInvoiceNote == nil)
        }
    }

    @Test func anOlderServerSaysNothingAboutBills() throws {
        let answer = try decodeSave(#"{"ok":true,"receipt":{"id":"r1"}}"#)
        #expect(answer.purchaseInvoice == nil && answer.purchaseInvoiceSkipped == nil)
        #expect(answer.purchaseInvoiceNote == nil)
        #expect(answer.autoApproved == nil)
    }

    @Test func aSurpriseInTheExtrasNeverMakesASavedReceiptLookFailed() throws {
        // The receipt exists already; failing to read the bill must not read as a failed save.
        let answer = try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":"x","purchaseInvoiceSkipped":7,"autoApproved":false}"#)
        #expect(answer.receipt.id == "r1")
        #expect(answer.purchaseInvoiceNote == nil)
        #expect(answer.autoApproved == false)
    }

    @Test func theSaveOutcomeCarriesTheNote() async throws {
        let filed = ReceiptSaveResult(receipt: .init(id: "r1"), autoApproved: true,
                                      purchaseInvoice: .init(id: "p1", dueDate: "2026-10-14", isCreditNote: false))
        var draft = ReceiptDraft(uploadId: "u1")
        draft.vendor = "Sähkö Oy"
        draft.totalAmount = 120
        let outcome = try await ReceiptSaving.save(draft, support: .supported, saveDuplicateAnyway: true) { _ in filed }
        #expect(outcome.invoiceNote == "ostolasku luotu, eräpäivä 14.10.2026")
        let plain = try await ReceiptSaving.save(draft, support: .supported, saveDuplicateAnyway: true) { _ in
            ReceiptSaveResult(receipt: .init(id: "r2"), autoApproved: true)
        }
        #expect(plain.invoiceNote == nil)
    }
}

// MARK: The queue row (G)

@Suite struct QueueRowInvoiceTests {
    private func savedRow(autoApproved: Bool?, duplicate: Bool = false, note: String?) -> UploadQueueRow? {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "lasku.pdf", size: 1000)])[0]
        queue.markSaved(id, autoApproved: autoApproved, duplicate: duplicate, invoiceNote: note)
        return queue.row(id)
    }

    @Test func theOutcomeAddsTheOstolaskuToTheApproval() {
        let note = "ostolasku luotu, eräpäivä 14.10.2026"
        #expect(savedRow(autoApproved: true, note: note)?.outcomeText == "Hyväksytty automaattisesti · ostolasku luotu, eräpäivä 14.10.2026")
        #expect(savedRow(autoApproved: false, note: note)?.outcomeText == "Odottaa tarkistusta · ostolasku luotu, eräpäivä 14.10.2026")
        #expect(savedRow(autoApproved: false, duplicate: true, note: note)?.outcomeText
                == "Samanlainen kuitti on jo tallennettu – odottaa tarkistusta · ostolasku luotu, eräpäivä 14.10.2026")
    }

    @Test func aServerThatSaidNothingOnApprovalStillGivesTheBill() {
        #expect(savedRow(autoApproved: nil, note: "ostolasku luotu, eräpäivä 14.10.2026")?.outcomeText
                == "Tallennettu · ostolasku luotu, eräpäivä 14.10.2026")
    }

    @Test func aPlainReceiptKeepsTheOldWords() {
        #expect(savedRow(autoApproved: true, note: nil)?.outcomeText == "Hyväksytty automaattisesti")
        #expect(savedRow(autoApproved: false, note: nil)?.outcomeText == "Odottaa tarkistusta")
        #expect(savedRow(autoApproved: nil, note: nil)?.outcomeText == nil)
    }

    @Test func onlyASavedRowSpeaksOfTheBill() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "lasku.pdf", size: 1000)])[0]
        #expect(queue.row(id)?.outcomeText == nil)
        queue.markSaved(id, autoApproved: true, invoiceNote: "ostolasku luotu")
        queue.markFailed(id, "x")
        #expect(queue.row(id)?.outcomeText == nil)
    }
}

// MARK: Currency (D)

@Suite struct CaptureCurrencyTests {
    @Test func theReadingCarriesCurrencyAmountAndRate() throws {
        let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(usdReading))
        #expect(draft.currency == "USD")
        #expect(draft.originalAmount.map(ReceiptAmount.field) == "49,99")
        #expect(draft.fx?.line == "Kurssi 1 USD = 0,8750 EUR (laskulla 12.7.2026)")
    }

    @Test func aEuroOrSilentReadingStaysInEuros() throws {
        for json in [#"{"vendor":"K-Market","totalAmount":12.9,"currency":"EUR"}"#,
                     #"{"vendor":"K-Market","totalAmount":12.9}"#,
                     #"{"vendor":"K-Market","totalAmount":12.9,"currency":"euro","originalAmount":12.9,"fxRate":1}"#] {
            let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(json))
            #expect(draft.currency == "EUR")
            #expect(draft.originalAmount == nil)
            #expect(draft.fx == nil)
        }
    }

    @Test func anUnusableRateIsNotShown() throws {
        let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"X","currency":"USD","originalAmount":10,"fxRate":0}"#))
        #expect(draft.currency == "USD" && draft.fx == nil)
    }

    @Test func codesAreNormalised() {
        #expect(ReceiptCurrency.code("usd") == "USD")
        #expect(ReceiptCurrency.code(" gbp ") == "GBP")
        for odd in [nil, "", "€", "euro", "US", "U5D", "ÅÄÖ"] { #expect(ReceiptCurrency.code(odd) == "EUR") }
        #expect(ReceiptCurrency.isForeign("sek") && !ReceiptCurrency.isForeign("eur") && !ReceiptCurrency.isForeign(nil))
    }

    @Test func thePickerKeepsACodeTheReadingFoundOffTheList() {
        #expect(ReceiptCurrency.choices(including: "EUR").first == "EUR")
        #expect(ReceiptCurrency.choices(including: "USD") == ReceiptCurrency.common)
        #expect(ReceiptCurrency.choices(including: "ZAR") == ReceiptCurrency.common + ["ZAR"])
        #expect(ReceiptCurrency.originalAmountLabel("usd") == "Summa (USD)")
    }

    @Test func theSaveBodySendsCurrencyAndOriginalAmountButNeverTheRate() throws {
        let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(usdReading))
        let json = try body(draft)
        #expect(json["currency"] as? String == "USD")
        #expect(json["originalAmount"] != nil)
        // The strict save schema refuses a key it does not know.
        #expect(json["fx"] == nil && json["fxRate"] == nil)
        // Only the copy written to the phone carries the rate.
        #expect(try body(draft, keepingReading: true)["fx"] != nil)
    }

    @Test func aEuroBodySendsEurAndNoOriginalAmount() throws {
        var draft = ReceiptDraft(uploadId: "u1")
        draft.originalAmount = 5   // a leftover of a currency switched back to euros
        let json = try body(draft)
        #expect(json["currency"] as? String == "EUR")
        #expect(json["originalAmount"] == nil)
    }

    @Test func aReadingKeptOnThePhoneKeepsItsRate() throws {
        let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(usdReading))
        let encoder = JSONEncoder()
        encoder.userInfo[ReceiptDraft.keepsReadingKey] = true
        let again = try JSONDecoder().decode(ReceiptDraft.self, from: encoder.encode(draft))
        #expect(again.fx == draft.fx && again.currency == "USD" && again.uploadId == "u1")
        #expect(again.fx?.rate == 0.875 && again.currency == "USD")
        // A reading written before the currency existed comes back in euros.
        let old = try JSONDecoder().decode(ReceiptDraft.self, from: Data(#"{"uploadId":"u0","vendor":"K-Market","type":"meno"}"#.utf8))
        #expect(old.currency == "EUR" && old.originalAmount == nil && old.fx == nil)
    }

    @Test func theStoreWritesTheRateWithTheReading() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("w23-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = UnfinishedReadingStore(directory: folder)
        let draft = ReceiptDraft(uploadId: "u1", extracted: try extracted(usdReading))
        try store.save(userId: "owner", readings: [UnfinishedReading(id: "a", name: "a.jpg", draft: draft, readAt: Date(), previewName: nil)])
        let back = store.load(userId: "owner")
        #expect(back.count == 1)
        #expect(back.first?.draft.fx == draft.fx && back.first?.draft.currency == "USD")
    }
}

@Suite struct CaptureFormCurrencyTests {
    private func usdForm() throws -> ReceiptForm {
        ReceiptForm(draft: ReceiptDraft(uploadId: "u1", extracted: try extracted(usdReading)))
    }

    private func sent(_ form: ReceiptForm) throws -> ReceiptDraft {
        guard case .draft(let draft) = form.makeDraft(uploadId: "u1") else {
            Issue.record("the form should be valid")
            throw LKError(status: 0, message: "invalid form")
        }
        return draft
    }

    @Test func theFormOpensOnTheReadingsCurrencyAndAmount() throws {
        let form = try usdForm()
        #expect(form.currency == "USD" && form.isForeign)
        #expect(form.originalAmountText == "49,99")
        #expect(form.totalText == "43,74")
        #expect(form.fxNote == "Kurssi 1 USD = 0,8750 EUR (laskulla 12.7.2026)")
    }

    @Test func theRateLineLeavesWhenItNoLongerDescribesTheForm() throws {
        var changedTotal = try usdForm()
        changedTotal.setTotal("50,00")
        #expect(changedTotal.fxNote == nil)
        var euros = try usdForm()
        euros.currency = "EUR"
        #expect(euros.fxNote == nil && !euros.isForeign)
        euros.currency = "usd"
        #expect(euros.fxNote != nil)
        // No rate in the reading: no line.
        var plain = ReceiptDraft(uploadId: "u1", extracted: try extracted(#"{"vendor":"X","currency":"USD","originalAmount":10,"totalAmount":9}"#))
        plain.category = "muut"
        #expect(ReceiptForm(draft: plain).fxNote == nil)
    }

    @Test func aSavedFormSendsWhatTheOwnerChose() throws {
        let draft = try sent(try usdForm())
        #expect(draft.currency == "USD")
        #expect(draft.originalAmount == Decimal(string: "49.99"))
        #expect(draft.totalAmount == Decimal(string: "43.74"))
        #expect(draft.fx == nil)
    }

    @Test func theOwnerCanCorrectAWrongCurrency() throws {
        var form = try usdForm()
        form.currency = "GBP"
        form.originalAmountText = "40,50"
        let draft = try sent(form)
        #expect(draft.currency == "GBP" && draft.originalAmount == Decimal(string: "40.5"))
        // Back to euros: the document's own figure is not sent.
        form.currency = "EUR"
        let euros = try sent(form)
        #expect(euros.currency == "EUR" && euros.originalAmount == nil)
    }

    @Test func aClearedOriginalAmountIsLeftForTheServerToKeep() throws {
        var form = try usdForm()
        form.originalAmountText = "  "
        let draft = try sent(form)
        #expect(draft.currency == "USD" && draft.originalAmount == nil)
    }

    @Test func anOriginalAmountThatIsNotANumberIsRefused() throws {
        var form = try usdForm()
        form.originalAmountText = "paljon"
        guard case .invalid(let errors) = form.makeDraft(uploadId: "u1") else {
            Issue.record("a text is no amount")
            return
        }
        #expect(errors["originalAmount"] == ReceiptCurrency.invalidAmountMessage)
        // In euros the field is not asked for, so its text is not checked.
        form.currency = "EUR"
        if case .invalid = form.makeDraft(uploadId: "u1") { Issue.record("a euro form ignores the original amount") }
    }

    @Test func aFormWithoutAReadingStartsInEuros() {
        let form = ReceiptForm(draft: ReceiptDraft(uploadId: "u1"))
        #expect(form.currency == "EUR" && !form.isForeign && form.originalAmountText.isEmpty && form.fxNote == nil)
    }
}
