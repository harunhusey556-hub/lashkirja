import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func object(_ value: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

private func salesFixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

// MARK: - List filters and counts

@Test func salesFilterChipsFollowTheWebOrder() {
    let counts = ["draft": 2, "sent": 3, "overdue": 1, "paid": 4, "credited": 0]
    let chips = SalesFilter.chips(counts)
    #expect(chips.map(\.filter) == [.all, .overdue, .draft, .sent, .paid])
    #expect(chips.first?.count == 10)
    #expect(chips.first(where: { $0.filter == .sent })?.count == 3)
    #expect(SalesFilter.sent.title == "Odottaa maksua")
    #expect(SalesFilter.credited.title == "Hyvitetyt")
}

@Test func salesFilterChipsShowCreditedOnlyWhenThereAreSome() {
    let chips = SalesFilter.chips(["draft": 0, "sent": 0, "overdue": 0, "paid": 0, "credited": 2])
    #expect(chips.map(\.filter).last == .credited)
    #expect(chips.last?.count == 2)
}

@Test func salesFilterChipsWithoutCountsHaveNoNumbers() {
    let chips = SalesFilter.chips(nil)
    #expect(chips.map(\.filter) == [.all, .overdue, .draft, .sent, .paid])
    #expect(chips.allSatisfy { $0.count == nil })
}

@Test func salesFilterGroupsCreditNotesWithCredited() throws {
    let list = try JSONDecoder().decode(InvoiceList.self, from: salesFixture("invoices.json"))
    let invoice = list.invoices[0]
    #expect(SalesFilter.group(of: invoice) == .draft)
    #expect(SalesFilter.draft.matches(invoice))
    #expect(SalesFilter.all.matches(invoice))
    #expect(!SalesFilter.paid.matches(invoice))
    #expect(SalesFilter.group(status: .paid, documentKind: "credit_note") == .credited)
    #expect(SalesFilter.group(status: .paid, documentKind: "invoice") == .paid)
}

// MARK: - Payment entry, bank row offer and duplicate pairs

@Test func overOpenMessageMatchesTheWeb() {
    #expect(PaymentEntryRules.overOpenMessage(amount: 100, open: 100, carriesBankRow: false) == nil)
    #expect(PaymentEntryRules.overOpenMessage(amount: Decimal(string: "100.004")!, open: 100, carriesBankRow: false) == nil)
    #expect(PaymentEntryRules.overOpenMessage(amount: 150, open: 100, carriesBankRow: true) == nil)
    #expect(PaymentEntryRules.overOpenMessage(amount: 150, open: 100, carriesBankRow: false)
        == "Summa on suurempi kuin avoin saldo 100,00\u{00A0}€. Kirjaa enintään avoin summa.")
    #expect(PaymentEntryRules.overOpenMessage(amount: 5, open: 0, carriesBankRow: false)
        == "Lasku on jo maksettu. Avoin saldo on 0,00\u{00A0}€.")
}

@Test func paymentEntryCarriesTheBankRowOnlyWhenChosen() throws {
    let plain = try object(PaymentEntry(amount: Decimal(string: "125.5")!, paidDate: "2026-10-02", transactionId: nil, note: " "))
    #expect(Set(plain.keys) == ["amount", "paidDate"])
    let linked = try object(PaymentEntry(amount: 10, paidDate: "2026-10-02", transactionId: "t1", note: "Osamaksu"))
    #expect(linked["transactionId"] as? String == "t1")
    #expect(linked["note"] as? String == "Osamaksu")
}

