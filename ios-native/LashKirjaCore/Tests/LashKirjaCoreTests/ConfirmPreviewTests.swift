import Testing
import Foundation
@testable import LashKirjaCore

private func suggested(_ id: String, amount: Double, receiptTotal: Double?, source: String = "ai", counterparty: String = "K-Market") throws -> BankTransaction {
    let total = receiptTotal.map { "\($0)" } ?? "null"
    let json = #"{"id":"\#(id)","statementId":"s","date":"2026-09-10","counterparty":"\#(counterparty)","reference":null,"message":null,"type":"meno","amount":\#(amount),"receiptId":null,"suggestedReceiptId":"r\#(id)","matchStatus":"suggested","source":"file","suggestedReceipt":{"id":"r\#(id)","vendor":"Kesko","totalAmount":\#(total),"source":"\#(source)"}}"#
    return try JSONDecoder().decode(BankTransaction.self, from: Data(json.utf8))
}

@Test func confirmPreviewCountsTheMoneyAndTheMismatches() throws {
    let rows = [
        try suggested("a", amount: -12.40, receiptTotal: 12.40),
        try suggested("b", amount: -25.01, receiptTotal: 1546.47),
        // A sale drafted from the bank row is not a kuitti suggestion: the server leaves it out too.
        try suggested("c", amount: 90, receiptTotal: 90, source: "auto_income"),
    ]
    let preview = BankFeed.confirmPreview(rows)
    #expect(preview.count == BankFeed.confirmableSuggestions(rows))
    #expect(preview.count == 2)
    // JSON numbers may arrive through Double: compare to the cent.
    #expect(abs(preview.total - Decimal(string: "37.41")!) < Decimal(string: "0.005")!)
    #expect(preview.mismatched == 1)
    let gap = try #require(preview.pairs.first { $0.id == "b" }?.gap)
    #expect(abs(gap - Decimal(string: "-1521.46")!) < Decimal(string: "0.005")!)
}
