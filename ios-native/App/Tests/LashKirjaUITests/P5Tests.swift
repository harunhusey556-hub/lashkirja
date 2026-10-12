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
        // At AX5 one card fills the screen: the overdue row can be far down Koti. Koti shows five
        // tasks; in a full run the earlier tests add tasks, and the overdue one moves behind
        // "Näytä enemmän".
        var opened = tapLabel("label CONTAINS %@", "· myöhässä", scrolls: 20)
        if !opened, tapLabel("label BEGINSWITH %@", "Näytä enemmän", scrolls: 20) {
            sleep(1)
            opened = tapLabel("label CONTAINS %@", "· myöhässä", scrolls: 20)
        }
        if !opened {
            // Twenty slow swipes through Koti at AX5 now and then end elsewhere; the invoice itself
            // is what this checks, so it is opened from Myynti's overdue chip instead (noted above).
            shot("p5-koti-miss"); dump(app, "p5-koti-miss")
            tab("Myynti"); sleep(3)
            if tapLabel("label BEGINSWITH %@", "Myöhäs", scrolls: 4) {
                sleep(2)
                opened = tapLabel("label CONTAINS %@", "Lasku ", scrolls: 10)
            }
        }
        if opened { sleep(4); shot("p5-invoice-detail") }
        check("P5 invoice detail opens at AX5", app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Myöhässä '")).firstMatch.exists)
        tab("Myynti"); tap("Uusi lasku"); sleep(4); shot("p5-invoice-form")
        app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1); shot("p5-invoice-lines")
        check("P5 invoice form opens at AX5", app.navigationBars["Uusi lasku"].exists)
    }
}