@Test func paymentCandidateQueryAndDecoding() throws {
    #expect(PaymentCandidates.query(amount: Decimal(string: "125.5")!, paidDate: "2026-10-02") == ["amount": "125.5", "paidDate": "2026-10-02"])
    let list = try decode(PaymentCandidates.self, #"{"candidates":[{"transactionId":"t1","date":"2026-10-01","counterparty":"Asiakas Oy","amount":125.5,"hasReceipt":true}]}"#)
    let row = try #require(list.candidates.first)
    #expect(row.amount == Decimal(string: "125.5"))
    #expect(row.summary == "Asiakas Oy · 125,50\u{00A0}€ · 1.10.2026")
    #expect(row.receiptNote == "Tapahtumasta on jo tulokuitti; yhdistäminen estää tulon laskemisen kahdesti.")
    let bare = try decode(PaymentCandidates.self, #"{"candidates":[{"transactionId":"t2","date":null,"counterparty":null,"amount":5,"hasReceipt":false}]}"#)
    #expect(bare.candidates[0].summary == "5,00\u{00A0}€")
    #expect(bare.candidates[0].receiptNote == nil)
}

@Test func paymentLinkBodies() throws {
    let link = try object(PaymentLinkRequest.link(paymentId: "p1", transactionId: "t1"))
    #expect(link as NSDictionary == ["action": "link", "paymentId": "p1", "transactionId": "t1"] as NSDictionary)
    let dismiss = try object(PaymentLinkRequest.dismiss(paymentId: "p1", receiptId: "r1"))
    #expect(dismiss as NSDictionary == ["action": "dismiss", "paymentId": "p1", "receiptId": "r1"] as NSDictionary)
}

@Test func invoiceDetailCarriesPaymentDuplicates() throws {
    let detail = try JSONDecoder().decode(InvoiceDetailResponse.self, from: salesFixture("invoice-detail.json"))
    #expect(detail.invoice.number == 1)
    let pair = try decode(PaymentDuplicate.self, #"{"receiptId":"r1","receiptVendor":"Asiakas Oy","receiptDate":"2026-10-01","amountCents":12550,"transactionId":"t1","paymentId":"p1","paidDate":"2026-10-02"}"#)
    #expect(pair.id == "r1:p1")
    #expect(pair.summary == "Tulokuitti Asiakas Oy 125,50\u{00A0}€ (1.10.2026) on kirjattu tiliotteen maksusta, joka näyttää samalta kuin tämä maksu 2.10.2026. Molemmat lasketaan nyt tuloiksi.")
    let bare = try decode(PaymentDuplicate.self, #"{"receiptId":"r1","receiptVendor":null,"receiptDate":null,"amountCents":500,"transactionId":"t1","paymentId":"p1","paidDate":"2026-10-02"}"#)
    #expect(bare.summary == "Tulokuitti 5,00\u{00A0}€ on kirjattu tiliotteen maksusta, joka näyttää samalta kuin tämä maksu 2.10.2026. Molemmat lasketaan nyt tuloiksi.")
    #expect(detail.paymentDuplicates?.isEmpty == true)
}

// MARK: - Reminders

private let reminderJSON = #"""
{"reminder":{"invoice":{"id":"i1","number":7},"level":2,"daysLate":12,"open":100,"interest":1.23,"fee":5,"total":106.23,"annualRatePercent":11.5,"dueDate":"2026-10-16","recipient":"a@b.fi","previousReminders":[{"level":1,"sentAt":"2026-09-20T08:00:00.000Z","total":105}],"nextReminderAt":"2026-10-05T21:00:00.000Z","nextReminderNote":"Uuden muistutuksen voi lähettää 6.10.2026 alkaen.","mailboxMissing":false}}
"""#

@Test func reminderPreviewDecodesAndExplainsTheWait() throws {
    let r = try decode(ReminderPreviewResponse.self, reminderJSON).reminder
    #expect(r.level == 2)
    #expect(r.total == Decimal(string: "106.23"))
    #expect(r.previousReminders.first?.level == 1)
    let before = ISO8601DateFormatter().date(from: "2026-10-04T12:00:00Z")!
    let after = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
    #expect(r.waitNote(now: before) == "Uuden muistutuksen voi lähettää 6.10.2026 alkaen.")
    #expect(r.waitNote(now: after) == nil)
    #expect(r.blockedReason(now: before) == "Uuden muistutuksen voi lähettää 6.10.2026 alkaen.")
    #expect(r.blockedReason(now: after) == nil)
}

@Test func reminderBlockedWithoutRecipientOrMailbox() throws {
    let noMail = try decode(ReminderPreview.self, #"{"level":1,"daysLate":3,"open":10,"interest":0,"fee":0,"total":10,"dueDate":"2026-10-16","recipient":null,"previousReminders":[]}"#)
    #expect(noMail.blockedReason(now: Date()) == "Asiakkaalla ei ole sähköpostiosoitetta.")
    let noBox = try decode(ReminderPreview.self, #"{"level":1,"daysLate":3,"open":10,"interest":0,"fee":0,"total":10,"dueDate":"2026-10-16","recipient":"a@b.fi","previousReminders":[],"mailboxMissing":true}"#)
    #expect(noBox.blockedReason(now: Date()) == "Sähköpostitiliä ei ole yhdistetty, joten muistutusta ei voi lähettää.")
    let sent = try decode(ReminderSendResult.self, #"{"ok":true,"sentTo":"a@b.fi","reminder":{"id":"x","level":1,"total":10,"dueDate":"2026-10-16"},"attachment":"lasku.pdf"}"#)
    #expect(sent.message == "Maksumuistutus 1 lähetettiin osoitteeseen a@b.fi")
}

// MARK: - Bank match

@Test func bankMatchPreviewAndResultTexts() throws {
    let preview = try decode(BankMatchPreview.self, #"{"applied":[],"suggestions":[{"invoiceId":"i"}],"skippedLocked":[{"invoiceId":"j"}],"preview":[{"invoiceId":"i1","invoiceNumber":3,"customerName":"A Oy","transactionId":"t","amount":12.5,"paidDate":"2026-10-01"}]}"#)
    #expect(preview.rows.count == 1)
    #expect(preview.headline == "Viitenumero täsmää yhteen maksuun. Se kirjataan laskulle:")
    #expect(preview.lockedText == "1 maksu on lukitulla kaudella, joten sitä ei kirjata. Voit avata kauden kohdassa Kirjanpito > Suljetut kaudet, jos maksu kuuluu kirjata.")
    #expect(preview.suggestionText == "Lisäksi 1 maksu täsmää summaltaan. Se ei kirjaudu automaattisesti, vaan tarkistat sen laskulla.")
    let empty = try decode(BankMatchPreview.self, #"{"applied":[],"suggestions":[],"preview":[]}"#)
    #expect(empty.headline == "Tiliotteilla ei ole maksuja, joiden viitenumero vastaisi avointa laskua.")
    #expect(empty.lockedText == nil)
    #expect(empty.suggestionText == nil)
    let lockedOnly = try decode(BankMatchPreview.self, #"{"suggestions":[],"skippedLocked":[{"a":1}],"preview":[]}"#)
    #expect(lockedOnly.headline == "Avoimille kausille ei ole kirjattavia maksuja.")
    let result = try decode(BankMatchResult.self, #"{"applied":[{"invoiceId":"i"},{"invoiceId":"j"}],"suggestions":[],"skippedLocked":[{"invoiceId":"k"},{"invoiceId":"l"}]}"#)
    #expect(result.message == "2 maksua kohdistettiin laskuille. 2 maksua on lukitulla kaudella, joten niitä ei kirjata.")
}

// MARK: - Catalog

@Test func catalogItemFillsAnInvoiceLine() throws {
    let list = try decode(CatalogList.self, #"{"items":[{"id":"c1","name":"Ripsienpidennys","unit":"kpl","unitPrice":89.9,"vatRate":14}]}"#)
    let item = try #require(list.items.first)
    #expect(item.unitPrice == Decimal(string: "89.9"))
    var line = InvoiceDraft.Line()
    line.apply(item, issueDate: "2026-10-02")
    #expect(line.description == "Ripsienpidennys")
    #expect(line.unit == "kpl")
    #expect(line.unitPrice == Decimal(string: "89.9"))
    #expect(line.vatRate == Decimal(string: "13.5"))
    line.apply(item, issueDate: "2025-12-31")
    #expect(line.vatRate == 14)
}

@Test func catalogDraftFromLine() throws {
    let line = InvoiceDraft.Line(description: "  Huolto ", quantity: 1, unit: " ", unitPrice: Decimal(string: "35.86")!, vatRate: Decimal(string: "25.5")!)
    let draft = CatalogItemDraft(line: line)
    #expect(draft.validationError == nil)
    let json = try object(draft)
    #expect(json["name"] as? String == "Huolto")
    #expect(json["unit"] as? String == "kpl")
    #expect(Set(json.keys) == ["name", "unit", "unitPrice", "vatRate"])
    #expect(CatalogItemDraft(line: InvoiceDraft.Line()).validationError == "Tallenna tuotteeksi vasta kun kuvaus ja hinta ovat kunnossa.")
    let negative = InvoiceDraft.Line(description: "X", quantity: 1, unit: "kpl", unitPrice: -1, vatRate: 0)
    #expect(CatalogItemDraft(line: negative).validationError != nil)
}

// MARK: - Customer import and merge

@Test func customerImportBodiesAndSummary() throws {
    #expect(Set(try object(CustomerImportRequest(csv: "a", commit: false)).keys) == ["csv"])
    #expect(try object(CustomerImportRequest(csv: "a", commit: true))["commit"] as? Bool == true)
    let result = try decode(CustomerImportResult.self, #"{"rows":[{"line":2,"name":"A Oy","email":null,"phone":null,"businessId":null,"errors":[]},{"line":3,"name":null,"email":"x","phone":null,"businessId":null,"errors":["Nimi puuttuu.","Sähköposti on virheellinen."]}],"created":0}"#)
    #expect(result.validCount == 1)
    #expect(result.invalidCount == 1)
    #expect(result.statusText == "1 kelvollista, 1 virheellistä (ei tuoda)")
    #expect(result.rows[0].text == "Rivi 2: A Oy. Kelvollinen")
    #expect(result.rows[1].text == "Rivi 3: –. Nimi puuttuu. Sähköposti on virheellinen.")
    #expect(CustomerImportResult.createdText(1) == "1 asiakas tuotiin")
    #expect(CustomerImportResult.createdText(4) == "4 asiakasta tuotiin")
    #expect(try object(CustomerMergeRequest(keepId: "k", mergeId: "m")) as NSDictionary == ["keepId": "k", "mergeId": "m"] as NSDictionary)
}

@Test func customerImportReadsFinnishSpreadsheetFiles() throws {
    #expect(CustomerImportRequest.text(from: Data([0xEF, 0xBB, 0xBF] + Array("nimi\nÄänekoski Oy".utf8))) == "nimi\nÄänekoski Oy")
    // Excel's Windows-1252 export: "Ä" is 0xC4.
    #expect(CustomerImportRequest.text(from: Data([0x6E, 0x0A, 0xC4, 0x61])) == "n\nÄa")
    #expect(CustomerImportRequest.sizeError("abc") == nil)
    #expect(CustomerImportRequest.sizeError(String(repeating: "a", count: 200_001)) == "Tiedosto on liian suuri (enintään 200 000 merkkiä).")
}
