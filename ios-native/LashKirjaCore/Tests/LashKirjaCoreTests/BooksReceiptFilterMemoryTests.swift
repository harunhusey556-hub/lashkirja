import Testing
import Foundation
@testable import LashKirjaCore

@Test func receiptFiltersRoundTripThroughStorage() {
    var q = ReceiptListQuery()
    q.month = "2026-09"
    q.tab = .meno
    q.category = "puhelin/netti"
    q.source = .ai
    q.sort = .amountDesc
    q.search = "kahvi"
    q.minAmount = "5"
    let restored = ReceiptListQuery(remembered: q.remembered)
    #expect(restored.month == "2026-09")
    #expect(restored.tab == .meno)
    #expect(restored.category == "puhelin/netti")
    #expect(restored.source == .ai)
    #expect(restored.sort == .amountDesc)
    // Search and amount limits are not kept between visits.
    #expect(restored.search == "")
    #expect(restored.minAmount == "")
}

@Test func unknownStoredFiltersFallBackToDefaults() {
    #expect(ReceiptListQuery(remembered: "") == ReceiptListQuery())
    #expect(ReceiptListQuery(remembered: "tab=nope&sort=x&source=zz&month=bad") == ReceiptListQuery())
    #expect(ReceiptListQuery().remembered == "")
}
