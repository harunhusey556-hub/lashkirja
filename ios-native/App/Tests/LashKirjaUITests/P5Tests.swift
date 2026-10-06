import XCTest

/// P5: the five riskiest screens at the largest accessibility text size. Screenshots are the
/// evidence; the checks only catch money that VoiceOver or layout lost entirely.
final class P5Tests: WalkTestCase {
    override func tearDown() { contentSize("large"); super.tearDown() }

    func testA_LargestTextSize() {
        contentSize("accessibility-extra-extra-extra-large")
        app.terminate(); app.launch(); _ = app.tabBars.firstMatch.waitForExistence(timeout: 30); sleep(3)
        shot("p5-koti-top")
        app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1); shot("p5-koti-tasks")
        check("P5 Koti shows money at AX5", app.staticTexts.matching(NSPredicate(format: "label CONTAINS '€'")).count > 0)
        tab("Myynti"); sleep(3); shot("p5-myynti")
        app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1); shot("p5-myynti-rows")
        tab("Koti"); sleep(2)
        if tapLabel("label CONTAINS %@", "· myöhässä") { sleep(4); shot("p5-invoice-detail") }
        check("P5 invoice detail opens at AX5", app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Myöhässä '")).firstMatch.exists)
        tab("Myynti"); tap("Uusi lasku"); sleep(4); shot("p5-invoice-form")
        app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1); shot("p5-invoice-lines")
        check("P5 invoice form opens at AX5", app.navigationBars["Uusi lasku"].exists)
    }
}
