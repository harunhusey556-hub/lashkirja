import Testing
import Foundation
@testable import LashKirjaCore

private let filed = Decimal(string: "159.38")!

@Test func vatFiguresThatMovedAfterFilingAreNoticed() {
    #expect(!PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: filed, amount: filed, isRefund: false).changedSinceFiling)
    #expect(PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: filed, amount: 170, isRefund: false).changedSinceFiling)
    #expect(PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: filed, amount: filed, isRefund: true).changedSinceFiling)
    // Not filed, or filed before the amount was recorded: nothing to compare.
    #expect(!PeriodClose.vat(filedAt: nil, paidAt: nil, filedAmount: filed, amount: 170, isRefund: false).changedSinceFiling)
    #expect(!PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: nil, amount: 170, isRefund: false).changedSinceFiling)
}

@Test func aChangedReturnIsNotDoneEvenWhenPaid() {
    let vat = PeriodClose.vat(filedAt: "x", paidAt: "y", filedAmount: filed, amount: 170, isRefund: false)
    #expect(vat.state == .paid)
    #expect(!vat.done)
}

@Test func nothingToPayFollowsTheFiledAmount() {
    // Filed as a refund: nothing to pay, whatever the live figure says now.
    #expect(PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: -20, amount: 50, isRefund: false).nothingToPay)
    #expect(!PeriodClose.vat(filedAt: "x", paidAt: nil, filedAmount: 50, amount: 20, isRefund: true).nothingToPay)
}

@Test func changedNoteSaysWhatWasFiledAndWhatItIsNow() {
    let note = PeriodClose.vatChangedNote(filedAmount: filed, amount: 170, isRefund: false)
    #expect(note == "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu \(Money.format(filed)), nyt \(Money.format(170)).")
    let refund = PeriodClose.vatChangedNote(filedAmount: filed, amount: 12, isRefund: true)
    #expect(refund == "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu \(Money.format(filed)), nyt palautus \(Money.format(12)).")
}

@Test func filingDecodesTheFiledAmount() throws {
    let json = #"{"filedAt":"2026-10-05T08:00:00.000Z","paidAt":null,"filedAmount":159.38}"#
    let filing = try JSONDecoder().decode(AlvReport.Filing.self, from: Data(json.utf8))
    #expect(filing.filedAmount == filed)
    let old = try JSONDecoder().decode(AlvReport.Filing.self, from: Data(#"{"filedAt":null,"paidAt":null}"#.utf8))
    #expect(old.filedAmount == nil)
}
