import XCTest
@testable import LashKirja

final class LaunchTests: XCTestCase {
    func testBaseURLIsHTTPS() {
        XCTAssertEqual(AppConfig.apiBaseURL.scheme, "https")
    }
}
