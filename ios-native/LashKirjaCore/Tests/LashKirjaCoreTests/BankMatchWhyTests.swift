import Testing
import Foundation
@testable import LashKirjaCore

private func row(_ reasons: String) throws -> BankTransaction {
    let json = #"{"id":"t","statementId":"s","date":null,"counterparty":null,"reference":null,"message":null,"type":"meno","amount":-49.9,"receiptId":null,"suggestedReceiptId":"r","matchStatus":"suggested","source":"file","matchReasons":\#(reasons)}"#
    return try JSONDecoder().decode(BankTransaction.self, from: Data(json.utf8))
}

@Test func suggestionSaysWhyInFinnish() throws {
    // The statement GET stores the reasons as JSON text: codes, then "fi:" reasons.
    let stored = try row(#""[\"viite\",\"amount\",\"ai\",\"fi:viite täsmää\",\"fi:summa sama\",\"fi:maksettu 3 päivää eräpäivän jälkeen\"]""#)
    #expect(BankFeed.matchWhy(stored) == "Miksi: viite täsmää · summa sama · maksettu 3 päivää eräpäivän jälkeen")
    #expect(stored.matchReasons?.reviewed == true)
}

@Test func oldOrOddReasonsShowNothingAndNeverBreakTheFeed() throws {
    #expect(BankFeed.matchWhy(try row(#""[\"amount\",\"vendor\"]""#)) == nil)
    #expect(BankFeed.matchWhy(try row("null")) == nil)
    #expect(BankFeed.matchWhy(try row(#""not json""#)) == nil)
    #expect(BankFeed.matchWhy(try row(#"["fi:summa sama"]"#)) == "Miksi: summa sama")
}

@Test func candidateCarriesItsReasons() throws {
    let json = #"{"candidates":[{"score":0.9,"reasons":["amount","vendor"],"explanation":["summa sama","nimi vastaa"],"receipt":{"id":"r","vendor":"K-Market","date":null,"totalAmount":8.9}},{"score":0.4,"reasons":["amount"],"receipt":{"id":"q","vendor":null,"date":null,"totalAmount":8.9}}]}"#
    let list = try JSONDecoder().decode(BankMatchCandidates.self, from: Data(json.utf8))
    #expect(list.candidates[0].why == "Miksi: summa sama · nimi vastaa")
    #expect(list.candidates[1].why == nil)
}

@Test func oldChatCardCodesReadAsFinnish() {
    #expect(BankMatchText.why(["viite", "amount", "date", "competing"]) == "Miksi: viite täsmää · summa sama")
    #expect(BankMatchText.why(["date"]) == nil)
}
