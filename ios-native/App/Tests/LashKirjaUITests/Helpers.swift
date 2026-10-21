import XCTest
import UIKit

/// Where screenshots and notes.txt go. scripts/sim/run-ui.sh passes LK_SHOT_DIR through
/// TEST_RUNNER_LK_SHOT_DIR; the default keeps a bare xcodebuild run working.
let shotDir = ProcessInfo.processInfo.environment["LK_SHOT_DIR"] ?? NSTemporaryDirectory() + "lk-shots"
/// Set by the first PNG the host writes; one test process is one simulator session.
private var hostAnsweredShot = false

extension XCTestCase {
    /// Screenshot via the host: writes a request file, a host-side watcher runs `simctl io screenshot`.
    /// The file name keeps only [A-Za-z0-9-]: a '/' in a step title made the request a path into a
    /// folder that does not exist, and the shot went missing without a word (U022).
    func shot(_ name: String) {
        awaitShot(requestShot(name), since: Date())
    }
    /// `shot`'s first half, for a caller with work to do while the host takes the picture: the
    /// request is written at once, so the picture shows the screen of this moment (U094). Returns
    /// the PNG's path, nil when no request could be written. A PNG left by an earlier request of the
    /// same name goes first, so the one found later is this request's.
    func requestShot(_ name: String) -> String? {
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        let file = String(name.map { (c: Character) -> Character in c.isASCII && (c.isLetter || c.isNumber) || c == "-" ? c : "-" })
        let png = "\(shotDir)/\(file).png"
        try? FileManager.default.removeItem(atPath: png)
        guard FileManager.default.createFile(atPath: "\(shotDir)/\(file).req", contents: nil) else {
            (self as? WalkTestCase)?.note("MISS shot \(file)"); return nil
        }
        return png
    }
    /// `shot`'s second half: waits for the host's PNG, up to 30 s until the host has answered once,
    /// then up to 15 s. Returns the milliseconds from `asked` to the PNG's writing, nil when none came.
    @discardableResult
    func awaitShot(_ png: String?, since asked: Date) -> Int? {
        guard let png else { return nil }
        // A fresh simulator's first `simctl io screenshot` took 5–10.3 s (OwnerScreens' first shot,
        // runs 39487668420–39521465092), and the 10 s wait gave up on a picture that came: each
        // class's first shot was a MISS (p4-assistant, stability-kuitit, a1-settings). A later one
        // took up to 6.7 s, and once over 10 s (stability-raportit-csv, run 39521465092).
        let tenths = hostAnsweredShot ? 150 : 300
        for _ in 0..<tenths where !FileManager.default.fileExists(atPath: png) { usleep(100_000) }
        guard FileManager.default.fileExists(atPath: png) else {
            (self as? WalkTestCase)?.note("MISS shot \(((png as NSString).lastPathComponent as NSString).deletingPathExtension)")
            return nil
        }
        hostAnsweredShot = true
        let written = (try? FileManager.default.attributesOfItem(atPath: png)[.modificationDate] as? Date) ?? Date()
        return Int(written.timeIntervalSince(asked) * 1000)
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
    /// Brightness 0–255, weighted as the eye sees it (Rec. 709).
    var luma: Double { 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b) }
    func near(_ other: RGB, within tolerance: Int) -> Bool {
        abs(r - other.r) <= tolerance && abs(g - other.g) <= tolerance && abs(b - other.b) <= tolerance
    }
}

