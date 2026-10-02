import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func object(_ value: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

// MARK: - 1. Send check (GET /api/invoices/:id/send)

private let readyPreview = """
{"preview":{"recipient":"a@b.fi","gross":124.5,"dueDate":"2026-10-17","iban":"FI2112345600000785","creditNote":false,
"attachment":"Lasku-12.pdf","missing":[],"blockedReason":null,"mailboxMissing":false,"lockedMonth":null}}
"""

@Test func sendPreviewDecodesTheWebShape() throws {
    let preview = try decode(InvoiceSendPreviewResponse.self, readyPreview).preview
    #expect(preview.recipient == "a@b.fi")
    #expect(preview.gross == Decimal(string: "124.5"))
    #expect(preview.attachment == "Lasku-12.pdf")
    #expect(preview.canSend)
    #expect(preview.fix == nil)
    #expect(preview.showsDueDate)
    #expect(preview.showsIban)
}

@Test func sendPreviewOfACreditNoteHidesDueDateAndIban() throws {
    let preview = try decode(InvoiceSendPreviewResponse.self, """
    {"preview":{"recipient":"a@b.fi","gross":-20,"dueDate":null,"iban":null,"creditNote":true,"attachment":"Hyvityslasku-3.pdf","missing":[],"blockedReason":null}}
    """).preview
    #expect(!preview.showsDueDate)
    #expect(!preview.showsIban)
    #expect(preview.canSend)
}

@Test func sendPreviewNamesTheFixInTheWebOrder() throws {
    func preview(_ fields: String) throws -> InvoiceSendPreview {
        try decode(InvoiceSendPreviewResponse.self, """
        {"preview":{"recipient":null,"gross":10,"dueDate":"2026-10-17","iban":null,"attachment":"Lasku-1.pdf",\(fields)}}
        """).preview
    }
    // Seller details first, even when the e-mail is missing too.
    let seller = try preview(#""missing":["tilinumero"],"blockedReason":"Lähettäjän nimi tai tilinumero puuttuu.","mailboxMissing":true"#)
    #expect(seller.fix == .sellerDetails)
    #expect(seller.fix?.title == "Avaa yritystiedot")
    #expect(!seller.canSend)

    let email = try preview(#""missing":[],"blockedReason":"Vastaanottaja puuttuu.","mailboxMissing":true"#)
    #expect(email.fix == .customerEmail)
    #expect(email.fix?.title == "Lisää asiakkaalle sähköposti")

    let mailbox = try decode(InvoiceSendPreviewResponse.self, """
    {"preview":{"recipient":"a@b.fi","gross":10,"dueDate":null,"iban":"FI21","attachment":"Lasku-1.pdf","missing":[],
    "blockedReason":"Sähköpostitiliä ei ole yhdistetty.","mailboxMissing":true,"lockedMonth":"2026-09"}}
    """).preview
    #expect(mailbox.fix == .connectMailbox)
    #expect(mailbox.fix?.title == "Yhdistä sähköposti")
    #expect(mailbox.fix?.note == "Voit myös jakaa PDF:n tai merkitä laskun lähetetyksi toimintovalikosta.")

    let locked = try decode(InvoiceSendPreviewResponse.self, """
    {"preview":{"recipient":"a@b.fi","gross":10,"dueDate":null,"iban":"FI21","attachment":"Lasku-1.pdf","missing":[],
    "blockedReason":"Kausi syyskuu 2026 on suljettu.","mailboxMissing":false,"lockedMonth":"2026-09"}}
    """).preview
    #expect(locked.fix == .openPeriod(month: "2026-09"))
    #expect(locked.fix?.title == "Avaa kaudet")
}

@Test func sendPreviewOfACreditedInvoiceHasNoFix() throws {
    let preview = try decode(InvoiceSendPreviewResponse.self, """
    {"preview":{"recipient":"a@b.fi","gross":10,"dueDate":null,"iban":"FI21","attachment":"Lasku-1.pdf","missing":[],
    "blockedReason":"Hyvitettyä laskua ei lähetetä.","mailboxMissing":false,"lockedMonth":null}}
    """).preview
    #expect(!preview.canSend)
    #expect(preview.fix == nil)
}

// MARK: - 2. Send result

@Test func sendResultMessagesFollowTheWeb() throws {
    let sent = try decode(InvoiceSendResult.self, #"{"ok":true,"sentTo":"a@b.fi","recorded":true,"notice":null,"invoice":{}}"#)
    #expect(sent.message == "Lasku lähetettiin osoitteeseen a@b.fi.")
    #expect(!sent.isWarning)

    let replayed = try decode(InvoiceSendResult.self, #"{"ok":true,"sentTo":"a@b.fi","recorded":true,"replayed":true}"#)
    #expect(replayed.message == "Lasku oli jo lähetetty osoitteeseen a@b.fi. Toista lähetystä ei tehty.")

    let unrecorded = try decode(InvoiceSendResult.self, #"{"ok":true,"sentTo":"a@b.fi","recorded":false,"notice":null}"#)
    #expect(unrecorded.message == "Viesti lähti, mutta lähetyksen kirjausta ei saatu tallennettua. Älä lähetä samaa laskua uudelleen ennen tarkistusta.")
    #expect(unrecorded.isWarning)

    let withNotice = try decode(InvoiceSendResult.self, #"{"ok":true,"sentTo":"a@b.fi","recorded":false,"notice":"Tarkista lähetys."}"#)
    #expect(withNotice.message == "Tarkista lähetys.")
}

@Test func sendFailureSaysWhenTheOutcomeIsUnknown() {
    let network = LKError(status: 0, code: "NETWORK", message: LKError.unreachable)
    #expect(InvoiceSendResult.failureMessage(network) == "Yhteys katkesi, emmekä tiedä ehtikö viesti lähteä. Voit yrittää uudelleen: samaa laskua ei lähetetä kahdesti.")
    let refused = LKError(status: 400, message: "Vastaanottaja puuttuu.")
    #expect(InvoiceSendResult.failureMessage(refused) == "Vastaanottaja puuttuu.")
}

// MARK: - 3. Merkitse maksetuksi

@Test func salesPrimaryActionSentWithNothingOpenIsMarkPaid() {
    let action = InvoicePrimaryAction.for(status: .sent, open: 0, isCreditNote: false, reminderReady: false)
    #expect(action == .markPaid)
    #expect(action?.title == "Merkitse maksetuksi")
    // Nothing left to collect wins over the reminder flow of an invoice late by date.
    #expect(InvoicePrimaryAction.for(status: .overdue, open: 0, isCreditNote: false, reminderReady: true) == .markPaid)
    #expect(InvoicePrimaryAction.for(status: .sent, open: -5, isCreditNote: false, reminderReady: false) == .markPaid)
    #expect(InvoicePrimaryAction.for(status: .sent, open: 0, isCreditNote: true, reminderReady: false) == nil)
}

@Test func statusChangeBodies() throws {
    #expect(try object(InvoiceStatusChange.markPaid) as NSDictionary == ["status": "paid"])
    #expect(try object(InvoiceStatusChange.reopen) as NSDictionary == ["status": "sent"])
    #expect(try object(InvoiceStatusChange.close(reason: "  käteinen  ")) as NSDictionary == ["status": "paid", "closeReason": "käteinen"])
    #expect(InvoiceStatusChange.markedPaidText == "Lasku merkittiin maksetuksi")
    #expect(InvoiceStatusChange.reopenedText == "Lasku on taas avoin")
}

// MARK: - 4. Sulje perustelulla

@Test func closeReasonNeedsThreeCharacters() {
    #expect(InvoiceStatusChange.closeReasonError("ab ") == "Kirjoita perustelu, vähintään kolme merkkiä.")
    #expect(InvoiceStatusChange.closeReasonError("   ") != nil)
    #expect(InvoiceStatusChange.closeReasonError("abc") == nil)
}

@Test func closeWithReasonOnlyForASentInvoiceWithMoneyOpen() {
    #expect(InvoiceStatusChange.canClose(status: "sent", open: 10, isCreditNote: false))
    #expect(!InvoiceStatusChange.canClose(status: "sent", open: 0, isCreditNote: false))
    #expect(!InvoiceStatusChange.canClose(status: "draft", open: 10, isCreditNote: false))
    #expect(!InvoiceStatusChange.canClose(status: "paid", open: 10, isCreditNote: false))
    #expect(!InvoiceStatusChange.canClose(status: "sent", open: 10, isCreditNote: true))
}

// MARK: - 5. Seller preflight on a new invoice

@Test func sellerPreflightNamesAMissingIban() {
    for iban in [nil, "", "   "] as [String?] {
        let note = SellerPreflight.note(businessName: "Oy", firstName: nil, lastName: nil, iban: iban)
        #expect(note?.title == "Täydennä laskuttajan tiedot")
        #expect(note?.body == "Laskun voi luoda nyt, mutta sen lähettämiseen tarvitaan tilinumero. Lisää se ennen ensimmäistä lähetystä.")
        #expect(note?.missing == ["tilinumero"])
    }
    #expect(SellerPreflight.note(businessName: nil, firstName: "Liisa", lastName: nil, iban: "FI2112345600000785") == nil)
}

@Test func sellerPreflightNamesAMissingName() {
    let note = SellerPreflight.note(businessName: " ", firstName: nil, lastName: "", iban: nil)
    #expect(note?.missing == ["nimi", "tilinumero"])
    #expect(note?.body == "Laskun voi luoda nyt, mutta sen lähettämiseen tarvitaan nimi ja tilinumero. Lisää ne ennen ensimmäistä lähetystä.")
    let nameOnly = SellerPreflight.note(businessName: nil, firstName: nil, lastName: nil, iban: "FI21")
    #expect(nameOnly?.missing == ["nimi"])
    #expect(nameOnly?.body == "Laskun voi luoda nyt, mutta sen lähettämiseen tarvitaan nimi. Lisää se ennen ensimmäistä lähetystä.")
}

@Test func sellerPreflightIsSilentWithoutAProfile() throws {
    #expect(SellerPreflight.note(profile: nil) == nil)
    let profile = try decode(Profile.self, #"{"email":"a@b.fi","entityType":"toiminimi","vatRegistered":true,"firstName":"Liisa","invoiceIban":null}"#)
    #expect(SellerPreflight.note(profile: profile)?.missing == ["tilinumero"])
}

// MARK: - 6. Receivables by days late

private let agingJSON = """
{"invoices":[],"aging":{"buckets":{"not_due":{"count":2,"openCents":30000},"1-30":{"count":1,"openCents":5000},
"31-60":{"count":0,"openCents":0},"61-90":{"count":1,"openCents":2550},"90+":{"count":1,"openCents":100000}},
"totalOpenCents":137550,"overdueCents":107550,"overdueCount":3,"totalOpen":1375.5,"overdue":1075.5,"paidRecentCents":42000}}
"""

@Test func receivablesSegmentsFollowTheWebBar() throws {
    let aging = try decode(InvoiceList.self, agingJSON).aging
    let segments = aging.segments
    #expect(segments.map(\.filter) == [.paid, .sent, .overdue])
    #expect(segments.map(\.label) == ["Maksettu 90 pv", "Odottaa maksua", "Myöhässä"])
    #expect(segments.map(\.amount) == [420, 300, Decimal(string: "1075.5")!])
}

@Test func receivablesWithoutPaidFigureLeaveThePaidPartOut() throws {
    let aging = try decode(InvoiceList.self, """
    {"invoices":[],"aging":{"totalOpen":10,"overdue":4,"overdueCount":1}}
    """).aging
    #expect(aging.segments.map(\.filter) == [.sent, .overdue])
    // Without buckets, the waiting part is what is open and not late.
    #expect(aging.segments.first?.amount == 6)
    #expect(aging.lateBuckets.isEmpty)
}

@Test func receivablesLateBucketsByDaysLate() throws {
    let aging = try decode(InvoiceList.self, agingJSON).aging
    let buckets = aging.lateBuckets
    #expect(buckets.map(\.bucket) == [.days1to30, .days31to60, .days61to90, .over90])
    #expect(buckets.map(\.label) == ["1–30 pv", "31–60 pv", "61–90 pv", "yli 90 pv"])
    #expect(buckets.map(\.amount) == [50, 0, Decimal(string: "25.5")!, 1000])
    #expect(buckets.map(\.count) == [1, 0, 1, 1])
}

@Test func agingBucketOfAnInvoiceByDueDate() {
    let today = "2026-10-03"
    #expect(AgingBucket.of(dueDate: "2026-10-03", today: today) == .notDue)
    #expect(AgingBucket.of(dueDate: "2026-10-10", today: today) == .notDue)
    #expect(AgingBucket.of(dueDate: "2026-10-02", today: today) == .days1to30)
    #expect(AgingBucket.of(dueDate: "2026-09-03", today: today) == .days1to30)
    #expect(AgingBucket.of(dueDate: "2026-09-02", today: today) == .days31to60)
    #expect(AgingBucket.of(dueDate: "2026-07-05", today: today) == .days61to90)
    #expect(AgingBucket.of(dueDate: "2026-07-04", today: today) == .over90)
    #expect(AgingBucket.of(dueDate: "junk", today: today) == nil)
}

// MARK: - 7. Server-side status and search

@Test func salesListQueryPassesTheWebParams() {
    #expect(SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: "") == [:])
    #expect(SalesListQuery.query(scope: InvoiceScope(), filter: .overdue, search: "  ") == ["status": "overdue"])
    #expect(SalesListQuery.query(scope: InvoiceScope(month: "2026-09", customerId: "c1"), filter: .sent, search: " Acme ")
            == ["month": "2026-09", "customerId": "c1", "status": "sent", "search": "Acme"])
    let long = String(repeating: "a", count: 100)
    #expect(SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: long)["search"]?.count == 80)
}

@Test func salesListLimitNote() {
    #expect(SalesListQuery.limitNote(rowCount: 199) == nil)
    #expect(SalesListQuery.limitNote(rowCount: 200) == "Näytetään 200 uusinta laskua. Hae tai valitse suodatin nähdäksesi muut.")
}

// MARK: - 8. Customers: archive, restore, delete outcome

@Test func customerListQueryIncludesArchivedOnRequest() {
    #expect(CustomerArchive.listQuery(includeArchived: false) == [:])
    #expect(CustomerArchive.listQuery(includeArchived: true) == ["includeArchived": "1"])
}

@Test func customerRestoreBody() throws {
    #expect(try object(CustomerArchive.Restore()) as NSDictionary == ["archived": false])
    #expect(CustomerArchive.restoredText == "Asiakas palautettiin arkistosta.")
}

@Test func customerRemovalOutcomeMessages() throws {
    let deleted = try decode(CustomerRemoval.self, #"{"ok":true,"deleted":true,"archived":false,"invoiceCount":0,"scheduleCount":0}"#)
    #expect(!deleted.archived)
    #expect(deleted.message == "Asiakas poistettiin.")

    let archived = try decode(CustomerRemoval.self, #"{"ok":true,"deleted":false,"archived":true,"invoiceCount":3,"scheduleCount":0}"#)
    #expect(archived.message == "Asiakas arkistoitiin. Sen voi palauttaa Lisää toimintoja -valikosta.")

    let paused = try decode(CustomerRemoval.self, #"{"ok":true,"deleted":false,"archived":true,"invoiceCount":0,"scheduleCount":2}"#)
    #expect(paused.message == "Asiakas arkistoitiin ja sen toistuvat laskut pysäytettiin. Asiakkaan voi palauttaa Lisää toimintoja -valikosta, toistuvat laskut jatkat Toistuvat-sivulta.")
}

@Test func customerDeleteConfirmSaysWhenItArchives() {
    #expect(CustomerArchive.deleteNote(name: "Acme", invoiceCount: 0, recurringCount: 0) == "Acme")
    #expect(CustomerArchive.deleteNote(name: "Acme", invoiceCount: 3, recurringCount: 0)
            == "Acme. Asiakkaalla on 3 laskua, joten se arkistoidaan poiston sijaan.")
    #expect(CustomerArchive.deleteNote(name: "Acme", invoiceCount: 3, recurringCount: 1)
            == "Acme. Asiakkaalla on 3 laskua, joten se arkistoidaan poiston sijaan. Toistuvat laskut pysäytetään.")
    #expect(CustomerArchive.deleteNote(name: "Acme", invoiceCount: 0, recurringCount: 1)
            == "Acme. Asiakkaalla on toistuva lasku, joten se arkistoidaan poiston sijaan ja toistuvat laskut pysäytetään.")
    #expect(CustomerArchive.deleteNote(name: "Acme", invoiceCount: 0, recurringCount: 2)
            == "Acme. Asiakkaalla on 2 toistuvaa laskua, joten se arkistoidaan poiston sijaan ja toistuvat laskut pysäytetään.")
}

@Test func customerContactLinks() {
    #expect(CustomerContact.mail("a@b.fi")?.absoluteString == "mailto:a@b.fi")
    #expect(CustomerContact.phone("+358 40 123-4567")?.absoluteString == "tel:+358401234567")
    #expect(CustomerContact.phone("abc") == nil)
    #expect(CustomerContact.maps("Katu 1, 00100 Helsinki")?.absoluteString == "https://maps.apple.com/?q=Katu%201%2C%2000100%20Helsinki")
}

@Test func customerDetailCarriesRecurringCount() throws {
    let detail = try decode(CustomerDetail.self, """
    {"customer":{"id":"c1","name":"Acme","defaultPaymentTermDays":14,"updatedAt":"2026-10-01T00:00:00Z","archivedAt":"2026-10-02T00:00:00Z"},
    "openBalance":0,"openInvoiceCount":0,"invoicedTotal":0,"invoices":[],"recurringCount":2}
    """)
    #expect(detail.recurringCount == 2)
    #expect(detail.customer.isArchived)
}
