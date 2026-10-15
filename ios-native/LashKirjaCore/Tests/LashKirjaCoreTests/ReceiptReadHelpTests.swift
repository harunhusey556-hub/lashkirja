import Testing
import Foundation
@testable import LashKirjaCore

// Owner 2026-10-15: a foreign receipt's euro total read as złoty, and unreadable documents
// (Kymenlaakson Sähkö, "Alvestre SIA") with nothing to do about them.

private func receipt(_ json: String) throws -> Receipt {
    try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
}

@Suite struct ReceiptOriginalAmountTests {
    @Test func theDocumentsOwnFigureSaysItsCurrency() {
        #expect(ReceiptCurrency.formatOriginal(5707.79, currency: "PLN") == "5\u{00A0}707,79\u{00A0}PLN")
        #expect(ReceiptCurrency.originalLine(currency: "PLN", originalAmount: 5707.79) == "5\u{00A0}707,79\u{00A0}PLN")
    }

    @Test func aEuroReceiptOrAMissingFigureHasNoOriginalLine() {
        #expect(ReceiptCurrency.originalLine(currency: "EUR", originalAmount: 12) == nil)
        #expect(ReceiptCurrency.originalLine(currency: "USD", originalAmount: nil) == nil)
    }

    @Test func theShellReceiptShowsItsEuroTotalOriginalAndRate() throws {
        let r = try receipt(#"{"id":"r1","vendor":"Shell Polska sp. z o.o.","totalAmount":1319.18,"currency":"PLN","originalAmount":5707.79,"fxRate":0.23112,"fxRateDate":"2026-08-27","fxSource":"ECB"}"#)
        #expect(ReceiptCurrency.originalLine(currency: r.currency, originalAmount: r.originalAmount) == "5\u{00A0}707,79\u{00A0}PLN")
        #expect(r.fxRateLine == "Kurssi 1 PLN = 0,2311 EUR (EKP 27.8.2026)")
    }
}

@Suite struct ReceiptReadHelpTests {
    @Test func aGuessedOrEmptyReadingOffersRereadUpFront() throws {
        let guessed = try receipt(#"{"id":"k","vendor":"Kymmenlaakson sähkö","totalAmount":84.16,"confidence":0.1,"fileName":"lasku.pdf","source":"ai"}"#)
        #expect(ReceiptReadHelp.needsReread(guessed))
        let empty = try receipt(#"{"id":"e","fileName":"ALV112-26.pdf","source":"manual"}"#)
        #expect(ReceiptReadHelp.needsReread(empty))
        let noAmount = try receipt(#"{"id":"a","vendor":"Tukku Oy","confidence":0.9,"fileName":"k.jpg","source":"ai"}"#)
        #expect(ReceiptReadHelp.needsReread(noAmount))
    }

    @Test func aGoodReadingAHandTypedOneOrNoFileDoesNot() throws {
        let good = try receipt(#"{"id":"g","vendor":"Tukku Oy","totalAmount":12.4,"confidence":0.95,"fileName":"k.jpg","source":"ai"}"#)
        #expect(!ReceiptReadHelp.needsReread(good))
        let typed = try receipt(#"{"id":"t","vendor":"Alvstre sia","totalAmount":3145.9,"fileName":"ALV119-26.pdf","source":"manual"}"#)
        #expect(!ReceiptReadHelp.needsReread(typed))
        let draft = try receipt(#"{"id":"d","source":"auto_income","fileName":"x"}"#)
        #expect(!ReceiptReadHelp.needsReread(draft))
    }

    @Test func aFreshReadingFillsTheFormAndKeepsWhatItDidNotRead() throws {
        let stored = try receipt(#"{"id":"k","vendor":"Kymmenlaakson sähkö","date":"2026-10-13","totalAmount":63.43,"category":"sahko","type":"meno","confidence":0.1,"fileName":"lasku.pdf","source":"ai"}"#)
        let reading = try JSONDecoder().decode(Extracted.self, from: Data(#"{"vendor":"Kymenlaakson Sähkö Oy","date":"2026-09-01","totalAmount":63.43,"reference":"32793479","invoiceNumber":"62606169079","vatDetails":[{"rate":25.5,"amount":12.89}]}"#.utf8))
        let baseline = ReceiptForm(receipt: stored)
        var form = baseline
        form.apply(reading: reading)
        #expect(form.vendor == "Kymenlaakson Sähkö Oy")
        #expect(form.date == "2026-09-01")
        #expect(form.reference == "32793479")
        #expect(form.invoiceNumber == "62606169079")
        #expect(form.category == "sahko")
        #expect(form.vatRows.count == 1)
        #expect(form.vatRows[0].rate == 25.5)
        #expect(form != baseline)
    }
}
