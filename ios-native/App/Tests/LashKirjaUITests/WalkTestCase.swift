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

    override func tearDown() { goOnline(); super.tearDown() }

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
        let signingIn = app.secureTextFields.firstMatch.waitForExistence(timeout: 8)
        if signingIn { signIn(app) }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        // On a fresh simulator the save offer comes seconds after the tab bar, over the first test's
        // taps (CI 2026-10-15: P0 A, P1 01, P2 A, Integration A). Only a sign-in brings it.
        if signingIn { probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) } }
        sleep(1); dismissSystemPrompts()
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
    func edgeSwipeBack() {
        let w = app.windows.firstMatch
        w.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
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
    func tab(_ name: String) { app.tabBars.buttons[name].firstMatch.tap(); taps += 1; sleep(2) }
    /// One measured task from a fresh launch: records "TAPS <name>: n taps, m scrolls" and a screenshot.
    func measure(_ name: String, reached: Bool) {
        note("\(reached ? "TAPS" : "FAIL-NAV") \(name): \(taps) taps, \(scrolls) scrolls")
        shot("nav-" + name.replacingOccurrences(of: " ", with: "-"))
    }
    var discardDialog: XCUIElement { app.staticTexts["Hylätäänkö muutokset?"].firstMatch }

}
