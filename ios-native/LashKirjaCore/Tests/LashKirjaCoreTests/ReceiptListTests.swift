import Testing
import Foundation
@testable import LashKirjaCore

@Test func listQueryCarriesFiltersAndOffset() {
    var q = ReceiptListQuery()
    #expect(q.listQuery() == ["sort": "date_desc"])
    #expect(q.countsQuery().isEmpty)
    q.search = "  kesko "
    q.month = "2026-10"
    q.tab = .meno
    q.category = "tarvikkeet"
    q.sort = .amountDesc
    #expect(q.listQuery(offset: 200) == [
        "q": "kesko", "month": "2026-10", "type": "meno", "category": "tarvikkeet",
        "sort": "amount_desc", "offset": "200",
    ])
    // The chips count every tab: no type, no linkedStatus, no sort, no paging.
    #expect(q.countsQuery() == ["q": "kesko", "month": "2026-10", "category": "tarvikkeet"])
    q.tab = .unlinked
    #expect(q.listQuery()["linkedStatus"] == "unlinked")
    #expect(q.listQuery()["type"] == nil)
    #expect(q.isFiltered)
    #expect(!ReceiptListQuery().isFiltered)
}

@Test func tabCountsAndSortTitles() throws {
    let counts = try JSONDecoder().decode(ReceiptCounts.self, from: Data(#"{"counts":{"all":5,"tulo":2,"meno":3,"linked":1,"unlinked":4}}"#.utf8)).counts
    #expect(ReceiptTab.allCases.map { $0.count(in: counts) } == [5, 2, 3, 1, 4])
    #expect(ReceiptTab.linked.title == "Kohdistettu")
    #expect(ReceiptSort.createdDesc.title == "Lisätty (uusin)")
}

@Test func pageAppendDropsDuplicates() throws {
    func r(_ id: String) throws -> Receipt {
        try JSONDecoder().decode(Receipt.self, from: Data(#"{"id":"\#(id)","createdAt":"a","updatedAt":"b"}"#.utf8))
    }
    let merged = ReceiptPaging.append([try r("a"), try r("b")], [try r("b"), try r("c")])
    #expect(merged.map(\.id) == ["a", "b", "c"])
}

@Test func batchDeleteResultDecodes() throws {
    let result = try JSONDecoder().decode(BatchDeleteResult.self, from: Data(#"{"ok":true,"succeeded":["a"],"failed":[{"id":"b","error":"Kausi on suljettu"}],"deletedCount":1,"failedCount":1}"#.utf8))
    #expect(result.succeeded == ["a"])
    #expect(result.failedIds == ["b"])
    #expect(result.message == "Poistettiin 1 kuitti. 1 epäonnistui: Kausi on suljettu")
    let all = try JSONDecoder().decode(BatchDeleteResult.self, from: Data(#"{"succeeded":["a","b"],"failed":[]}"#.utf8))
    #expect(all.message == "Poistettiin 2 kuittia.")
}

@Test func matchCandidatesDecodeFromDetail() throws {
    let json = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","linkedTransaction":null,"match":{"status":"unlinked","suggestedTransaction":null,"matchCandidates":[{"id":"t1","date":"2026-10-01T00:00:00.000Z","counterparty":"K-Market","amount":-12.5,"matchStatus":"unmatched","matchScore":null,"matchReasons":null,"statement":null,"score":0.9,"reasons":["amount","vendor","oudo"]}]}}}"#
    let r = try JSONDecoder().decode(ReceiptResponse.self, from: Data(json.utf8)).receipt
    let c = try #require(r.match?.matchCandidates?.first)
    #expect(c.id == "t1")
    #expect(c.score == 0.9)
    #expect(ReceiptMatchText.reasons(c.reasons) == "summa, myyjä")
    #expect(ReceiptMatchText.isStrong(score: 0.9, reasons: nil))
    #expect(ReceiptMatchText.isStrong(score: 0.2, reasons: ["viite", "amount"]))
    #expect(!ReceiptMatchText.isStrong(score: 0.2, reasons: ["amount"]))
    #expect(ReceiptMatchText.percent(0.904) == "90 %")
}

@Test func linkedAmountGapMatchesTheWebTolerance() {
    #expect(ReceiptMatchText.amountGap(bank: -124, receiptTotal: 124) == nil)
    #expect(ReceiptMatchText.amountGap(bank: -126, receiptTotal: 124) == nil)
    #expect(ReceiptMatchText.amountGap(bank: -99, receiptTotal: nil) == nil)
    #expect(ReceiptMatchText.amountGap(bank: Decimal(string: "-25.01")!, receiptTotal: Decimal(string: "1546.47")!) == Decimal(string: "-1521.46")!)
    #expect(ReceiptMatchText.amountGap(bank: -130, receiptTotal: Decimal(string: "124.25")!) == Decimal(string: "5.75")!)
}

@Test func captureImageDownscaleSize() {
    let big = CaptureImageSizing.targetSize(width: 4032, height: 3024)
    #expect(big.width == 2400)
    #expect(big.height == 1800)
    let tall = CaptureImageSizing.targetSize(width: 6000, height: 8000)
    #expect(tall.width == 1800)
    #expect(tall.height == 2400)
    let small = CaptureImageSizing.targetSize(width: 1200, height: 900)
    #expect(small.width == 1200 && small.height == 900)
    #expect(CaptureImageSizing.needsResize(width: 4032, height: 3024))
    #expect(!CaptureImageSizing.needsResize(width: 2400, height: 1000))
}
