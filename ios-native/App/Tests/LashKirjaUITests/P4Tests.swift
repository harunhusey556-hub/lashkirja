import XCTest

/// P4: assistant without an AI provider (the demo server has none), and retry after a lost answer.
final class P4Tests: WalkTestCase {
    func openAssistant() { app.buttons["Avustaja"].firstMatch.tap(); taps += 1; sleep(3) }
    var composer: XCUIElement { app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch }

    func testA_UnavailableStateIsCalm() {
        openAssistant(); shot("p4-assistant"); dump(app, "p4-assistant")
        assertNoticeReadsAsOne("P4 assistant")
        check("P4 assistant opens with a composer", composer.waitForExistence(timeout: 10))
        // U016 U053 (B11): the shortcuts were cut mid-word at the conversation's margin ('Tämän kuur').
        assertChipRowEdge("assistant-shortcuts", "P4 assistant shortcuts")
    }

    func testB_RetryDoesNotDuplicate() {
        openAssistant()
        guard composer.waitForExistence(timeout: 10) else { check("P4 composer exists", false); return }
        // The assistant reopens the latest conversation: earlier runs' questions may already be in
        // it. What matters is that this send and its retry add exactly one bubble.
        let before = questionBubbles()
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
        let added = questionBubbles() - before
        check("P4 retry keeps one question bubble (added \(added))", added == 1)
    }

    /// M012 M068: the sheet rises on the conversation as it stays. Koti's prefetch has left the
    /// latest conversation and the status in the cache; offline, nothing else can bring them, so
    /// the first look finds what came from there. The composer then holds its place: the notice
    /// that arrived later grew it by two lines.
    func testC_AssistantOpensOnFinalLayout() {
        XCTAssertTrue(afterKotiPrefetch(), "Koti's prefetch of the screens one tap away did not finish")
        goOffline()
        app.buttons["Avustaja"].firstMatch.tap(); taps += 1
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "the assistant has no composer")
        // The first look, read before anything else is asked of the app.
        let greeting = app.staticTexts["Miten voin auttaa?"].exists
        let question = questionBubbles() > 0
        let notice = noticeQuery.firstMatch.exists
        let start = composerTop()
        // testB asked in the latest conversation, which then opens instead of the greeting.
        XCTAssertTrue(greeting || question, "the sheet rose without its conversation: no greeting and no message")
        XCTAssertTrue(notice, "the sheet rose without '\(Self.unavailableNote)'")
        var moved: CGFloat = 0
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            usleep(250_000)
            moved = max(moved, abs(composerTop() - start))
        }
        shot("p4-final-layout")
        XCTAssertLessThanOrEqual(moved, 1, "the composer moved \(moved) pt in the sheet after the first look")
    }

    /// M064: the keyboard leaves with the sheet, by a swipe down and by Valmis, so Koti is back
    /// whole, tab bar included, once the composer has gone. It stayed over Koti for 1.5 s.
    func testD_KeyboardLeavesWithSheet() {
        for close in ["swipe", "Valmis"] {
            app.buttons["Avustaja"].firstMatch.tap(); taps += 1
            guard composer.waitForExistence(timeout: 10) else { XCTFail("\(close): the assistant has no composer"); return }
            type(composer, "Hei")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "\(close): no keyboard came up")
            let done = app.navigationBars.buttons["Valmis"].firstMatch
            XCTAssertTrue(done.exists, "\(close): the assistant's bar has no Valmis")
            if close == "Valmis" {
                done.tap()
            } else {
                // By the sheet's navigation bar, where a thumb drags it.
                let window = app.windows.firstMatch
                let bar = window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                    .withOffset(CGVector(dx: window.frame.midX, dy: done.frame.midY))
                bar.press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            }
            taps += 1
            XCTAssertTrue(composer.waitForNonExistence(timeout: 10), "\(close): the sheet did not close")
            XCTAssertFalse(app.keyboards.firstMatch.exists, "\(close): the keyboard outlived the sheet")
            XCTAssertTrue(app.tabBars.firstMatch.isHittable, "\(close): the tab bar is not back after the sheet")
        }
    }

    /// The question's bubbles in the message list; the conversation's title repeats it in the
    /// navigation bar, which is not a bubble.
    func questionBubbles() -> Int {
        let question = NSPredicate(format: "label == 'Paljonko myyntiä tässä kuussa?'")
        return app.staticTexts.matching(question).count - app.navigationBars.staticTexts.matching(question).count
    }

    /// AssistantCooldown.unavailableNote: the demo server has no AI provider.
    static let unavailableNote = "Tekoälyavustaja ei ole juuri nyt käytössä. Pikakomennot toimivat silti."
    var noticeQuery: XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", Self.unavailableNote))
    }

    /// U057: the decorative sparkles say nothing to VoiceOver (they read 'Säihke'), and the notice
    /// is one element, its words.
    func assertNoticeReadsAsOne(_ step: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(noticeQuery.firstMatch.waitForExistence(timeout: 10), "\(step): no '\(Self.unavailableNote)'", file: file, line: line)
        XCTAssertEqual(noticeQuery.count, 1, "\(step): the notice is \(noticeQuery.count) elements", file: file, line: line)
        XCTAssertEqual(noticeQuery.firstMatch.elementType, .staticText, "\(step): the notice is not a text", file: file, line: line)
        // In the conversation, where the greeting's and the notice's sparkles are: XCUITest still
        // lists Koti under the sheet, and its 'Hoidettu automaattisesti' card shows one there too.
        let conversation = app.scrollViews.containing(NSPredicate(format: "label == %@", "Miten voin auttaa?")).firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 10), "\(step): no conversation with 'Miten voin auttaa?'", file: file, line: line)
        let sparkles = conversation.images.matching(NSPredicate(format: "identifier == %@ OR label == %@", "sparkles", "Säihke"))
        XCTAssertEqual(sparkles.count, 0, "\(step): \(sparkles.count) sparkles images reach VoiceOver", file: file, line: line)
    }

    /// The composer's top within the sheet: measured from the sheet's own bar, so the sheet still
    /// rising does not count as the composer moving.
    func composerTop() -> CGFloat {
        composer.frame.minY - app.navigationBars.buttons["Keskustelut"].firstMatch.frame.minY
    }

    /// Koti's prefetch has warmed the screens one tap away, the assistant's among them
    /// (AppModel.prefetch adds "afterKoti" to RootView's launch marker).
    func afterKotiPrefetch() -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "lk.launch-phase", "afterKoti="))
            .firstMatch.waitForExistence(timeout: 60)
    }
}
