import Foundation
import Testing
@testable import LashKirjaCore

private let values = [
    "asiakas": "Anna Asiakas",
    "laskunumero": "12",
    "summa": "125,50 €",
    "erapaiva": "29.1.2026",
    "viitenumero": "123",
    "tilinumero": "FI21 1234 5600 0007 85",
    "yritys": "Liisan Ripset",
]

// MARK: - Send check and body

@Test func theSendCheckCarriesTheTextAndTemplates() throws {
    let json = """
    {"preview":{"recipient":"anna@example.fi","gross":125.5,"dueDate":"2026-01-29","iban":"FI21","creditNote":false,
    "attachment":"lasku-12.pdf","missing":[],"blockedReason":null,"mailboxMissing":false,"lockedMonth":null,
    "subject":"Lasku 12 · Liisan Ripset","message":"Hei,\\n\\nliitteenä lasku 12.","templateId":"t1",
    "templates":[{"id":"t1","name":"Oma","isDefault":true}],"placeholders":{"asiakas":"Anna Asiakas"}}}
    """
    let preview = try JSONDecoder().decode(InvoiceSendPreviewResponse.self, from: Data(json.utf8)).preview
    #expect(preview.subject == "Lasku 12 · Liisan Ripset")
    #expect(preview.message == "Hei,\n\nliitteenä lasku 12.")
    #expect(preview.templates?.first == EmailTemplateRef(id: "t1", name: "Oma", isDefault: true))
    #expect(preview.placeholders?["asiakas"] == "Anna Asiakas")
}

@Test func anOlderServerWithoutTextStillDecodes() throws {
    let json = """
    {"preview":{"recipient":null,"gross":1,"dueDate":null,"iban":null,"attachment":"a.pdf","missing":[],"blockedReason":"Vastaanottaja puuttuu."}}
    """
    let preview = try JSONDecoder().decode(InvoiceSendPreviewResponse.self, from: Data(json.utf8)).preview
    #expect(preview.subject == nil)
    #expect(preview.templates == nil)
}

@Test func theBodySendsARecipientOnlyWhenTheOwnerChangedIt() throws {
    let same = InvoiceSendBody(recipient: "anna@example.fi", to: " Anna@Example.fi ", subject: "Aihe\nrivi", message: " Viesti \n")
    #expect(same.to == nil)
    #expect(same.subject == "Aihe rivi")
    #expect(same.message == "Viesti")
    let encoded = String(decoding: try JSONEncoder().encode(same), as: UTF8.self)
    #expect(!encoded.contains("\"to\""))

    let other = InvoiceSendBody(recipient: "anna@example.fi", to: "kirjanpito@example.fi", subject: "A", message: "B")
    #expect(other.to == "kirjanpito@example.fi")
}

@Test func theTextLimitsMatchTheServer() {
    #expect(InvoiceMailText.subjectError(" \n ") == "Aihe puuttuu.")
    #expect(InvoiceMailText.subjectError(String(repeating: "a", count: 200)) == nil)
    #expect(InvoiceMailText.subjectError(String(repeating: "a", count: 201)) == "Aihe on liian pitkä (enintään 200 merkkiä).")
    #expect(InvoiceMailText.messageError("  ") == "Viesti puuttuu.")
    #expect(InvoiceMailText.messageError(String(repeating: "a", count: 5000)) == nil)
    #expect(InvoiceMailText.messageError(String(repeating: "a", count: 5001)) == "Viesti on liian pitkä (enintään 5000 merkkiä).")
    // JavaScript counts UTF-16 units: an emoji is two.
    #expect(InvoiceMailText.subjectError(String(repeating: "😀", count: 101)) != nil)
    #expect(InvoiceMailText.nameError("") == "Anna mallille nimi.")
    #expect(InvoiceMailText.recipientError("anna@example.fi") == nil)
    #expect(InvoiceMailText.recipientError("anna@") == "Sähköpostiosoite ei kelpaa.")
}

@Test func aTypedAddressLiftsOnlyTheMissingRecipientBlock() throws {
    func preview(_ extra: String) throws -> InvoiceSendPreview {
        let json = """
        {"recipient":null,"gross":1,"dueDate":null,"iban":null,"attachment":"a.pdf","missing":[],"blockedReason":"Vastaanottaja puuttuu."\(extra)}
        """
        return try JSONDecoder().decode(InvoiceSendPreview.self, from: Data(json.utf8))
    }
    #expect(try preview("").canSend(typedRecipient: "anna@example.fi"))
    #expect(try !preview("").canSend(typedRecipient: ""))
    #expect(try !preview(",\"mailboxMissing\":true").canSend(typedRecipient: "anna@example.fi"))
    #expect(try !preview(",\"lockedMonth\":\"2026-08\"").canSend(typedRecipient: "anna@example.fi"))
}

