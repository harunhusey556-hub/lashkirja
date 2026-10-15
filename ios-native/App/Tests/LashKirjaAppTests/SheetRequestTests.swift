import XCTest
@testable import LashKirja

/// P1 01 (OPEN-ISSUES row 20b): "Uusi lasku" in Myynti sometimes did not open the form. The sheet
/// hung on a Bool; a presentation SwiftUI did not carry out left it true, and every later tap wrote
/// true again, which is no change, so the sheet was never asked for again. A `SheetRequest` per tap
/// always changes the binding.
@MainActor
final class SheetRequestTests: XCTestCase {
    func testEveryTapIsANewRequest() {
        XCTAssertNotEqual(SheetRequest(), SheetRequest())
        XCTAssertNotEqual(SheetRequest().id, SheetRequest().id)
    }

    func testATapAfterAPresentationThatNeverShowedStillChangesTheBinding() {
        // The first tap's request is still set: the sheet it asked for never came on screen.
        var changes = 0
        var request: SheetRequest? = SheetRequest() {
            didSet { if request != oldValue { changes += 1 } }
        }
        request = SheetRequest()
        XCTAssertEqual(changes, 1, "a second tap must reach the sheet, not repeat the value it already had")

        // What the Bool did: true over true is no change at all.
        var shown = true
        var boolChanges = 0
        func tap() { let old = shown; shown = true; if shown != old { boolChanges += 1 } }
        tap()
        XCTAssertEqual(boolChanges, 0)
    }
}
