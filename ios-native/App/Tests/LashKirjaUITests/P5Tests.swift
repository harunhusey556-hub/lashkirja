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
            // is what this checks, so the overdue row is opened from Myynti instead (noted above), by
            // the status its label ends with. 'Myöhäs' matched the receivables bar's 10 pt segment,
            // left under the navigation bar by the scrolled list: the bar took the tap, the list
            // stayed on Kaikki, and the next 'Lasku ' row was the paid Lasku 1 (run 39538176287).
            shot("p5-koti-miss"); dump(app, "p5-koti-miss")
            tab("Myynti"); sleep(3)
            opened = tapLabel("label CONTAINS 'Lasku ' AND label ENDSWITH %@", ", Myöhässä", scrolls: 10)
        }
        if opened { sleep(4); shot("p5-invoice-detail") }
        check("P5 invoice detail opens at AX5", app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Myöhässä '")).firstMatch.exists)
        tab("Myynti"); tap("Uusi lasku"); sleep(4); shot("p5-invoice-form")
        app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1); shot("p5-invoice-lines")
        check("P5 invoice form opens at AX5", app.navigationBars["Uusi lasku"].exists)
    }
}
