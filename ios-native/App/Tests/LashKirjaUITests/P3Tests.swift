import XCTest

/// P3: offline banner, recovery, and a copy made while the API is unreachable.
final class P3Tests: WalkTestCase {
    /// The quiet capsule at the top; the screen's own failure panel can carry the same words.
    var banner: XCUIElement { app.descendants(matching: .any)["offline-banner"] }

    func testA_OfflineBannerAndRecovery() {
        tab("Myynti")
        goOffline()
        // Two failed loads make the server count as unreachable. A pull-to-refresh swipe does not
        // always start a load (seen 2026-10-08: no request at all); a tab switch always does.
        for _ in 0..<2 { app.windows.firstMatch.swipeDown(velocity: .fast); sleep(3) }
        tab("Kirjanpito"); sleep(3); tab("Myynti"); sleep(3)
        shot("p3a-offline")
        check("P3 offline banner appears when the API is unreachable", banner.waitForExistence(timeout: 20))
        goOnline()
        let gone = NSPredicate(format: "exists == false")
        let recovered = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: gone, object: banner)], timeout: 30) == .completed
        shot("p3a-online")
        check("P3 banner clears after the API is back", recovered)
        // The screen that failed while offline reloads on its own: no "Yritä uudelleen" needed.
        let reloaded = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Luonnokset'")).firstMatch.waitForExistence(timeout: 20)
        shot("p3a-reloaded")
        check("P3 failed screen reloads by itself when back online", reloaded)
    }

    func testB_CopyWhileOffline() {
        tab("Myynti")
        let drafts = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Luonnokset'")).firstMatch
        let before = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        guard tapLabel("label CONTAINS %@", "· myöhässä") || { tab("Koti"); return tapLabel("label CONTAINS %@", "· myöhässä") }() else { return }
        _ = app.buttons["Kopioi"].waitForExistence(timeout: 30)
        goOffline(); sleep(1)
        guard tap("Kopioi") else { return }
        sleep(4); shot("p3b-copy-offline"); dump(app, "p3b-copy-offline")
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Kopio' OR label CONTAINS 'yhteys' OR label CONTAINS 'Yhteys'")).firstMatch
        check("P3 failed copy explains what happened (\(message.exists ? message.label : "no message"))", message.exists)
        goOnline(); sleep(10)
        app.terminate(); app.launch(); _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        tab("Myynti")
        let after = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        note("INFO drafts before: \(before), after offline copy: \(after)")
        check("P3 offline copy created no draft", before == after)
    }
}