// MARK: - Templates

@Test func aTemplateDraftNamesTheFirstProblem() {
    #expect(EmailTemplateDraft(name: " ", subject: "A", body: "B", isDefault: false).problem == "Anna mallille nimi.")
    #expect(EmailTemplateDraft(name: "N", subject: "", body: "B", isDefault: false).problem == "Aihe puuttuu.")
    #expect(EmailTemplateDraft(name: "N", subject: "A", body: "", isDefault: false).problem == "Viesti puuttuu.")
    #expect(EmailTemplateDraft(name: "N", subject: "A", body: "B", isDefault: true).problem == nil)
}

@Test func theTemplateListDecodes() throws {
    let json = """
    {"templates":[{"id":"t1","name":"Oma","subject":"Lasku {laskunumero}","body":"Hei {asiakas}","kind":"invoice","isDefault":true,
    "createdAt":"2026-10-03T10:00:00.000Z","updatedAt":"2026-10-03T10:00:00.000Z"}],
    "placeholders":[{"key":"asiakas","label":"Asiakkaan nimi"}]}
    """
    let list = try JSONDecoder().decode(EmailTemplateList.self, from: Data(json.utf8))
    #expect(list.templates.first?.body == "Hei {asiakas}")
    #expect(list.placeholders?.first?.token == "{asiakas}")
}

@Test func thePlaceholderHelpListsEveryPlaceholder() {
    let help = EmailPlaceholder.help()
    for key in ["asiakas", "laskunumero", "summa", "erapaiva", "viitenumero", "tilinumero", "yritys"] {
        #expect(help.contains("{\(key)}"))
    }
    #expect(help.hasPrefix("{asiakas} asiakkaan nimi"))
}

@Test func thisInvoicesValuesTurnBackIntoPlaceholders() {
    let text = "Hei Anna Asiakas,\n\nliitteenä lasku 12.\n\nSumma: 125,50 €\nEräpäivä: 29.1.2026\nViitenumero: 123\nTili FI21 1234 5600 0007 85\n\nKiitos!\nLiisan Ripset"
    #expect(EmailTemplateText.toPlaceholders(text, values: values) ==
        "Hei {asiakas},\n\nliitteenä lasku {laskunumero}.\n\nSumma: {summa}\nEräpäivä: {erapaiva}\nViitenumero: {viitenumero}\nTili {tilinumero}\n\nKiitos!\n{yritys}")
    #expect(EmailTemplateText.hasInvoiceValues(text, values: values))
}

@Test func aValueInsideALongerNumberOrWordStays() {
    // "12" is in the date, the sum and "120"; only the invoice number on its own is replaced.
    let text = "Lasku 12 / 12.1.2026 / 120 € / 1 212 / lasku12"
    #expect(EmailTemplateText.toPlaceholders(text, values: ["laskunumero": "12"]) == "Lasku {laskunumero} / 12.1.2026 / 120 € / 1 212 / lasku12")
}

@Test func emptyAndDashValuesAreNotReplaced() {
    let text = "Viite – ja A"
    #expect(EmailTemplateText.toPlaceholders(text, values: ["viitenumero": "–", "asiakas": "A", "yritys": ""]) == text)
    #expect(!EmailTemplateText.hasInvoiceValues(text, values: ["viitenumero": "–"]))
}

@Test func aPlaceholderAlreadyInTheTextIsLeftAlone() {
    #expect(EmailTemplateText.toPlaceholders("{asiakas} ja Anna Asiakas", values: ["asiakas": "Anna Asiakas", "yritys": "asiakas"]) ==
        "{asiakas} ja {asiakas}")
}

// MARK: - Send status

private func send(_ status: String, at: String, to: String = "anna@example.fi", error: String? = nil) -> Invoice.Send {
    Invoice.Send(id: UUID().uuidString, toAddress: to, status: status, error: error, createdAt: at)
}

@Test func theLatestDeliveredSendIsNamedWithItsAddressAndCount() {
    let line = InvoiceSendState.line(status: "sent", sentAt: "2026-10-03T09:05:00.000Z", sends: [
        send("sent", at: "2026-10-01T09:05:00.000Z", to: "vanha@example.fi"),
        send("sent", at: "2026-10-03T09:05:00.000Z"),
    ])
    #expect(line == .init(text: "Lähetetty sähköpostilla 3.10.2026 klo 12.05 → anna@example.fi · 2 kertaa", tone: .muted, canRetry: false))
}

