import XCTest

/// Base for simulator walks: fresh launch + demo sign-in per test, tap/scroll counting, and
/// checks recorded to notes.txt (not asserted, so one miss does not hide the rest).
class WalkTestCase: XCTestCase {
    var taps = 0
    var scrolls = 0
    var app: XCUIApplication!

    override func tearDown() { goOnline(); super.tearDown() }

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
        if app.secureTextFields.firstMatch.waitForExistence(timeout: 8) { signIn(app) }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
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
    func tapLabel(_ pred: String, _ arg: String) -> Bool {
        let q = app.descendants(matching: .any).matching(NSPredicate(format: pred, arg))
        for _ in 0..<7 {
            let e = q.firstMatch
            if e.exists && e.frame.minY > 30 && e.frame.maxY < app.windows.firstMatch.frame.maxY - 60 {
                e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); taps += 1; return true
            }
            app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1
        }
        note("MISS could not find \(arg)"); return false
    }
    func tap(_ label: String) -> Bool { tapLabel("label == %@", label) }
    /// Opens a link through the host (`simctl openurl`), the way a quick action or Siri would.
    func openURL(_ url: String) {
        let name = "\(shotDir)/\(UUID().uuidString).openurl"
        FileManager.default.createFile(atPath: name, contents: url.data(using: .utf8))
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
