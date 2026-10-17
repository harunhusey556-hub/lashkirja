import XCTest
@testable import LashKirja

/// w56 (row 27): Stripe Terminal is not loaded at launch, and loads when a card payment needs it.
@MainActor
final class StripeTerminalLoaderTests: XCTestCase {
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