/// The pixel helper (B2; B5, B12, B14, P1 and P3 reuse it).
extension XCTestCase {
    /// The colours at `points` (screen points, as element frames give them), all read off one
    /// screenshot; nil for a point off the screen.
    func screenColours(_ app: XCUIApplication, at points: [CGPoint]) -> [RGB?] {
        guard let capture = screenCapture(app) else { return points.map { _ in nil } }
        let image = capture.image, screen = capture.screen, scale = capture.scale
        return points.map { point -> RGB? in
            let pixel = CGRect(x: ((point.x - screen.minX) * scale).rounded(.down), y: ((point.y - screen.minY) * scale).rounded(.down),
                               width: 1, height: 1)
            guard pixel.minX >= 0, pixel.minY >= 0, pixel.maxX <= CGFloat(image.width), pixel.maxY <= CGFloat(image.height),
                  let bytes = sRGBBytes(image, in: pixel) else { return nil }
            return RGB(r: Int(bytes[0]), g: Int(bytes[1]), b: Int(bytes[2]))
        }
    }

    /// The brightness across `rect` (screen points, as element frames give them), read off one
    /// screenshot: its mean and its standard deviation, as luma 0–255. A flat fill has a spread of
    /// 0; a line of text cut across reads in the tens. Nil when the rect is not on the screen.
    func luma(_ app: XCUIApplication, in rect: CGRect) -> (mean: Double, spread: Double)? {
        guard let capture = screenCapture(app) else { return nil }
        let image = capture.image, screen = capture.screen, scale = capture.scale
        let pixels = CGRect(x: (rect.minX - screen.minX) * scale, y: (rect.minY - screen.minY) * scale,
                            width: rect.width * scale, height: rect.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !pixels.isNull, pixels.width >= 1, pixels.height >= 1, let bytes = sRGBBytes(image, in: pixels) else { return nil }
        var sum = 0.0, squares = 0.0
        for index in stride(from: 0, to: bytes.count, by: 4) {
            let value = RGB(r: Int(bytes[index]), g: Int(bytes[index + 1]), b: Int(bytes[index + 2])).luma
            sum += value
            squares += value * value
        }
        let count = Double(bytes.count / 4)
        let mean = sum / count
        return (mean: mean, spread: max(0, squares / count - mean * mean).squareRoot())
    }

    /// The darkest pixel across `rect` (screen points), by luma: a glyph's own colour, whatever the
    /// antialiasing around its edges. Nil when the rect is not on the screen.
    func darkestColour(_ app: XCUIApplication, in rect: CGRect) -> RGB? {
        guard let capture = screenCapture(app) else { return nil }
        let image = capture.image, screen = capture.screen, scale = capture.scale
        let pixels = CGRect(x: (rect.minX - screen.minX) * scale, y: (rect.minY - screen.minY) * scale,
                            width: rect.width * scale, height: rect.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !pixels.isNull, pixels.width >= 1, pixels.height >= 1, let bytes = sRGBBytes(image, in: pixels) else { return nil }
        var darkest: RGB?
        for index in stride(from: 0, to: bytes.count, by: 4) {
            let pixel = RGB(r: Int(bytes[index]), g: Int(bytes[index + 1]), b: Int(bytes[index + 2]))
            if let found = darkest, found.luma <= pixel.luma { continue }
            darkest = pixel
        }
        return darkest
    }

    /// One screenshot, with the screen's frame and the scale that map screen points onto its pixels.
    private func screenCapture(_ app: XCUIApplication) -> (image: CGImage, screen: CGRect, scale: CGFloat)? {
        let shot = XCUIScreen.main.screenshot()
        let screen = app.windows.firstMatch.frame
        guard let image = shot.image.cgImage ?? UIImage(data: shot.pngRepresentation)?.cgImage, screen.width > 0 else { return nil }
        // The capture is at the screen's native scale (3 px a point on a current iPhone).
        return (image: image, screen: screen, scale: CGFloat(image.width) / screen.width)
    }

    /// The RGBA bytes of `pixels` (a rect of the capture's own pixels), row by row. Drawn into an
    /// sRGB context, so a wide-colour capture still reads as the sRGB values the palette is written in.
    private func sRGBBytes(_ image: CGImage, in pixels: CGRect) -> [UInt8]? {
        guard let part = image.cropping(to: pixels), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let width = part.width, height = part.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(part, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? bytes : nil
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
