import XCTest
import UIKit

/// Where screenshots and notes.txt go. scripts/sim/run-ui.sh passes LK_SHOT_DIR through
/// TEST_RUNNER_LK_SHOT_DIR; the default keeps a bare xcodebuild run working.
let shotDir = ProcessInfo.processInfo.environment["LK_SHOT_DIR"] ?? NSTemporaryDirectory() + "lk-shots"

extension XCTestCase {
    /// Screenshot via the host: writes a request file, a host-side watcher runs `simctl io screenshot`.
    func shot(_ name: String) {
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        let png = "\(shotDir)/\(name).png"
        FileManager.default.createFile(atPath: "\(shotDir)/\(name).req", contents: nil)
        for _ in 0..<40 where !FileManager.default.fileExists(atPath: png) { usleep(250_000) }
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

/// A colour on the screen as 8-bit sRGB, the space the palette (Theme.swift) is written in.
struct RGB: Equatable, CustomStringConvertible {
    let r: Int, g: Int, b: Int
    /// Theme.canvas in the light appearance (#F6F3EF).
    static let canvas = RGB(r: 246, g: 243, b: 239)
    var description: String { "(\(r),\(g),\(b))" }
    func near(_ other: RGB, within tolerance: Int) -> Bool {
        abs(r - other.r) <= tolerance && abs(g - other.g) <= tolerance && abs(b - other.b) <= tolerance
    }
}

/// The pixel helper (B2; B5, B12, B14, P1 and P3 reuse it).
extension XCTestCase {
    /// The colours at `points` (screen points, as element frames give them), all read off one
    /// screenshot; nil for a point off the screen. Each pixel is drawn into an sRGB context, so a
    /// wide-colour capture still reads as the sRGB values the palette is written in.
    func screenColours(_ app: XCUIApplication, at points: [CGPoint]) -> [RGB?] {
        let shot = XCUIScreen.main.screenshot()
        let screen = app.windows.firstMatch.frame
        guard let image = shot.image.cgImage ?? UIImage(data: shot.pngRepresentation)?.cgImage,
              let space = CGColorSpace(name: CGColorSpace.sRGB), screen.width > 0 else { return points.map { _ in nil } }
        // The capture is at the screen's native scale (3 px a point on a current iPhone).
        let scale = CGFloat(image.width) / screen.width
        return points.map { point -> RGB? in
            let pixel = CGRect(x: ((point.x - screen.minX) * scale).rounded(.down), y: ((point.y - screen.minY) * scale).rounded(.down),
                               width: 1, height: 1)
            guard pixel.minX >= 0, pixel.minY >= 0, pixel.maxX <= CGFloat(image.width), pixel.maxY <= CGFloat(image.height),
                  let one = image.cropping(to: pixel),
                  let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            context.draw(one, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
            return RGB(r: Int(bytes[0]), g: Int(bytes[1]), b: Int(bytes[2]))
        }
    }

    /// The gutter left of a grouped list's cards: 6 pt in from the left edge of `bar` (the screen's,
    /// or a floating sheet's) at three heights under it, so Theme.canvas on a warm screen and never a
    /// card. Read once two looks 250 ms apart agree on the bar's frame and the colours: mid-push the
    /// gutter still shows the screen underneath, and a rising sheet or a page fade is not done.
    func gutterColours(_ app: XCUIApplication, under bar: XCUIElement, timeout: TimeInterval = 6) -> [RGB?] {
        var last: (frame: CGRect, colours: [RGB?])?
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let frame = bar.frame
            let points = [60, 140, 220].map { CGPoint(x: frame.minX + 6, y: frame.maxY + CGFloat($0)) }
            let now = (frame: frame, colours: screenColours(app, at: points))
            if let last, last.frame == now.frame, last.colours == now.colours { return now.colours }
            last = now
            usleep(250_000)
        } while Date() < deadline
        return last?.colours ?? []
    }

    /// The screen under `bar` is on the warm canvas: every gutter read within ±3 of Theme.canvas.
    /// A Form or List without `.scrollContentBackground(.hidden).background(Theme.canvas)` reads
    /// (242,242,247), the system grouped background.
    @discardableResult
    func assertWarmCanvas(_ app: XCUIApplication, under bar: XCUIElement, _ screen: String,
                          file: StaticString = #filePath, line: UInt = #line) -> Bool {
        guard bar.waitForExistence(timeout: 10) else {
            XCTFail("\(screen): the screen did not open", file: file, line: line); return false
        }
        let read = gutterColours(app, under: bar)
        let warm = !read.isEmpty && read.allSatisfy { $0?.near(.canvas, within: 3) == true }
        XCTAssertTrue(warm, "\(screen): the gutter reads \(read.map { $0?.description ?? "off screen" }.joined(separator: " ")), not the canvas \(RGB.canvas)",
                      file: file, line: line)
        return warm
    }
}
