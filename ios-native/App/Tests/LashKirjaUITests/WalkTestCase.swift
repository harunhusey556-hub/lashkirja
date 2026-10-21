import XCTest

/// Base for simulator walks: fresh launch + demo sign-in per test, tap/scroll counting, and
/// checks recorded to notes.txt (not asserted, so one miss does not hide the rest).
class WalkTestCase: XCTestCase {
    var taps = 0
    var scrolls = 0
    var app: XCUIApplication!

    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    /// The system password manager offers to save the demo login; not part of the app. On iOS 26 its
    /// "Save Password?" sheet sits in the app's own element tree, not SpringBoard's (CI dump, 2026-10-15).
    func dismissSystemPrompts() {
        for label in ["Not Now", "Ei nyt"] {
            probe { for root in [springboard, app!] where root.buttons[label].exists { root.buttons[label].tap() } }
        }
    }
    var savePasswordPrompt: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label IN %@", ["Not Now", "Ei nyt"])).firstMatch
    }

    override func tearDown() { goOnline(); keepAnswers(); super.tearDown() }

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        // The flag stands for the one-time notification question (as in P0, U027). A later launch
        // raised it over the walk's taps, and XCTest's own handler could not always answer it (run
        // 39334491019: "Failed to construct element query matching interruption"; every tab tap of
        // P3 B after its relaunch, and of P3 C, landed on the alert). First, so no value-less
        // flag before it can be read as taking the key for its value.
        app.launchArguments += ["-notifications.asked.v1", "YES"]
        app.launchArguments.append("-LKLaunchPhase")
        let signingIn = launchSignedIn()
        // On a fresh simulator the save offer comes seconds after the tab bar, over the first test's
        // taps (CI 2026-10-15: P0 A, P1 01, P2 A, Integration A). Only a sign-in brings it.
        if signingIn { probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) } }
        sleep(1); dismissSystemPrompts()
    }

    /// RootView's marker (`-LKLaunchPhase` or `-LKUITest`): "launching", "restored" (a stored token
    /// the server has not answered for yet), "signedOut" or "signedIn".
    func launchPhase(_ phases: [String]) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND value IN %@", "lk.launch-phase", phases)).firstMatch
    }

    /// Launches and signs in once the app has settled on a phase. A token stored by an earlier walk
    /// against another demo DB paints the tabs first and drops to the sign-in screen only when the
    /// server refuses it: past a fixed 8 s look for the password field (motion gate pr-run1, CI
    /// 2026-10-15), after which the walk waited on a tab bar that never came. Returns whether it
    /// signed in.
    @discardableResult
    func launchSignedIn() -> Bool {
        app.launch()
        let settled = launchPhase(["signedOut", "signedIn"])
        // An app without the marker (or a restored session the server never answers): the
        // sign-in screen is still taken if it is up.
        // A runner whose accessibility service stalls fails the look outright with a snapshot
        // timeout while the app has long painted (CI 2026-10-16: OwnerScreens A on a just-booted
        // simulator, 58 s to set up the automation session; P1 02 behind a 53 s terminate). Only
        // that timeout is let through, and the look is taken again within the same minute.
        let deadline = Date().addingTimeInterval(60)
        var seen = false
        repeat {
            probe { seen = settled.waitForExistence(timeout: max(1, deadline.timeIntervalSinceNow)) }
            if !seen { sleep(3) }
        } while !seen && Date() < deadline
        let signingIn = seen
            ? settled.value as? String == "signedOut"
            : app.secureTextFields.firstMatch.exists
        if signingIn { signIn(app) }
        // On a just-booted simulator typeText can garble the password (CI 2026-10-16: P1 01, seven
        // characters the server refused while the email was right). Typed again once, on the same screen.
        if signingIn, !app.tabBars.firstMatch.waitForExistence(timeout: 30), launchPhase(["signedOut"]).exists {
            // The phase stays "signedOut" while the sign-in request is in flight (CI 2026-10-17: P3 A,
            // "Kirjaudutaan…" still up at 30 s; Koti painted during the retype's 38 s snapshot and the
            // password field was gone). Retyped only once the server has answered and refused.
            let busy = app.buttons["Kirjaudutaan…"].firstMatch
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: busy)], timeout: 60)
            let password = app.secureTextFields.firstMatch
            if !app.tabBars.firstMatch.exists, password.exists {
                type(password, String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "demo123")
                app.buttons["Kirjaudu sisään"].firstMatch.tap()
            }
        }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        return signingIn
    }

    /// Runs a look for a system prompt (SpringBoard's "Open", the password manager's "Not Now").
    /// On a fresh simulator one snapshot can hang past XCTest's limit (CI 2026-10-15: P2 A setUp,
    /// ~100 s on the Save Password probe while Koti first loaded, then the test body was skipped).
    /// Only that snapshot timeout is let through; any other issue inside still fails the test.
    func probe(_ body: () -> Void) {
        let options = XCTExpectedFailure.Options()
        options.isStrict = false
        options.issueMatcher = { $0.compactDescription.contains("Failed to get matching snapshots") }
        XCTExpectFailure("a system prompt probe timed out evaluating its UI query", options: options, failingBlock: body)
    }

    func note(_ s: String) {
        let p = "\(shotDir)/notes.txt"
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        if let h = FileHandle(forWritingAtPath: p) { h.seekToEndOfFile(); h.write((s + "\n").data(using: .utf8)!); h.closeFile() }
        else { FileManager.default.createFile(atPath: p, contents: (s + "\n").data(using: .utf8)) }
    }
    func check(_ name: String, _ ok: Bool) { note("\(ok ? "PASS" : "FAIL") \(name)") }

    func openSettings() {
        app.buttons["Asetukset"].firstMatch.tap(); taps += 1
        _ = app.staticTexts["Sähköpostimallit"].waitForExistence(timeout: 10)
    }
    /// Kirjanpito → "Kuitit, 28 kuittia" (as StabilityTests.openHubRow).
    func openKuitit() -> Bool {
        guard selectTab("Kirjanpito") else { note("MISS tab Kirjanpito not selected"); return false }
        for _ in 0..<2 where !app.navigationBars["Kuitit"].exists {
            tapLabel("label BEGINSWITH %@", "Kuitit")
            _ = app.navigationBars["Kuitit"].waitForExistence(timeout: 10)
        }
        return app.navigationBars["Kuitit"].exists
    }
    /// One photo kept on the phone, the way a photo taken without a connection waits: the proxy goes
    /// offline before the capture screen's queue fixture (a launch with `-LKUITest` only) and stays
    /// offline until `goOnline` (tearDown at the latest), so the photo is still waiting. Ends on Kuitit.
    func queuePhotoOffline() -> Bool {
        guard openKuitit() else { note("MISS Kuitit did not open"); return false }
        goOffline()
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        (camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch).tap(); taps += 1
        let fixture = app.buttons["capture-queue-fixture"].firstMatch
        guard fixture.waitForExistence(timeout: 10) else {
            note("MISS no Testikuitti jonoon: is the app a Debug build launched with -LKUITest?"); return false
        }
        // A reading kept from an earlier run opens the screen on the queue, with the button lower down.
        if !fixture.isHittable {
            app.swipeUp()
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: fixture)], timeout: 5)
        }
        fixture.tap(); taps += 1
        let status = app.descendants(matching: .any).matching(identifier: "capture-queued-status").firstMatch
        guard status.waitForExistence(timeout: 10) else { note("MISS the queued photo is not shown inside the capture screen"); return false }
        let screen = app.navigationBars["Uusi kuitti"]
        let close = screen.buttons.matching(NSPredicate(format: "label IN %@", ["Peruuta", "Sulje"])).firstMatch
        guard close.exists else { note("MISS the capture screen has no Peruuta or Sulje"); return false }
        close.tap(); taps += 1
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: screen)
        return XCTWaiter().wait(for: [gone], timeout: 10) == .completed
    }
    /// Asetukset → "Kirjaudu ulos" from Koti: the sign-out question, once it has stopped rising.
    /// Nil when it did not open.
    func openSignOutQuestion() -> XCUIElement? {
        guard selectTab("Koti") else { note("MISS tab Koti not selected"); return nil }
        openSettings()
        guard tap("Kirjaudu ulos") else { return nil }
        let sheet = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        guard sheet.waitForExistence(timeout: 5) else { note("MISS Kirjaudu ulos did not open the confirm sheet"); return nil }
        waitStill(app.buttons["confirm-sheet-confirm"].firstMatch)
        return sheet
    }
    /// A sheet slides up: its frames are read once two looks a moment apart agree.
    func waitStill(_ element: XCUIElement, timeout: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(timeout)
        var last = element.frame
        while Date() < deadline {
            usleep(250_000)
            let now = element.frame
            if now == last { return }
            last = now
        }
    }
    /// Pressed 0.1 s, dragged slowly and held 0.3 s before the release, so where the finger stops
    /// decides the pop: let go while moving fast, the interactive pop was cancelled at about 46 % on
    /// the slow simulator and the walk went on on the screen it meant to leave (M001).
    func edgeSwipeBack() {
        let w = app.windows.firstMatch
        w.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)),
                   withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    /// Drags a sheet down by its navigation bar (the grab area), like a thumb would.
    func swipeSheetDown(_ title: String) {
        let bar = app.navigationBars[title].firstMatch
        let w = app.windows.firstMatch
        let start = bar.exists ? bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                               : w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        start.press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
    }
    /// Any element whose label matches; scrolls the screen up to 6 times to find it, taps its centre.
    @discardableResult
    func tapLabel(_ pred: String, _ arg: String, scrolls maxScrolls: Int = 6) -> Bool {
        let q = app.descendants(matching: .any).matching(NSPredicate(format: pred, arg))
        // Screens load from the API; give the target time to appear before scrolling for it.
        _ = q.firstMatch.waitForExistence(timeout: 12)
        for _ in 0...maxScrolls {
            let e = q.firstMatch
            if e.exists && e.frame.minY > 30 && e.frame.maxY < app.windows.firstMatch.frame.maxY - 60 {
                e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); taps += 1; return true
            }
            app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1
        }
        // Taller than the screen (a row at the largest text size): never fully inside the window,
        // but XCTest can still tap its visible part.
        let e = q.firstMatch
        if e.exists && e.isHittable { e.tap(); taps += 1; return true }
        note("MISS could not find \(arg)"); return false
    }
    func tap(_ label: String) -> Bool { tapLabel("label == %@", label) }
    /// The overdue invoice from Koti's "Tarvitaan sinulta". Koti shows five tasks; with more waiting
    /// (the CI seed puts documents and matches before it) the overdue row is behind "Näytä enemmän",
    /// which is then tapped first, as the owner would. The tasks lead Koti (N5), so the button is
    /// looked for before any scroll: a row behind it is not drawn, and searching for it first
    /// scrolled the whole screen in vain.
    func openOverdueFromKoti() -> Bool {
        let overdue = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "· myöhässä")).firstMatch
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Näytä enemmän")).firstMatch
        let deadline = Date().addingTimeInterval(20)
        while !overdue.exists && !more.exists && Date() < deadline { usleep(250_000) }
        if !overdue.exists && more.exists {
            // Its centre, where the tap lands, clear of the floating tab bar, which took a tap meant
            // for the button (N1 run 39187969883).
            let bar = app.tabBars.firstMatch
            for _ in 0..<4 where !(more.isHittable && (!bar.exists || more.frame.midY < bar.frame.minY)) {
                app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1
            }
            guard more.isHittable else { note("MISS Näytä enemmän on Koti"); return false }
            more.tap(); taps += 1
            _ = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Näytä vähemmän")).firstMatch.waitForExistence(timeout: 5)
        }
        return tapLabel("label CONTAINS %@", "· myöhässä")
    }
    /// Scrolls the screen (each swipe counted) until `element` sits inside the window, as tapLabel
    /// does before it taps, and taps nothing: a task can end on the button that does it.
    func reveal(_ element: XCUIElement, scrolls maxScrolls: Int = 6) -> Bool {
        let window = app.windows.firstMatch
        for attempt in 0...maxScrolls {
            if element.waitForExistence(timeout: attempt == 0 ? 3 : 1), element.isHittable,
               element.frame.minY > 30, element.frame.maxY < window.frame.maxY - 60 { return true }
            if attempt < maxScrolls { window.swipeUp(velocity: .slow); scrolls += 1 }
        }
        return false
    }
    /// Opens a link through the host (`simctl openurl`), the way a quick action or Siri would.
    func openURL(_ url: String) {
        let name = "\(shotDir)/\(UUID().uuidString).openurl"
        FileManager.default.createFile(atPath: name, contents: url.data(using: .utf8))
        for _ in 0..<40 where FileManager.default.fileExists(atPath: name) { usleep(250_000) }
        // simctl asks "Open in LashKirja?" for a custom scheme; a quick action or Siri does not.
        // On a fresh simulator the first one can take over 15 s (CI 2026-10-15: P2 A shot the
        // dialog still up after the test gave up), so the first link of a run waits longer.
        let open = springboard.buttons["Open"]
        let first = !WalkTestCase.linkOpened
        WalkTestCase.linkOpened = true
        probe { if open.waitForExistence(timeout: first ? 45 : 5) { open.tap() } }
        sleep(2)
        // A dialog that came after the wait is still answered rather than left over the app.
        probe { if open.exists { open.tap(); sleep(2) } }
    }
    /// Set by the run's first `openURL`; one test process is one simulator session.
    static var linkOpened = false
    /// Text size through the host (`simctl ui content_size`), e.g. "accessibility-extra-extra-extra-large".
    func contentSize(_ size: String) {
        let name = "\(shotDir)/\(UUID().uuidString).contentsize"
        FileManager.default.createFile(atPath: name, contents: size.data(using: .utf8))
        for _ in 0..<40 where FileManager.default.fileExists(atPath: name) { usleep(250_000) }
        sleep(2)
    }
    /// The walk's API proxy drops every connection while this file exists (scripts/sim/api-proxy.py).
    func goOffline() { FileManager.default.createFile(atPath: "\(shotDir)/offline.flag", contents: nil) }
    func goOnline() { try? FileManager.default.removeItem(atPath: "\(shotDir)/offline.flag") }
    /// While this file exists each request still reaches the API, but the proxy closes the app's
    /// connection instead of passing the answer on: the work is done and the app cannot know.
    func loseAnswers() { FileManager.default.createFile(atPath: "\(shotDir)/lose-answer.flag", contents: nil) }
    func keepAnswers() { try? FileManager.default.removeItem(atPath: "\(shotDir)/lose-answer.flag") }
    func tab(_ name: String) { app.tabBars.buttons[name].firstMatch.tap(); taps += 1; sleep(2) }
    /// Taps a tab until it reports itself selected. The first tap after sign-in can land while the
    /// passkey offer or a system prompt is still leaving, and is then lost (CI round 1: still on Koti).
    func selectTab(_ name: String) -> Bool {
        let button = app.tabBars.buttons[name].firstMatch
        guard button.waitForExistence(timeout: 10) else { return false }
        for _ in 0..<3 where !button.isSelected {
            dismissSystemPrompts()
            button.tap(); taps += 1
            // A fresh expectation each round: XCTest allows one wait per expectation.
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: button)
            _ = XCTWaiter().wait(for: [selected], timeout: 5)
        }
        return button.isSelected
    }
    /// One measured task from a fresh launch: records "TAPS <name>: n taps, m scrolls" and a screenshot,
    /// then fails when the task's screen was not reached or the path took more taps or scrolls than
    /// its budget. Only noted, a walk that stopped short still read as passed (U021, U023).
    func measure(_ name: String, reached: Bool, maxTaps: Int? = nil, maxScrolls: Int? = nil,
                 file: StaticString = #filePath, line: UInt = #line) {
        note("\(reached ? "TAPS" : "FAIL-NAV") \(name): \(taps) taps, \(scrolls) scrolls")
        shot("nav-" + name)
        XCTAssertTrue(reached, "\(name): the task's screen was not reached", file: file, line: line)
        if let maxTaps {
            XCTAssertLessThanOrEqual(taps, maxTaps, "\(name): \(taps) taps, the path's budget is \(maxTaps)", file: file, line: line)
        }
        if let maxScrolls {
            XCTAssertLessThanOrEqual(scrolls, maxScrolls, "\(name): \(scrolls) scrolls, the path's budget is \(maxScrolls)", file: file, line: line)
        }
    }
    var discardDialog: XCUIElement { app.staticTexts["Hylätäänkö muutokset?"].firstMatch }

    /// The items of a navigation bar beside Back, each label once: a toolbar Menu is a labelled
    /// button around an unlabelled one.
    func barItems(_ bar: XCUIElement) -> [String] {
        var items: [String] = []
        for button in bar.buttons.allElementsBoundByIndex where button.identifier != "BackButton" {
            let label = button.label
            if !label.isEmpty && !items.contains(label) { items.append(label) }
        }
        return items
    }

    /// The band between a bottom bar (`button`, its capsule) and the tab bar under it is the canvas,
    /// flat: rows scrolled under the bar showed through it, cut across, and a row's own white
    /// reads 10 above the canvas even where no text falls (X065). The 3 pt over the tab bar are
    /// left out, where the floating bar's own shadow falls, and 8 pt at each side, where a scroll
    /// indicator may still be fading. Read until it holds, for up to 3 s: the bar fades in.
    @discardableResult
    func assertCanvasUnderBar(_ button: XCUIElement, _ step: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        waitStill(button)
        let tabs = app.tabBars.firstMatch
        let window = app.windows.firstMatch.frame
        guard button.exists, tabs.exists else {
            XCTFail("\(step): no bar or no tab bar to measure between", file: file, line: line); return false
        }
        // A button on or under the tab bar (a row's Hyväksy below the fold, a bar slid behind the
        // tabs) leaves no band, and the check below would pass on nothing.
        guard button.frame.maxY <= tabs.frame.minY else {
            XCTFail("\(step): the bar (maxY \(button.frame.maxY)) is not above the tab bar (minY \(tabs.frame.minY))", file: file, line: line)
            return false
        }
        let band = CGRect(x: window.minX + 8, y: button.frame.maxY + 1, width: window.width - 16,
                          height: tabs.frame.minY - 3 - (button.frame.maxY + 1))
        guard band.height >= 1 else {
            note("INFO \(step): the bar ends at \(button.frame.maxY), the tab bar starts at \(tabs.frame.minY): no band between")
            return true
        }
        let canvas = RGB.canvas.luma
        func holds(_ read: (mean: Double, spread: Double)?) -> Bool {
            guard let read else { return false }
            // Rows showing through are white (luma ~255) and uneven. The floating bar and the tab bar
            // cast a soft, even shadow on this ~7 pt strip (mean 240 against 243, std 0.9 in run
            // 39276760350), so the band may be a little darker than the canvas, never brighter.
            return read.spread < 3 && read.mean <= canvas + 3 && read.mean >= canvas - 8
        }
        var read = luma(app, in: band)
        let deadline = Date().addingTimeInterval(3)
        while !holds(read) && Date() < deadline {
            usleep(250_000)
            read = luma(app, in: band)
        }
        let said = read.map { String(format: "mean %.1f (canvas %.1f), std %.2f", $0.mean, canvas, $0.spread) } ?? "unread"
        note("INFO \(step): band \(band) \(said)")
        XCTAssertTrue(holds(read), "\(step): the band under the bar is not the flat canvas (\(said)): rows show through", file: file, line: line)
        return holds(read)
    }

    /// An action on the open invoice (N6): the screen's one primary when it is that action, else
    /// the item in the bar's Toiminnot. The tiles under the primary (PDF, Lähetä, Maksu, Kopioi)
    /// are gone, so the menu is the only other place it is offered.
    @discardableResult
    func invoiceAction(_ label: String) -> Bool {
        let bar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        let menu = bar.buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 30) else { note("MISS \(label): no invoice with Toiminnot"); return false }
        let primary = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
        if primary.exists && primary.isHittable {
            primary.tap(); taps += 1
            return true
        }
        menu.tap(); taps += 1
        // The menu lies over the screen: its item is the last match.
        let items = app.buttons.matching(NSPredicate(format: "label == %@", label))
        _ = items.firstMatch.waitForExistence(timeout: 5)
        guard let item = items.allElementsBoundByIndex.last(where: { $0.isHittable }) else {
            note("MISS \(label) in Toiminnot")
            // Closes the menu, so the next step starts from the screen; at the leading edge, which the
            // trailing menu never reaches.
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
            return false
        }
        item.tap(); taps += 1
        return true
    }
}
