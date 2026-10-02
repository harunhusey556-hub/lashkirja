import XCTest
@testable import LashKirja

final class RouteTests: XCTestCase {
    func testTabTitles() {
        XCTAssertEqual(AppTab.koti.title, "Koti")
        XCTAssertEqual(AppTab.myynti.title, "Myynti")
        XCTAssertEqual(AppTab.kirjanpito.title, "Kirjanpito")
        XCTAssertEqual(AppTab.raportit.title, "Raportit")
    }
}
