import Testing
import Foundation
@testable import LashKirjaCore

@Test func listQueryCarriesFiltersAndOffset() {
    var q = ReceiptListQuery()
    // Kuitit asks for kuitit only (`kind=receipt`); the bills filed as ostolaskut sit under Laskut.
    #expect(q.listQuery() == ["sort": "date_desc", "kind": "receipt"])
    #expect(q.countsQuery() == ["kind": "receipt"])
    q.search = "  kesko "
    q.month = "2026-10"
    q.tab = .meno
    q.category = "tarvikkeet"
    q.sort = .amountDesc
    #expect(q.listQuery(offset: 200) == [
        "q": "kesko", "month": "2026-10", "type": "meno", "category": "tarvikkeet",
        "sort": "amount_desc", "offset": "200", "kind": "receipt",
    ])
    // The chips count every tab: no type, no linkedStatus, no sort, no paging.
    #expect(q.countsQuery() == ["q": "kesko", "month": "2026-10", "category": "tarvikkeet", "kind": "receipt"])
    q.tab = .unlinked
    #expect(q.listQuery()["linkedStatus"] == "unlinked")
    #expect(q.listQuery()["type"] == nil)
    #expect(q.isFiltered)
    #expect(!ReceiptListQuery().isFiltered)
}

@Test func tabCountsAndSortTitles() throws {
    let counts = try JSONDecoder().decode(ReceiptCounts.self, from: Data(#"{"counts":{"all":5,"tulo":2,"meno":3,"linked":1,"unlinked":4}}"#.utf8)).counts
    // A server before the kuitti/lasku split sends no "laskut": the chip counts zero.
    #expect(ReceiptTab.allCases.map { $0.count(in: counts) } == [5, 2, 3, 1, 4, 0])
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

// X039: the receipt's candidates in the words of "Valitse pankkitapahtuma".
@Test func candidateLineUsesTheServersFinnishReasons() throws {
    let json = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","match":{"status":"unlinked","matchCandidates":[{"id":"t1","date":"2026-10-01T00:00:00.000Z","counterparty":"Prisma 10","amount":-9.43,"score":0.3,"reasons":["amount","date"],"explanation":["summa sama","veloitettu 1 päivä oston jälkeen"]},{"id":"t2","date":"2026-10-01T00:00:00.000Z","counterparty":"K-Market","amount":-12.5,"score":0.9,"reasons":["amount","vendor"]}]}}}"#
    let candidates = try #require(try JSONDecoder().decode(ReceiptResponse.self, from: Data(json.utf8)).receipt.match?.matchCandidates)
    #expect(candidates[0].explanation == ["summa sama", "veloitettu 1 päivä oston jälkeen"])
    #expect(ReceiptMatchText.detail(candidates[0]) == "Miksi: summa sama · veloitettu 1 päivä oston jälkeen")
    // A server without the Finnish reasons: the code words and the score, as before.
    #expect(candidates[1].explanation == nil)
    #expect(ReceiptMatchText.detail(candidates[1]) == "summa, myyjä · 90 %")
}

// X001 X038 X068 X080: money out reads −, money back plain, on every screen.
@Test func amountsCarryTheirCashDirection() throws {
    #expect(MoneyDirection.receiptAmount(Decimal(string: "9.43")!, isIncome: false) == Decimal(string: "-9.43")!)
    #expect(MoneyDirection.receiptAmount(-50, isIncome: false) == 50)
    #expect(MoneyDirection.receiptAmount(20, isIncome: true) == 20)
    #expect(MoneyDirection.rowAmount(Decimal(string: "9.43")!, moneyIn: false) == Decimal(string: "-9.43")!)
    #expect(MoneyDirection.rowAmount(-50, moneyIn: true) == 50)

    func receipt(_ fields: String) throws -> Receipt {
        try JSONDecoder().decode(Receipt.self, from: Data((#"{"id":"r","createdAt":"a","updatedAt":"b","# + fields + "}").utf8))
    }
    let expense = try receipt(#""type":"meno","totalAmount":9.5"#)
    #expect(expense.shownAmount == Decimal(string: "-9.5")!)
    #expect(!expense.bankMoneyIn)
    // A credit note's refund comes back: its rows are incoming, as the server's picker lists them.
    let credit = try receipt(#""type":"meno","totalAmount":-50"#)
    #expect(credit.shownAmount == 50)
    #expect(credit.bankMoneyIn)
    let sale = try receipt(#""type":"tulo","totalAmount":20"#)
    #expect(sale.shownAmount == 20)
    #expect(sale.bankMoneyIn)
    let blank = try receipt(#""type":"meno""#)
    #expect(blank.shownAmount == nil)
    #expect(!blank.bankMoneyIn)
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
