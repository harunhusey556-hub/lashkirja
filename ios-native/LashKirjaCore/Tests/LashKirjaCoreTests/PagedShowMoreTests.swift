import Testing
import Foundation
@testable import LashKirjaCore

@Test func pagedListRevealsLoadedRowsBeforeFetching() {
    var limit = ShowMore()
    // 200 loaded of 450 on the server.
    #expect(PagedShowMore.step(limit, loaded: 200, serverHasMore: true) == .reveal)
    #expect(PagedShowMore.title(limit, loaded: 200, total: 450, serverHasMore: true) == "Näytä enemmän (440)")
    for _ in 0..<19 { limit.more(total: 200) }
    #expect(limit.visible(200) == 200)
    // Every loaded row is on screen: now the button asks the server.
    #expect(PagedShowMore.step(limit, loaded: 200, serverHasMore: true) == .fetch)
    #expect(PagedShowMore.title(limit, loaded: 200, total: 450, serverHasMore: true) == "Näytä enemmän (250)")
    #expect(PagedShowMore.title(limit, loaded: 200, total: 450, serverHasMore: true, loading: true) == "Ladataan…")
    PagedShowMore.revealFetched(&limit, before: 200, after: 400)
    #expect(limit.visible(400) == 210)
}

@Test func pagedListFoldsOnlyWhenTheServerHasNoMore() {
    var limit = ShowMore()
    limit.more(total: 15)
    #expect(PagedShowMore.step(limit, loaded: 15, serverHasMore: false) == .fold)
    #expect(PagedShowMore.title(limit, loaded: 15, total: 15, serverHasMore: false) == "Näytä vähemmän")
    #expect(PagedShowMore.step(ShowMore(), loaded: 8, serverHasMore: false) == nil)
    #expect(PagedShowMore.title(ShowMore(), loaded: 8, total: 8, serverHasMore: false) == nil)
    // A short first page with more on the server still offers the next page.
    #expect(PagedShowMore.step(ShowMore(), loaded: 8, serverHasMore: true) == .fetch)
}

@Test func anEmptyFetchedPageKeepsTheListOpen() {
    var limit = ShowMore()
    limit.more(total: 20)
    PagedShowMore.revealFetched(&limit, before: 20, after: 20)
    #expect(limit.visible(20) == 20)
}

@Test func expandOpensFarEnoughForAFocusedRow() {
    var limit = ShowMore()
    limit.expand(toInclude: 34, total: 50)
    #expect(limit.visible(50) == 40)
    var short = ShowMore()
    short.expand(toInclude: 3, total: 50)
    #expect(short.visible(50) == 10)
    short.expand(toInclude: 99, total: 50)
    #expect(short.visible(50) == 10)
}

@Test func groupChoiceKeepsPickPrefersThenFirst() {
    #expect(GroupChoice.pick("2026-09", available: ["2026-10", "2026-09"]) == "2026-09")
    #expect(GroupChoice.pick("2026-01", available: ["2026-10", "2026-09"], preferred: "2026-09") == "2026-09")
    #expect(GroupChoice.pick(nil, available: ["2026-10", "2026-09"]) == "2026-10")
    #expect(GroupChoice.pick("x", available: [String]()) == nil)
}

@Test func feedShowsOnlyMonthsWithMatchingRows() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/statements.json")
    let list = try JSONDecoder().decode(StatementList.self, from: Data(contentsOf: url))
    let october = try #require(BankFeed.months(list.statements).first)
    let market = try #require(october.rows.first { $0.counterparty == "K-Market Kamppi" })
    // An older month holding only the sale row: no chip once the search leaves it empty.
    let sale = try #require(october.rows.first { BankFeed.state(of: $0) == .sale })
    let september = BankFeed.Month(month: "2026-09", rows: [sale], open: 1)
    let months = [october, september]
    #expect(BankFeed.shownMonths(months, onlyOpen: false, search: "").map(\.month) == ["2026-10", "2026-09"])
    let found = BankFeed.shownMonths(months, onlyOpen: true, search: " k-market ")
    #expect(found.map(\.month) == ["2026-10"])
    #expect(found.first?.rows.map(\.id).contains(market.id) == true)
    #expect(found.first?.open == october.open)
    #expect(BankFeed.shownMonths(months, onlyOpen: false, search: "ei tällaista").isEmpty)
}
