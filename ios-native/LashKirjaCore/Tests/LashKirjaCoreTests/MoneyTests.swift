import Testing
import Foundation
@testable import LashKirjaCore

@Test func formatsFinnishEuros() {
    #expect(Money.format(Decimal(string: "1234.5")!) == "1\u{00A0}234,50\u{00A0}€")
    #expect(Money.format(Decimal(string: "-8.5")!) == "\u{2212}8,50\u{00A0}€")
    #expect(Money.format(Decimal(string: "26.41")!, signed: true) == "+26,41\u{00A0}€")
    #expect(Money.format(0) == "0,00\u{00A0}€")
    #expect(Money.format(Decimal(string: "1234567.891")!) == "1\u{00A0}234\u{00A0}567,89\u{00A0}€")
}

@Test func parsesTypedEuros() {
    #expect(Money.parse("1 234,56") == Decimal(string: "1234.56"))
    #expect(Money.parse("12.5") == Decimal(string: "12.5"))
    #expect(Money.parse("12,50 €") == Decimal(string: "12.5"))
    #expect(Money.parse("abc") == nil)
    #expect(Money.parse("") == nil)
}
