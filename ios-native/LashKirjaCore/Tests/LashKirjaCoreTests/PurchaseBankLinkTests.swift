import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Test func purchaseBankCandidatesDecodeTheServerShape() throws {
    let list = try decode(PurchaseBankCandidateList.self, """
    {"candidates":[
      {"transactionId":"t1","statementId":"s1","date":"2026-01-25","counterparty":"Tukku Oy","message":"Lasku 88123","reference":null,
       "amount":124,"score":0.79,"exactAmount":true,"amountDiff":null,"reasons":["summa sama","nimi vastaa"]},
      {"transactionId":"t2","statementId":"s1","date":"2026-01-26","counterparty":" ","message":null,"reference":"1232",
       "amount":126,"score":0.5,"exactAmount":false,"amountDiff":2,"reasons":["summa poikkeaa 2,00 €"]}],
     "total":42,"months":[{"month":"2026-02","count":8},{"month":"2026-01","count":34}]}
    """)
    #expect(list.candidates.count == 2)
    let top = list.candidates[0]
    #expect(top.id == "t1")
    #expect(top.title == "Tukku Oy")
    #expect(top.detail == "25.1.2026 · Lasku 88123")
    #expect(top.why == "Miksi: summa sama · nimi vastaa")
    #expect(top.amount == 124)
    let fee = list.candidates[1]
    #expect(fee.title == "Pankkitapahtuma")
    #expect(fee.detail == "26.1.2026 · 1232")
    #expect(fee.amountDiff == 2)
    #expect(fee.why == "Miksi: summa poikkeaa 2,00 €")
    #expect(list.showsMonthChips)
    #expect(list.cappedNote == "Näytetään 2 parasta 42 tapahtumasta. Tarkenna hakua tai valitse kuukausi.")
}

