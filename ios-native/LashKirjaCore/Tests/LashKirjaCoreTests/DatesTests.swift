import Testing
import Foundation
@testable import LashKirjaCore

@Test func apiDates() {
    let d = APIDate.day("2026-10-02")!
    #expect(APIDate.dayString(d) == "2026-10-02")
    #expect(APIDate.month(d) == "2026-10")
    #expect(APIDate.displayDay("2026-10-02") == "2.10.2026")
    #expect(APIDate.day("2026-13-40") == nil)
    #expect(APIDate.displayDay("nonsense") == "nonsense")
}

@Test func timestampsShowHelsinkiTime() {
    #expect(APIDate.timestamp("2026-10-02T09:05:00.000Z") == "2.10.2026 klo 12.05")
    #expect(APIDate.timestamp("2026-01-15T22:30:00Z") == "16.1.2026 klo 0.30")
    #expect(APIDate.timestamp("eilen") == "eilen")
}
