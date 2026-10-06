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
        let bubbles = app.staticTexts.matching(NSPredicate(format: "label == 'Paljonko myyntiä tässä kuussa?'")).count
        check("P4 retry keeps one question bubble (found \(bubbles))", bubbles == 1)
    }
}
