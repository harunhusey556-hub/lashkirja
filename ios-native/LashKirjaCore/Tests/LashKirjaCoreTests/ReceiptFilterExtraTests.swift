import Testing
import Foundation
@testable import LashKirjaCore

@Test func sourceAndAmountReachListAndCounts() {
    var q = ReceiptListQuery()
    q.source = .ocr
    q.minAmount = "12,50"
    q.maxAmount = "1 000"
    #expect(q.amountError == nil)
    for query in [q.countsQuery(), q.listQuery()] {
        #expect(query["source"] == "ocr")
        // The server reads Number(...): a Finnish comma would be NaN there.
        #expect(query["minAmount"] == "12.5")
        #expect(query["maxAmount"] == "1000")
    }
    #expect(q.isFiltered)
    #expect(q.amountLabel == "12,50–1 000 €")
}

@Test func emptyOrBrokenAmountsAreNotSent() {
    var q = ReceiptListQuery()
    #expect(q.countsQuery()["source"] == nil)
    q.minAmount = "abc"
    #expect(q.countsQuery()["minAmount"] == nil)
    #expect(q.amountError == "Virheellinen summa")
    q.minAmount = "50"
    q.maxAmount = "10"
    #expect(q.amountError == "Summarajaus on virheellinen")
    q.maxAmount = ""
    #expect(q.amountError == nil)
    #expect(q.amountLabel == "50–∞ €")
}

@Test func sourceTitlesMatchTheWeb() {
    #expect(ReceiptSourceFilter.allCases.map(\.title) == ["Kaikki", "AI", "OCR", "Manuaalinen"])
}
