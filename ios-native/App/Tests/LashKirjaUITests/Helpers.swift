import XCTest

/// Where screenshots and notes.txt go. scripts/sim/run-ui.sh passes LK_SHOT_DIR through
/// TEST_RUNNER_LK_SHOT_DIR; the default keeps a bare xcodebuild run working.
let shotDir = ProcessInfo.processInfo.environment["LK_SHOT_DIR"] ?? NSTemporaryDirectory() + "lk-shots"

extension XCTestCase {
    /// Screenshot via the host: writes a request file, a host-side watcher runs `simctl io screenshot`.
    /// The file name keeps only [A-Za-z0-9-]: a '/' in a step title made the request a path into a
    /// folder that does not exist, and the shot went missing without a word (U022).
    func shot(_ name: String) {
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        let file = String(name.map { (c: Character) -> Character in c.isASCII && (c.isLetter || c.isNumber) || c == "-" ? c : "-" })
        let png = "\(shotDir)/\(file).png"
        guard FileManager.default.createFile(atPath: "\(shotDir)/\(file).req", contents: nil) else {
            (self as? WalkTestCase)?.note("MISS shot \(file)"); return
        }
        for _ in 0..<40 where !FileManager.default.fileExists(atPath: png) { usleep(250_000) }
        if !FileManager.default.fileExists(atPath: png) { (self as? WalkTestCase)?.note("MISS shot \(file)") }
    }
    func dump(_ app: XCUIApplication, _ name: String) {
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        try? app.debugDescription.write(toFile: "\(shotDir)/\(name).txt", atomically: true, encoding: .utf8)
    }
    /// Taps until the field really has focus (first tap after launch is sometimes eaten), then types.
    func type(_ field: XCUIElement, _ text: String) {
        for _ in 0..<5 {
            field.tap()
            let focused = NSPredicate(format: "hasKeyboardFocus == true")
            if XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: focused, object: field)], timeout: 2) == .completed { break }
        }
        field.typeText(text)
    }
    /// Signs in with the demo-seed user. Test values from app/scripts/demo-seed.ts; only ever against a throwaway local server.
    func signIn(_ app: XCUIApplication) {
        let email = app.textFields.firstMatch
        guard email.waitForExistence(timeout: 10) else { return }
        type(email, "demo@lashkirja.fi")
        type(app.secureTextFields.firstMatch, "demo123")
        app.buttons["Kirjaudu sisään"].firstMatch.tap()
    }
}
