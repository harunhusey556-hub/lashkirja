import XCTest
import SwiftUI
@testable import LashKirja

/// `withMotion` once called itself instead of `withAnimation` (a rename caught its own body): an
/// endless loop that froze every "Näytä enemmän" on a device. These calls return at once, or the
/// test never ends.
@MainActor
final class RecursionGuardTests: XCTestCase {
    func testWithMotionRunsTheBodyOnceAndReturns() {
        var runs = 0
        let value = withMotion(.snappy) { runs += 1; return 42 }
        XCTAssertEqual(value, 42)
        XCTAssertEqual(runs, 1)
        XCTAssertEqual(withMotion(nil) { "ok" }, "ok")
    }
}
