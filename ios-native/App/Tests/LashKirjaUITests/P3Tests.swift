import XCTest

/// P3: offline banner, recovery, and a copy made while the API is unreachable.
final class P3Tests: WalkTestCase {
    var banner: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'yhteyttä' OR label CONTAINS 'Ei verkkoyhteyttä'")).firstMatch
    }

    func testA_OfflineBannerAndRecovery() {
        tab("Myynti")
        goOffline()
        // Two failed loads make the server count as unreachable.
        for _ in 0..<2 { app.windows.firstMatch.swipeDown(velocity: .fast); sleep(3) }
        shot("p3a-offline")
        check("P3 offline banner appears when the API is unreachable", banner.waitForExistence(timeout: 20))
        goOnline()
        let gone = NSPredicate(format: "exists == false")
        let recovered = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: gone, object: banner)], timeout: 30) == .completed
        shot("p3a-online")
        check("P3 banner clears after the API is back", recovered)
    }

    func testB_CopyWhileOffline() {
        tab("Myynti")
        let drafts = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Luonnokset'")).firstMatch
        let before = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        guard tapLabel("label CONTAINS %@", "myöhässä") || { tab("Koti"); return tapLabel("label CONTAINS %@", "myöhässä 16") }() else { return }
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
