import XCTest

/// P3: offline banner, recovery, and a copy whose answer is lost on the way back.
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

    /// U043: the copy reaches the server and only its answer is lost, the one case where a retry
    /// could make a second draft. The server's own count says one copy after the lost answer and
    /// still one after the retry, which goes out with the same Idempotency-Key.
    func testB_CopyWhileOffline() {
        // The demo API itself, past the proxy (the runner shares the Mac's loopback). Test values
        // from app/scripts/demo-seed.ts; only ever against the throwaway demo API.
        func call(_ path: String, _ body: [String: String]?, _ bearer: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            if let body {
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
            var result: [String: Any]?
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, _, _ in
                result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 30)
            return result
        }
        guard let bearer = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String else {
            XCTFail("the demo API gave no token"); return
        }
        defer { _ = call("/api/auth/logout", [:], bearer) }
        func serverDrafts() -> Int? { (call("/api/invoices/counts", nil, bearer)?["counts"] as? [String: Any])?["draft"] as? Int }

        tab("Myynti")
        let drafts = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Luonnokset'")).firstMatch
        let before = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        guard let stored = serverDrafts() else { XCTFail("the demo API gave no draft count"); return }
        guard tapLabel("label CONTAINS %@", "· myöhässä") || { tab("Koti"); return tapLabel("label CONTAINS %@", "· myöhässä") }() else { return }
        _ = app.buttons["Kopioi"].waitForExistence(timeout: 30)
        loseAnswers()
        guard tap("Kopioi") else { return }
        // The request went out, so the app cannot say the copy was not made (WriteFailureCopy).
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Kopio on voinut'")).firstMatch
        let explained = message.waitForExistence(timeout: 30)
        shot("p3b-copy-lost"); dump(app, "p3b-copy-lost")
        check("P3 lost copy says it may have been saved (\(explained ? message.label : "no message"))", explained)
        var copies = serverDrafts()
        for _ in 0..<10 where copies != stored + 1 { sleep(1); copies = serverDrafts() }
        XCTAssertEqual(copies, stored + 1, "the copy whose answer was lost is not one draft on the server (before: \(stored))")
        keepAnswers()
        // The retry gets the first copy back, and the app opens it (a draft: Muokkaa, not Kopioi).
        guard tap("Kopioi") else { return }
        let opened = app.buttons["Muokkaa"].firstMatch.waitForExistence(timeout: 30)
        shot("p3b-copy-retried")
        XCTAssertTrue(opened, "the retry did not open the copy")
        XCTAssertEqual(serverDrafts(), stored + 1, "the retry made a second draft (before: \(stored))")
        app.terminate()
        // The launch every other test takes: it waits for the phase the app settles on. A bare
        // relaunch tapped Myynti 2.7 s after Koti painted; the tap was lost (no Myynti paint in the
        // app log, Koti's rows still in the tree), so the chip was never read (run 38993875695).
        launchSignedIn()
        check("P3 Myynti selected after the relaunch", selectTab("Myynti"))
        let after = drafts.waitForExistence(timeout: 10) ? drafts.label : "?"
        note("INFO drafts before: \(before), after the lost copy and its retry: \(after); server \(stored) before")
        check("P3 drafts chip read after the relaunch", after != "?")
        let shown: String = after.filter(\.isNumber)
        check("P3 drafts chip shows the server's one copy (\(after))", Int(shown) == stored + 1)
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
