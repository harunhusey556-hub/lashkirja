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
        // Myynti's overdue row: its badge says "Myöhässä", its line the due date (N6, M100).
        guard tapLabel("label CONTAINS 'Myöhässä' AND label CONTAINS %@", "· eräpäivä")
                || { tab("Koti"); return tapLabel("label CONTAINS %@", "· myöhässä") }() else { return }
        _ = app.navigationBars.buttons["Toiminnot"].firstMatch.waitForExistence(timeout: 30)
        // U045: the failure is said without moving the screen. Its card was inserted above the tabs
        // and pushed them 94 pt down once the screen had settled.
        let tabs = app.buttons["Rivit"].firstMatch
        _ = tabs.waitForExistence(timeout: 10)
        waitStill(tabs)
        let tabsBefore = tabs.frame.minY
        goOffline(); sleep(1)
        // Kopioi luonnokseksi is in Toiminnot (N6): the Kopioi tile is gone.
        guard invoiceAction("Kopioi luonnokseksi") else { return }
        sleep(4); shot("p3b-copy-offline"); dump(app, "p3b-copy-offline")
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Kopio' OR label CONTAINS 'yhteys' OR label CONTAINS 'Yhteys'")).firstMatch
        check("P3 failed copy explains what happened (\(message.exists ? message.label : "no message"))", message.exists)
        let failure = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Yhteys katkesi' OR label BEGINSWITH 'Ei verkkoyhteyttä'")).firstMatch
        if failure.waitForExistence(timeout: 20) {
            let moved = tabs.frame.minY - tabsBefore
            note("INFO P3 tabs at \(tabsBefore), after the failure \(tabs.frame.minY)")
            XCTAssertLessThanOrEqual(abs(moved), 1, "the failure moved the tabs \(moved) pt: \(failure.label)")
        } else {
            XCTFail("the offline copy said no Yhteys katkesi or Ei verkkoyhteyttä")
        }
        goOnline(); sleep(10)
        app.terminate()
        // The launch every other test takes: it waits for the phase the app settles on. A bare
        // relaunch tapped Myynti 2.7 s after Koti painted; the tap was lost (no Myynti paint in the
        // app log, Koti's rows still in the tree), so the chip was never read (run 38993875695).
        launchSignedIn()
        check("P3 Myynti selected after the relaunch", selectTab("Myynti"))
        let after = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        note("INFO drafts before: \(before), after offline copy: \(after)")
        check("P3 drafts chip read after the relaunch", after != "?")
        check("P3 offline copy created no draft", before == after)
    }

    // X122 (P0): signing out deletes the receipt photos still waiting on the phone. The question says
    // how many first, and Peruuta keeps both the session and the photo. Asserted, not only noted: a
    // silent loss of receipts. Last in the class: once the proxy is back, the photo goes to the demo
    // API's inbox.
    func testC_SignOutWarnsAboutQueue() {
        // The capture screen's queue fixture comes only with -LKUITest.
        app.terminate()
        app.launchArguments.append("-LKUITest")
        launchSignedIn()
        guard queuePhotoOffline() else { shot("p3c-not-queued"); dump(app, "p3c-not-queued"); XCTFail("no photo was kept on the phone"); return }
        guard let sheet = openSignOutQuestion() else {
            shot("p3c-no-question"); dump(app, "p3c-no-question"); XCTFail("Asetukset > Kirjaudu ulos did not ask"); return
        }
        shot("p3c-signout-question")
        let message = app.staticTexts["confirm-sheet-message"].firstMatch
        guard message.exists else { dump(app, "p3c-signout-question"); XCTFail("a photo waits, yet the sign-out question says nothing"); return }
        note("INFO P3 sign-out message: \(message.label)")
        XCTAssertTrue(message.label.contains("1 kuitti odottaa lähetystä"), "message: \(message.label)")
        XCTAssertTrue(message.label.contains("poistetaan tästä laitteesta"), "message: \(message.label)")
        // U008: the question is as tall as its words, with no blank band above the buttons.
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        let gap = confirm.frame.minY - message.frame.maxY
        note("INFO P3 sign-out gap: \(gap) pt between the message and \(confirm.label); sheet \(sheet.frame)")
        XCTAssertLessThanOrEqual(gap, 24, "\(gap) pt of empty sheet between the message and the buttons")

        app.buttons["confirm-sheet-cancel"].firstMatch.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 10), .completed, "Peruuta did not close the question")
        let settings = app.navigationBars["Asetukset"]
        XCTAssertTrue(settings.exists, "Peruuta left Asetukset: the session ended")
        guard settings.exists else { shot("p3c-after-peruuta"); return }
        settings.buttons["Valmis"].tap(); taps += 1
        XCTAssertTrue(selectTab("Kirjanpito"), "no tabs after Peruuta: the session ended")
        // Kuitit is still open under Kirjanpito; its card lists what waits.
        let queued = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Jonossa 1 kuitti")).firstMatch
        let kept = queued.waitForExistence(timeout: 10)
        shot("p3c-after-peruuta")
        XCTAssertTrue(kept, "Peruuta did not keep the waiting photo")
        goOnline()
    }
}
