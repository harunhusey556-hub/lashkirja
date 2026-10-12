import Testing
import Foundation
@testable import LashKirjaCore

@Test func ledgerDecodesTheServerShape() throws {
    let json = #"{"year":2026,"from":"2026-01-01","to":"2027-01-01","journal":[{"voucher":1,"id":"receipt:r1","date":"2026-09-03","description":"Kuitti K-Market","sourceType":"receipt","sourceId":"r1","lines":[{"account":"4000","debitCents":1000,"creditCents":0},{"account":"1910","debitCents":0,"creditCents":1000}]}],"trialBalance":[{"code":"1910","name":"Pankkitili","type":"asset","debitCents":0,"creditCents":1000,"balanceCents":-1000}],"generalLedger":[],"incomeStatement":{"revenue":[],"expenses":[{"code":"4000","name":"Ostot","cents":1000}],"revenueCents":0,"expensesCents":1000,"resultCents":-1000},"balanceSheet":{"assets":[{"code":"1910","name":"Pankkitili","cents":-1000}],"liabilities":[],"equity":[{"code":"2370","name":"Tilikauden voitto (tappio)","cents":-1000}],"assetsCents":-1000,"liabilitiesAndEquityCents":-1000},"notes":{"openingBalanceMissing":true,"suspenseCents":0,"balances":true}}"#
    let books = try JSONDecoder().decode(LedgerBooks.self, from: Data(json.utf8))
    #expect(books.journal.first?.lines.count == 2)
    #expect(books.incomeStatement.resultCents == -1000)
    #expect(books.notes.balances)
    #expect(LedgerBooks.euros(1255) == Decimal(string: "12.55")!)
    #expect(LedgerBooks.voucherTitle(books.journal[0]) == "Tosite 1 · 3.9.2026")
}
