import Testing
import Foundation
@testable import LashKirjaCore

private func month(_ m: String, _ income: Decimal, _ expenses: Decimal, _ source: String = "tiliote") throws -> Dashboard.CashflowMonth {
    let json = #"{"month":"\#(m)","income":\#(income),"expenses":\#(expenses),"source":"\#(source)"}"#
    return try JSONDecoder().decode(Dashboard.CashflowMonth.self, from: Data(json.utf8))
}

@Test func trendFollowsTheWebsMoneyTrend() throws {
    let rows = [
        try month("2026-07", 100, 40),
        try month("2026-08", 200, 50),
        try month("2026-09", 999, 999),        // replaced by the card's live figure
        try month("2026-10", 1, 1),            // after the shown month: left out
        try month("2026-06", 5, 5, "kuitit"),  // other basis: left out
    ]
    let income = MoneyTrend.make(rows: rows, month: "2026-09", source: "tiliote", metric: .income, value: 250)
    #expect(income.points == [100, 200, 250])
    #expect(income.percent == 25)
    #expect(income.previousMonth == "2026-08")
    let expenses = MoneyTrend.make(rows: rows, month: "2026-09", source: "tiliote", metric: .expenses, value: 25)
    #expect(expenses.percent == -50)
}

@Test func trendNeedsTwoMonthsAndABase() throws {
    let one = MoneyTrend.make(rows: [try month("2026-09", 10, 0)], month: "2026-09", source: "tiliote", metric: .income, value: 10)
    #expect(one.points.isEmpty)
    let zeroBase = MoneyTrend.make(rows: [try month("2026-08", 0, 0), try month("2026-09", 10, 0)], month: "2026-09", source: "tiliote", metric: .income, value: 10)
    #expect(zeroBase.percent == nil)
    #expect(zeroBase.points == [0, 10])
}

@Test func sparkGeometryMatchesTheWeb() {
    #expect(MoneyTrend.geometry([]) == nil)
    let flat = MoneyTrend.geometry([3, 3])!
    #expect(flat.points.allSatisfy { $0.y == 0.5 })
    let rising = MoneyTrend.geometry([0, 10])!
    #expect(rising.points.first!.y > rising.points.last!.y)
}
