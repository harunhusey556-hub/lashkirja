import XCTest

extension WalkTestCase {
    /// B11 (U016 U031 U053 X132 X147): a horizontal chip row reaches the screen's edges and starts its
    /// first chip 16 pt in, where the cards start. Inside the margin a list gives each section (or the
    /// assistant's conversation padding), the row was cut mid-word at the card's edge: Kuitit's
    /// ScrollView ran x 16..386. Read at the row's first scroll position.
    @discardableResult
    func assertChipRowEdge(_ identifier: String, _ screen: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let row = app.scrollViews.matching(identifier: identifier).firstMatch
        guard row.waitForExistence(timeout: 15) else {
            dump(app, "chip-row-\(identifier)")
            XCTFail("\(screen): no chip row '\(identifier)'", file: file, line: line); return false
        }
        // A sheet still rising or a pushed screen still sliding in moves the row.
        waitStill(row)
        let first = row.buttons.element(boundBy: 0)
        guard first.waitForExistence(timeout: 5) else {
            dump(app, "chip-row-\(identifier)")
            XCTFail("\(screen): the chip row '\(identifier)' has no chip", file: file, line: line); return false
        }
        let window = app.windows.firstMatch.frame
        let frame = row.frame, chip = first.frame
        note("INFO \(screen): chip row \(frame), first chip \(chip), window \(window)")
        XCTAssertLessThanOrEqual(frame.minX, window.minX, "\(screen): the chip row starts at x \(frame.minX), inside the screen's edge",
                                 file: file, line: line)
        XCTAssertEqual(frame.maxX, window.maxX, accuracy: 0.5, "\(screen): the chip row ends at x \(frame.maxX), not at the screen's edge \(window.maxX)",
                       file: file, line: line)
        XCTAssertEqual(chip.minX, window.minX + 16, accuracy: 0.5, "\(screen): the first chip starts at x \(chip.minX), not 16 pt in",
                       file: file, line: line)
        let held = frame.minX <= window.minX && abs(frame.maxX - window.maxX) <= 0.5 && abs(chip.minX - (window.minX + 16)) <= 0.5
        check("\(screen): the chip row reaches the screen's edges, its first chip 16 pt in", held, file: file, line: line)
        return held
    }

    /// Swipes the chip row `identifier` until `chip` is wholly on the screen. Judged by the chip's
    /// frame, not `isHittable`: of a chip wholly past the screen's edge XCTest finds no point to hit
    /// and fails the test instead of answering false (run 39334173559: Kuitit's 'Ei kohdistettu' at
    /// x 423..570 in the 402 pt window, "Activation point invalid and no suggested hit points").
    @discardableResult
    func revealChip(_ chip: XCUIElement, inRow identifier: String) -> Bool {
        let row = app.scrollViews.matching(identifier: identifier).firstMatch
        let window = app.windows.firstMatch.frame
        func shown() -> Bool {
            let frame = chip.frame
            return frame.minX >= window.minX && frame.maxX <= window.maxX
        }
        for _ in 0..<3 where !shown() {
            if chip.frame.maxX > window.maxX { row.swipeLeft() } else { row.swipeRight() }
            // The row coasts on after the finger lifts.
            waitStill(chip)
        }
        return shown()
    }
}
