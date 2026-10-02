import Testing
import Foundation
@testable import LashKirjaCore

@Test func decodesRealProfitLoss() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/profit-loss.json"))
    let report = try JSONDecoder().decode(ProfitLoss.self, from: data)
    #expect(report.from == "2026-01")
    #expect(report.total.incomeNet == Decimal(string: "160.72"))
    #expect(report.total.profitNet == Decimal(string: "160.72"))
    #expect(report.total.incomeByCategory.first?.category == "Myyntilaskut")
    #expect(report.filledMonths(year: "2026").count == 12)
    #expect(report.filledMonths(year: "2026").allSatisfy { $0.incomeNet == 0 || $0.month != nil })
}
