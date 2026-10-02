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
