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

@Test func onlyReceiptsWithAnUploadOfferTheirFile() throws {
    func receipt(_ source: String, _ fileName: String?) throws -> Receipt {
        let name = fileName.map { "\"\($0)\"" } ?? "null"
        let json = #"{"receipt":{"id":"r1","source":"\#(source)","fileName":\#(name),"vatDetails":null,"createdAt":"2026-10-02T09:00:00.000Z","updatedAt":"2026-10-02T09:00:00.000Z"}}"#
        return try JSONDecoder().decode(ReceiptResponse.self, from: Data(json.utf8)).receipt
    }
    // A sale drafted from a bank row is stored with a placeholder name and no file behind it.
    #expect(try !receipt("auto_income", "Myyntitosite_luonnos.txt").hasOriginalFile)
    #expect(try receipt("ai", "kuitti.jpg").hasOriginalFile)
    #expect(try receipt("email_sync", "lasku.pdf").hasOriginalFile)
    #expect(try !receipt("manual", nil).hasOriginalFile)
}
