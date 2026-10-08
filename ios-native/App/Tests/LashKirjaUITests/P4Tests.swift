import XCTest

/// P4: assistant without an AI provider (the demo server has none), and retry after a lost answer.
final class P4Tests: WalkTestCase {
    func openAssistant() { app.buttons["Avustaja"].firstMatch.tap(); taps += 1; sleep(3) }
    var composer: XCUIElement { app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch }

    func testA_UnavailableStateIsCalm() {
        openAssistant(); shot("p4-assistant"); dump(app, "p4-assistant")
        check("P4 assistant opens with a composer", composer.waitForExistence(timeout: 10))
    }

    func testB_RetryDoesNotDuplicate() {
        openAssistant()
        guard composer.waitForExistence(timeout: 10) else { check("P4 composer exists", false); return }
        goOffline()
        type(composer, "Paljonko myyntiä tässä kuussa?")
        // The composer is multi-line: Return adds a line, the arrow button sends.
        app.buttons["Lähetä"].firstMatch.tap()
        sleep(6); shot("p4-failed"); dump(app, "p4-failed")
        let retry = app.buttons["Yritä uudelleen"].firstMatch
        check("P4 failed answer offers Yritä uudelleen", retry.waitForExistence(timeout: 20))
        goOnline(); sleep(10)
        if retry.exists { retry.tap(); sleep(8) }
        shot("p4-after-retry")
        // Only bubbles in the message area: the conversation takes the question as its title (the
        // header at the top) and lists it behind the sheet, which once counted as "3 bubbles".
        let top = app.windows.firstMatch.frame.height * 0.15
        let bubbles = app.staticTexts.matching(NSPredicate(format: "label == 'Paljonko myyntiä tässä kuussa?'"))
            .allElementsBoundByIndex.filter { $0.frame.minY > top && $0.isHittable }.count
        check("P4 retry keeps one question bubble (found \(bubbles))", bubbles == 1)
    }
}
