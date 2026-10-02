import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

// MARK: - Feed month selection

@Test func feedMonthChoicesAreTheLastTwelveNewestFirst() {
    let choices = BankFeed.monthChoices(current: "2026-02", count: 12)
    #expect(choices.count == 12)
    #expect(choices.first == "2026-02")
    #expect(choices[1] == "2026-01")
    #expect(choices.last == "2025-03")
}

@Test func feedQueryCarriesTheMonthOnlyWhenChosen() {
    #expect(BankFeed.query(month: nil) == [:])
    #expect(BankFeed.query(month: "") == [:])
    #expect(BankFeed.query(month: "2026-09") == ["month": "2026-09"])
}

@Test func monthLabelIsCapitalisedFinnish() {
    #expect(StatementText.month("2026-10") == "Lokakuu 2026")
    #expect(StatementText.month(nil) == "Ei kuukautta")
    #expect(StatementText.month("x") == "x")
}

// MARK: - Matching

@Test func decodesCandidates() throws {
    let r = try decode(BankMatchCandidates.self, #"""
    {"candidates":[{"score":0.87,"reasons":["Summa täsmää"],"receipt":{"id":"r1","vendor":"K-Market","date":"2026-10-01T00:00:00.000Z","totalAmountCents":1250,"type":"meno","reference":null,"invoiceNumber":null,"fileName":"k.jpg","totalAmount":12.5}},
                   {"score":0.4,"reasons":[],"receipt":null}]}
    """#)
    #expect(r.candidates.count == 2)
    let first = try #require(r.candidates.first)
    #expect(first.receipt?.totalAmount == Decimal(string: "12.5"))
    #expect(first.percent == 87)
    #expect(first.receipt.map(BankMatchText.receiptLabel) == "K-Market · 12,50\u{00A0}€ · 1.10.2026")
    #expect(r.usable.count == 1)
}

@Test func receiptLabelFallsBackToKuitti() {
    let receipt = BankMatchCandidate.Receipt(id: "x", vendor: nil, date: nil, totalAmount: nil)
    #expect(BankMatchText.receiptLabel(receipt) == "Kuitti")
}

@Test func runSummaryMatchesTheWeb() throws {
    let r = try decode(BankMatchRunResult.self, #"{"ok":true,"autoConfirmed":2,"suggested":1,"draftsCreated":1}"#)
    #expect(r.summary == "2 kohdistettu automaattisesti · 1 ehdotusta odottaa · 1 uusi myyntiehdotus odottaa")
    let many = try decode(BankMatchRunResult.self, #"{"ok":true,"autoConfirmed":0,"suggested":0,"draftsCreated":3}"#)
    #expect(many.summary == "3 uutta myyntiehdotusta odottaa")
    let none = try decode(BankMatchRunResult.self, #"{"ok":true,"autoConfirmed":0,"suggested":0}"#)
    #expect(none.summary == nil)
}

@Test func confirmAllBodyOmitsMissingScope() throws {
    #expect(try encodedObject(BankConfirmAllRequest()).isEmpty)
    let month = try encodedObject(BankConfirmAllRequest(periodMonth: "2026-09"))
    #expect(month["periodMonth"] as? String == "2026-09")
    #expect(month["statementId"] == nil)
    let statement = try encodedObject(BankConfirmAllRequest(statementId: "s1"))
    #expect(statement["statementId"] as? String == "s1")
}

@Test func confirmAllMessage() throws {
    let r = try decode(BankConfirmAllResult.self, #"{"ok":true,"confirmed":3}"#)
    #expect(r.message == "3 kuittia kohdistettu")
    #expect(try decode(BankConfirmAllResult.self, #"{"ok":true,"confirmed":0}"#).message == nil)
}

@Test func confirmableSuggestionsSkipSales() throws {
    let list = try JSONDecoder().decode(StatementList.self, from: Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/statements.json")))
    let rows = list.statements.flatMap(\.transactions)
    // The fixture's only suggestion is a recognised sale, which confirm-all leaves alone.
    #expect(BankFeed.confirmableSuggestions(rows) == 0)
    #expect(rows.contains { $0.matchCandidates != nil })
}

@Test func searchMoreOnlyForOpenNonTransferRows() throws {
    func row(_ type: String, _ status: String) throws -> BankTransaction {
        try decode(BankTransaction.self, #"{"id":"t","statementId":"s","date":null,"counterparty":null,"reference":null,"message":null,"type":"\#(type)","amount":-5,"receiptId":null,"suggestedReceiptId":null,"matchStatus":"\#(status)","source":"file"}"#)
    }
    #expect(BankFeed.canSearchReceipts(try row("meno", "unmatched")))
    #expect(BankFeed.canSearchReceipts(try row("meno", "suggested")))
    #expect(!BankFeed.canSearchReceipts(try row("oma_siirto", "unmatched")))
    #expect(!BankFeed.canSearchReceipts(try row("meno", "confirmed")))
    #expect(!BankFeed.canSearchReceipts(try row("meno", "ignored")))
}

// MARK: - Statement detail

@Test func statementTitleAndTransfers() throws {
    let s = try decode(StatementResponse.self, #"""
    {"statement":{"id":"s1","fileName":"a.csv","fileType":"enablebanking","periodMonth":"2026-09","uploadedAt":"2026-10-01T00:00:00Z",
     "bankAccount":{"id":"b","name":"Käyttötili","bankName":"Nordea","iban":"FI2112345600000785","currency":"EUR"},
     "transactions":[],"totals":{"income":10,"expenses":-4,"transfers":100,"net":6,"txCount":2}}}
    """#).statement
    #expect(StatementText.title(s) == "Pankkiyhteys · Syyskuu 2026")
    #expect(s.totals?.transfers == 100)
    #expect(s.bankAccount?.bankName == "Nordea")
}

@Test func deleteCopyMentionsSalesAndInvoices() throws {
    let rows = try decode([BankTransaction].self, #"""
    [{"id":"a","statementId":"s","date":null,"counterparty":null,"reference":null,"message":null,"type":"tulo","amount":5,"receiptId":null,"suggestedReceiptId":"r","matchStatus":"suggested","source":"file","settlesInvoice":false,"suggestedReceipt":{"id":"r","vendor":null,"totalAmount":5,"source":"auto_income"}},
     {"id":"b","statementId":"s","date":null,"counterparty":null,"reference":null,"message":null,"type":"tulo","amount":5,"receiptId":null,"suggestedReceiptId":null,"matchStatus":"unmatched","source":"file","settlesInvoice":true}]
    """#)
    let text = StatementText.deleteDescription(title: "Tiliote · Syyskuu 2026", rows: rows)
    #expect(text.hasPrefix("Tiliote · Syyskuu 2026 ja kaikki sen tapahtumat poistetaan pysyvästi."))
    #expect(text.contains("hyväksymättömät myyntiehdotukset"))
    #expect(text.contains("Osa tapahtumista on maksanut laskuja."))
    #expect(text.hasSuffix("Tätä ei voi perua."))
    let plain = StatementText.deleteDescription(title: "Tiliote", rows: [])
    #expect(plain == "Tiliote ja kaikki sen tapahtumat poistetaan pysyvästi. Tätä ei voi perua.")
}

@Test func reinferMessage() throws {
    let r = try decode(StatementReinferResult.self, #"{"ok":true,"updated":2,"statement":null}"#)
    #expect(r.message == "2 tapahtuman tyyppi päivitetty")
    #expect(try decode(StatementReinferResult.self, #"{"ok":true,"updated":0}"#).message == "Tyypit olivat jo ajan tasalla")
}

@Test func periodLockIsRecognised() {
    #expect(LKError(status: 409, code: "PERIOD_LOCKED", message: "Kausi on suljettu").isPeriodLocked)
    #expect(!LKError(status: 409, code: "CONFLICT", message: "x").isPeriodLocked)
}

// MARK: - Bank accounts

@Test func ibanValidation() {
    #expect(BankIBAN.normalize(" fi21 1234-5600 0007 85 ") == "FI2112345600000785")
    #expect(BankIBAN.isValid("FI21 1234 5600 0007 85"))
    #expect(!BankIBAN.isValid("FI21 1234 5600 0007 86"))
    #expect(!BankIBAN.isValid("FI21 1234 5600 0007 8"))
    #expect(BankIBAN.mask("FI2112345600000785") == "FI•••• 0785")
    #expect(BankIBAN.format("FI2112345600000785") == "FI21 1234 5600 0007 85")
}

@Test func accountDraftValidatesLikeTheWeb() throws {
    var draft = BankAccountDraft()
    draft.openingDate = "2026-01-01"
    if case .failure(let errors) = draft.validate() {
        #expect(errors.name == "Anna tilille nimi.")
    } else { Issue.record("empty name accepted") }

    draft.name = "  Käyttötili "
    draft.iban = "fi21 1234 5600 0007 85"
    draft.openingBalance = "1 250,50"
    draft.currency = "eur"
    draft.bic = "nd eafihh"
    let payload = try draft.validate().get()
    #expect(payload.name == "Käyttötili")
    #expect(payload.iban == "FI2112345600000785")
    #expect(payload.openingBalance == Decimal(string: "1250.5"))
    #expect(payload.currency == "EUR")
    #expect(payload.bankName == nil)
    let json = try encodedObject(payload)
    #expect(json["openingDate"] as? String == "2026-01-01")
    #expect(json.keys.contains("bankName"))

    draft.iban = "FI21 1234 5600 0007 86"
    draft.openingBalance = "1,234"
    draft.currency = "EU"
    if case .failure(let errors) = draft.validate() {
        #expect(errors.iban == "IBAN ei ole kelvollinen.")
        #expect(errors.openingBalance == "Enintään kaksi desimaalia.")
        #expect(errors.currency == "Valuutta on kolme kirjainta (esim. EUR).")
    } else { Issue.record("bad draft accepted") }
}

@Test func accountDraftFromExisting() throws {
    let a = try decode(BankAccount.self, #"{"id":"a","name":"Kassa","bankName":null,"iban":null,"bic":null,"currency":"EUR","openingBalance":12.5,"openingDate":"2026-01-01","isDefault":true,"archivedAt":null,"currentBalance":40,"statementCount":2,"mismatchCount":1,"lastReconciledMonth":"2026-08"}"#)
    #expect(a.isDefault == true)
    #expect(a.statementCount == 2)
    let draft = BankAccountDraft(account: a)
    #expect(draft.openingBalance == "12,50")
    #expect(draft.openingDate == "2026-01-01")
    #expect(BankAccountText.subtitle(a) == "Ei IBANia · Oletus · 1 kk ei täsmää · Saldo täsmää Elokuu 2026 · 2 tiliotetta")
}

@Test func accountRemovalCopy() throws {
    let archived = try decode(BankAccountRemoval.self, #"{"ok":true,"deleted":false,"archived":true,"statementCount":3}"#)
    #expect(archived.message == "Tilillä on 3 tiliotetta, joten se arkistoitiin poiston sijaan.")
    let deleted = try decode(BankAccountRemoval.self, #"{"ok":true,"deleted":true,"archived":false,"statementCount":0}"#)
    #expect(deleted.message == "Pankkitili poistettiin.")
}

@Test func balanceInputParses() throws {
    let body = try BankBalanceInput.make(month: "2026-09", amount: "−1 200,5")
    #expect(body.closingBalance == Decimal(string: "-1200.5"))
    #expect(throws: LKError.self) { try BankBalanceInput.make(month: "2026-09", amount: "abc") }
    #expect(throws: LKError.self) { try BankBalanceInput.make(month: "2026-9", amount: "1") }
}

@Test func decodesRollforward() throws {
    let r = try decode(BankRollforward.self, #"""
    {"months":[{"month":"2026-09","opening":0,"openingSource":"opening_balance","income":10,"expense":-2,"net":8,"txCount":2,"computedClosing":8,"reportedClosing":null,"difference":null,"status":"unreported"}],
     "currentBalance":8,"lastReconciledMonth":null,"mismatchMonths":[],"unreportedMonths":["2026-09"],"excluded":{"undatedTxCount":0,"preOpeningTxCount":0,"preOpeningAmount":0}}
    """#)
    #expect(r.months.first?.statusLabel == "Ei saldoa")
    #expect(r.months.first?.computedClosing == 8)
}

// MARK: - Statement rows

@Test func rowDeleteCopy() throws {
    let row = try decode(BankTransaction.self, #"{"id":"b","statementId":"s","date":null,"counterparty":null,"reference":null,"message":null,"type":"tulo","amount":5,"receiptId":null,"suggestedReceiptId":null,"matchStatus":"unmatched","source":"file","settlesInvoice":true}"#)
    #expect(StatementText.deleteRowDescription(row) == "Tapahtuma poistetaan pysyvästi. Tapahtuma on maksanut laskun. Lasku jää maksetuksi, ja siitä tehty hyväksytty myynti merkitään hylätyksi, jotta myynti ei tuplaannu.")
}

@Test func rowPatchNormalisesSignAndSendsNulls() throws {
    let tulo = try StatementRowPatch.make(transactionId: "t", counterparty: " ", date: nil, amount: "−12,50", type: "tulo", message: "")
    #expect(tulo.amount == Decimal(string: "12.5"))
    let json = try encodedObject(tulo)
    #expect(json["counterparty"] is NSNull)
    #expect(json["date"] is NSNull)
    #expect(json["message"] is NSNull)
    #expect(json["type"] as? String == "tulo")
    let meno = try StatementRowPatch.make(transactionId: "t", counterparty: "K-Market", date: "2026-10-01", amount: "12,5", type: "meno", message: "x")
    #expect(meno.amount == Decimal(string: "-12.5"))
    #expect(meno.counterparty == "K-Market")
    let siirto = try StatementRowPatch.make(transactionId: "t", counterparty: nil, date: nil, amount: "100", type: "oma_siirto", message: nil)
    #expect(siirto.amount == 100)
    #expect(throws: LKError.self) { try StatementRowPatch.make(transactionId: "t", counterparty: nil, date: nil, amount: "x", type: "meno", message: nil) }
}