@Test func aFailedSendSaysSoWithoutTheServerTextAndOffersARetry() {
    let line = InvoiceSendState.line(status: "draft", sentAt: nil, sends: [
        send("failed", at: "2026-10-03T09:05:00.000Z", error: "535 Authentication failed"),
    ])
    #expect(line?.text == "Lähetys epäonnistui 3.10.2026: vastaanottajan palvelin ei ottanut viestiä vastaan")
    #expect(line?.tone == .danger)
    #expect(line?.canRetry == true)
    #expect(line?.text.contains("535") == false)
}

@Test func aFailureAfterAnEarlierSendNamesTheEarlierOne() {
    let line = InvoiceSendState.line(status: "sent", sentAt: "2026-10-01T09:05:00.000Z", sends: [
        send("failed", at: "2026-10-03T09:05:00.000Z"),
        send("sent", at: "2026-10-01T09:05:00.000Z"),
    ])
    #expect(line?.text == "Lähetys epäonnistui 3.10.2026: vastaanottajan palvelin ei ottanut viestiä vastaan · aiemmin lähetetty 1.10.2026")
}

@Test func aSendThatMayHaveLeftIsNotRetriedWithOneTap() {
    let crashed = InvoiceSendState.line(status: "draft", sentAt: nil, sends: [
        send("failed", at: "2026-10-03T09:05:00.000Z", error: InvoiceSendState.crashedNote),
    ])
    #expect(crashed?.text.hasPrefix("Lähetys keskeytyi 3.10.2026") == true)
    #expect(crashed?.canRetry == false)
    #expect(crashed?.tone == .warning)
    let ambiguous = InvoiceSendState.line(status: "draft", sentAt: nil, sends: [send("ambiguous", at: "2026-10-03T09:05:00.000Z")])
    #expect(ambiguous?.text.hasPrefix("Lähetys jäi epäselväksi") == true)
    #expect(ambiguous?.canRetry == false)
    let open = InvoiceSendState.line(status: "draft", sentAt: nil, sends: [send("sending", at: "2026-10-03T09:05:00.000Z")])
    #expect(open?.text.hasPrefix("Lähetys kesken") == true)
}

@Test func withoutEmailTheLineSaysMarkedOrNotSent() {
    #expect(InvoiceSendState.line(status: "sent", sentAt: "2026-10-03T09:05:00.000Z", sends: [])?.text == "Merkitty lähetetyksi 3.10.2026")
    #expect(InvoiceSendState.line(status: "paid", sentAt: nil, sends: [])?.text == "Ei lähetetty")
    #expect(InvoiceSendState.line(status: "draft", sentAt: nil, sends: []) == nil)
}

@Test func historyMergesSendsAndActivityNewestFirst() {
    var delivered = send("sent", at: "2026-10-03T09:05:00.000Z")
    delivered.attachmentName = "lasku-12.pdf"
    delivered.gross = 125.5
    let items = InvoiceSendState.history(
        activity: [
            Invoice.Activity(id: "a1", kind: "created", summary: "Lasku luotiin.", createdAt: "2026-10-01T09:00:00.000Z"),
            Invoice.Activity(id: "a2", kind: "sent", summary: "Lasku lähetettiin sähköpostilla.", createdAt: "2026-10-03T09:06:00.000Z"),
        ],
        sends: [delivered, send("failed", at: "2026-10-02T09:05:00.000Z", error: "SMTP")]
    )
    #expect(items.map(\.title) == ["Lasku lähetettiin sähköpostilla.", "Lähetetty sähköpostilla", "Lähetys epäonnistui", "Lasku luotiin."])
    #expect(items[1].meta == "3.10.2026 klo 12.05, anna@example.fi, lasku-12.pdf, \(Money.format(125.5))")
    #expect(items[2].meta.contains("vastaanottajan palvelin ei ottanut viestiä vastaan"))
    #expect(!items[2].meta.contains("SMTP"))
}

@Test func theInvoiceDecodesItsBarcode() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/invoice-detail.json")
    var json = try String(contentsOf: url, encoding: .utf8)
    #expect(try JSONDecoder().decode(InvoiceDetailResponse.self, from: Data(json.utf8)).invoice.barcode == nil)
    json = json.replacingOccurrences(of: "\"sends\":[]", with: "\"sends\":[],\"barcode\":\"512345\",\"barcodeIssue\":null")
    #expect(try JSONDecoder().decode(InvoiceDetailResponse.self, from: Data(json.utf8)).invoice.barcode == "512345")
}