@Test func purchaseBankCandidatesShowMonthChipsOnlyWhenMany() throws {
    let few = try decode(PurchaseBankCandidateList.self, #"{"candidates":[],"total":0,"months":[{"month":"2026-02","count":3},{"month":"2026-01","count":4}]}"#)
    #expect(!few.showsMonthChips)
    #expect(few.cappedNote == nil)
    let one = try decode(PurchaseBankCandidateList.self, #"{"candidates":[],"months":[{"month":"2026-01","count":40}]}"#)
    #expect(!one.showsMonthChips)
}

@Test func purchaseInvoiceCandidatesDecode() throws {
    let list = try decode(PurchaseInvoiceCandidateList.self, """
    {"candidates":[{"invoice":{"id":"pi1","supplierName":"Tukku Oy","invoiceNumber":"A-12","reference":null,
      "issueDate":"2026-01-10","dueDate":"2026-01-24","gross":124,"open":100},
      "score":0.8,"exactAmount":true,"amountDiff":null,"reasons":["summa sama kuin avoin osuus","nimi vastaa"]}],"total":1}
    """)
    let hit = try #require(list.candidates.first)
    #expect(hit.id == "pi1")
    #expect(hit.title == "Tukku Oy")
    #expect(hit.detail == "A-12 · eräpäivä 24.1.2026")
    #expect(hit.invoice.open == 100)
    #expect(hit.why == "Miksi: summa sama kuin avoin osuus · nimi vastaa")
}

@Test func purchaseBankLinkDefaultsToTheRowButNotPastTheOpenAmount() {
    #expect(PurchaseBankLink.defaultAmount(bankAmount: -124, open: 124) == 124)
    #expect(PurchaseBankLink.defaultAmount(bankAmount: -50, open: 124) == 50)
    // A fee on top: the invoice gets what it owed.
    #expect(PurchaseBankLink.defaultAmount(bankAmount: -126, open: 124) == 124)
    #expect(PurchaseBankLink.defaultAmount(bankAmount: -126, open: 0) == 126)
}

@Test func purchaseBankLinkValidatesTheTypedAmount() {
    #expect(PurchaseBankLink.problem(amountText: "124,00", bankAmount: -124) == nil)
    #expect(PurchaseBankLink.problem(amountText: "50", bankAmount: -124) == nil)
    #expect(PurchaseBankLink.problem(amountText: "130", bankAmount: -124) == "Maksu ei voi olla suurempi kuin pankkitapahtuman summa (124,00\u{00A0}€).")
    #expect(PurchaseBankLink.problem(amountText: "", bankAmount: -124) == "Anna maksun summa, esim. 124,00.")
    #expect(PurchaseBankLink.problem(amountText: "1,234", bankAmount: -124) == "Summassa saa olla enintään kaksi desimaalia.")
}

@Test func purchaseBankLinkExplainsTheOutcome() {
    #expect(PurchaseBankLink.outcome(amount: 124, open: 124) == "Ostolasku merkitään maksetuksi.")
    #expect(PurchaseBankLink.outcome(amount: 100, open: 124) == "Osamaksu: ostolaskulle jää avoimeksi 24,00\u{00A0}€.")
    #expect(PurchaseBankLink.differenceNote(bankAmount: -126, open: 124) == "Pankkitapahtuma on 2,00\u{00A0}€ suurempi kuin avoin summa (esim. pankin kulu).")
    #expect(PurchaseBankLink.differenceNote(bankAmount: -100, open: 124) == "Pankkitapahtuma on 24,00\u{00A0}€ pienempi kuin avoin summa.")
    #expect(PurchaseBankLink.differenceNote(bankAmount: -124, open: 124) == nil)
}

@Test func purchaseBankLinkOffersOnlyFreeOutgoingRows() throws {
    func row(_ extra: [String: Any] = [:]) throws -> BankTransaction {
        var fields: [String: Any] = [
            "id": "t", "statementId": "s", "date": "2026-01-25", "counterparty": "Tukku Oy",
            "type": "meno", "amount": -124, "matchStatus": "unmatched",
        ]
        fields.merge(extra) { _, new in new }
        return try JSONDecoder().decode(BankTransaction.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    let purchase: [String: Any] = ["settlesPurchase": true, "paidPurchase": ["id": "pi", "supplierName": "Tukku Oy", "paymentId": "p"]]
    #expect(PurchaseBankLink.canLink(try row()))
    #expect(PurchaseBankLink.canLink(try row(["matchStatus": "ignored"])))
    #expect(!PurchaseBankLink.canLink(try row(["amount": 124])))
    #expect(!PurchaseBankLink.canLink(try row(purchase)))
    #expect(!PurchaseBankLink.canLink(try row(["receiptId": "r1", "matchStatus": "confirmed"])))
    #expect(!PurchaseBankLink.canLink(try row(["type": "oma_siirto"])))
    let paid = try row(purchase)
    #expect(paid.paidPurchase?.paymentId == "p")
    #expect(BankFeed.state(of: paid) == .invoice)
}

@Test func purchasePaymentsCarryTheirBankRow() throws {
    let invoice = try decode(PurchaseInvoice.self, """
    {"id":"pi","supplierName":"Tukku Oy","issueDate":"2026-01-10","dueDate":"2026-01-24","status":"paid","displayStatus":"paid",
     "gross":124,"paid":124,"open":0,"payments":[
      {"id":"p1","paidDate":"2026-01-25","amount":124,"source":"bank","transactionId":"t1","note":null,
       "transaction":{"id":"t1","statementId":"s1","date":"2026-01-25","counterparty":"Tukku Oy","amount":-124}},
      {"id":"p2","paidDate":"2026-01-26","amount":1,"source":"manual","transactionId":null,"note":"käteinen","transaction":null}]}
    """)
    let bank = invoice.payments[0]
    #expect(bank.isLinkedToBank)
    #expect(bank.transaction?.amount == -124)
    #expect(PurchaseBankLinkText.paymentDetail(bank) == "Tukku Oy · pankista")
    #expect(!invoice.payments[1].isLinkedToBank)
    #expect(PurchaseBankLinkText.paymentDetail(invoice.payments[1]) == "käteinen")
}

@Test func purchaseSuggestionsAreAcceptedWithTheirRow() throws {
    let list = try decode(PurchaseSuggestionList.self, """
    {"suggestions":[{"invoiceId":"pi","supplierName":"Tukku Oy","invoiceNumber":null,"open":124,"transactionId":"t1",
      "amount":124,"paidDate":"2026-01-25","counterparty":"TUKKU OY","score":0.79,"reason":"amount_and_party",
      "reasons":["summa sama","nimi vastaa"]}]}
    """)
    let s = try #require(list.suggestions.first)
    #expect(s.id == "t1:pi")
    #expect(s.canAccept)
    #expect(s.bankLine == "Pankista 25.1.2026 · TUKKU OY · 124,00\u{00A0}€")
    #expect(s.why == "Miksi: summa sama · nimi vastaa")
    #expect(s.acceptBody == PurchasePaymentBody(amount: 124, paidDate: "2026-01-25", transactionId: "t1"))
    #expect(PurchaseBankLinkText.suggestionCount(1) == "1 ehdotus")
    #expect(PurchaseBankLinkText.suggestionCount(3) == "3 ehdotusta")

    // An older server: names only, nothing to accept.
    let old = try decode(PurchaseMatchResult.self, #"{"applied":[],"suggestions":[{"invoiceId":"b","supplierName":"S"}]}"#)
    #expect(old.suggestions.first?.canAccept == false)
    #expect(old.suggestions.first?.acceptBody == nil)
}

@Test func purchasePaymentBodySendsTheRowOnlyWhenThereIsOne() throws {
    let manual = String(decoding: try JSONEncoder().encode(PurchasePaymentBody(amount: 10, paidDate: "2026-01-25")), as: UTF8.self)
    #expect(!manual.contains("transactionId"))
    let linked = String(decoding: try JSONEncoder().encode(PurchasePaymentBody(amount: 10, paidDate: "2026-01-25", transactionId: "t1")), as: UTF8.self)
    #expect(linked.contains(#""transactionId":"t1""#))
}
