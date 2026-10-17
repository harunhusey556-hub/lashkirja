import XCTest
@testable import LashKirja

/// w56 (row 27): Stripe Terminal is not loaded at launch, and loads when a card payment needs it.
@MainActor
final class StripeTerminalLoaderTests: XCTestCase {
    /// Both in the app's own Frameworks: a test run also finds them in the build folder
    /// (DYLD_FRAMEWORK_PATH), a phone only in the bundle.
    func testTheSDKIsInTheAppBundle() throws {
        let frameworks = try XCTUnwrap(Bundle.main.privateFrameworksURL)
        for name in ["LashKirjaStripe.framework", "StripeTerminal.framework"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: frameworks.appendingPathComponent(name).path), "\(name) is not in the app")
        }
    }

    func testTheSDKLoadsOnlyWhenAsked() {
        // SCPTerminal is the SDK's Terminal class: absent until the loader has run.
        if StripeTerminalLoader.loaded == nil {
            XCTAssertNil(NSClassFromString("SCPTerminal"), "Stripe Terminal was loaded with the app")
        }
        let driver = StripeTerminalLoader.driver()
        XCTAssertNotNil(driver, "LashKirjaStripe.framework did not load")
        XCTAssertNotNil(NSClassFromString("SCPTerminal"))
        XCTAssertEqual(driver?.isInitialized, false)
        XCTAssertNil(driver?.connectedReaderKind)
    }
}
