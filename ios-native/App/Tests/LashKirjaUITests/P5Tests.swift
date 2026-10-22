import XCTest
import UIKit

/// P5: the five riskiest screens at the largest accessibility text size. Each screenshot is taken
/// once its target is in the window (U074); the hard checks hold what B5 gave these screens at that
/// size: stacked rows, amounts and badges on one line, the figures whole.
final class P5Tests: WalkTestCase {
    override func tearDown() { contentSize("large"); super.tearDown() }

    func testA_LargestTextSize() {
        contentSize("accessibility-extra-extra-extra-large")
        app.terminate(); app.launch(); _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        let window = app.windows.firstMatch
        let tabs = app.tabBars.firstMatch

        // Koti (U064): the ring's figure whole, the words under the ring.
        let figure = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]{1,3} %")).firstMatch
        if aim(figure, "p5-koti-top", above: tabs) {
            // A figure of n characters is at least 0.4 n of its height wide: 1.6 for '27 %'. Cut to
            // '2…' it was about as wide as it was tall.
            let least = 0.4 * CGFloat(figure.label.count) * figure.frame.height
            XCTAssertGreaterThanOrEqual(figure.frame.width, least, "the ring's '\(figure.label)' is cut: \(figure.frame)")
            let card = app.buttons.containing(NSPredicate(format: "label == %@", figure.label)).firstMatch
            let words = card.exists ? card.staticTexts.allElementsBoundByIndex.filter { $0.label != figure.label && !$0.label.isEmpty } : []
            if let headline = words.first {
                note("INFO p5-koti-geometry: figure \(figure.frame), headline \(headline.frame)")
                XCTAssertGreaterThanOrEqual(headline.frame.minY, figure.frame.maxY - 1,
                                            "the headline \(headline.frame) is beside the ring's figure \(figure.frame), not under it")
            } else {
                dump(app, "p5-koti-card"); XCTFail("the month card shows no headline with its '\(figure.label)'")
            }
        }
        _ = aim(app.staticTexts["Tarvitaan sinulta"].firstMatch, "p5-koti-tasks", lift: true, above: tabs)
        check("P5 Koti shows money at AX5", app.staticTexts.matching(NSPredicate(format: "label CONTAINS '€'")).count > 0)

        // Myynti (U065 U066 U067 U068): the card's parts stacked, every amount on one line.
        tab("Myynti")
        let total = app.staticTexts["receivables-total"].firstMatch
        if aim(total, "p5-myynti", above: tabs) {
            XCTAssertLessThanOrEqual(total.frame.height, lineHeight(.title2) * 1.3, "the receivables total wraps: \(total.frame)")
            // A legend part is a button holding its words, then its amount. The bar above it has
            // buttons with the same words and sum in their labels but no text inside, and the status
            // chips hold no '€': only the legend holds an amount text. `containing` also matches the
            // button itself, so the amount must be a text: on the label alone it took the bar's
            // 10 pt segments for the legend.
            let amountText = NSPredicate(format: "elementType == %@ AND label CONTAINS %@",
                                         argumentArray: [XCUIElement.ElementType.staticText.rawValue, "€"])
            let legend = ["Maksettu", "Odottaa maksua", "Myöhässä"]
                .map { app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", $0)).containing(amountText).firstMatch }
                .filter { $0.exists }
            XCTAssertGreaterThanOrEqual(legend.count, 2, "the receivables legend shows \(legend.count) parts")
            for (upper, lower) in zip(legend, legend.dropFirst()) {
                XCTAssertGreaterThanOrEqual(lower.frame.minY, upper.frame.maxY - 1,
                                            "the legend's '\(lower.label)' \(lower.frame) is beside '\(upper.label)' \(upper.frame), not under it")
            }
            for part in legend {
                let amount = part.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "€")).firstMatch
                guard amount.exists else { XCTFail("the legend's '\(part.label)' shows no amount"); continue }
                XCTAssertLessThanOrEqual(amount.frame.height, lineHeight(.caption1) * 1.3, "the legend's amount wraps: \(part.label) \(amount.frame)")
            }
        }
        let customers = app.buttons["Asiakkaat"].firstMatch
        let recurring = app.buttons["Toistuvat laskut"].firstMatch
        if aim(customers, "p5-myynti-tiles", above: tabs) {
            if recurring.exists {
                XCTAssertGreaterThanOrEqual(recurring.frame.minY, customers.frame.maxY - 1,
                                            "the tiles are side by side: Asiakkaat \(customers.frame), Toistuvat laskut \(recurring.frame)")
            } else {
                XCTFail("Myynti shows no Toistuvat laskut tile")
            }
        }
        let rows = app.buttons.matching(NSPredicate(format: "label MATCHES %@", ".*(Lasku|Hyvityslasku) [0-9]+.*€.*"))
        if aim(rows.firstMatch, "p5-myynti-rows", lift: true, above: tabs) {
            var measured = 0
            for row in rows.allElementsBoundByIndex.prefix(3) where row.exists && window.frame.contains(row.frame) {
                let texts = row.staticTexts.allElementsBoundByIndex
                guard let name = texts.first(where: { !$0.label.isEmpty && row.label.hasPrefix($0.label) }),
                      let amount = texts.first(where: { $0.label.contains("€") }) else {
                    XCTFail("the row '\(row.label)' shows no name or no amount"); continue
                }
                measured += 1
                XCTAssertLessThanOrEqual(amount.frame.height, lineHeight(.subheadline) * 1.3, "the amount of '\(name.label)' wraps: \(amount.frame)")
                XCTAssertGreaterThanOrEqual(amount.frame.minY, name.frame.maxY - 1,
                                            "the amount \(amount.frame) is beside '\(name.label)' \(name.frame), not under it")
            }
            XCTAssertGreaterThan(measured, 0, "no invoice row lies whole in the window")
        }

        // Sähköposti (G004, M073): an empty state in a list row takes the lines its title needs. The
        // demo seed connects no mailbox, so Sähköposti shows one. The node is the icon over the
        // title (90 pt cut to one line, 121 pt whole at the default size, OwnerScreensTests testD).
        // At this size the whole title is three lines or more; four title2 lines is the bound the
        // icon over three reaches and the icon over one does not. The INFO line keeps the frame.
        tab("Kirjanpito")
        if tapLabel("label BEGINSWITH %@", "Sähköposti", scrolls: 10) {
            let title = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", "Sähköpostia ei ole yhdistetty")).firstMatch
            if title.waitForExistence(timeout: 15) {
                waitStill(title)
                note("INFO p5-empty-state-geometry: title \(title.frame), one title2 line \(lineHeight(.title2))")
                XCTAssertGreaterThanOrEqual(title.frame.height, 4 * lineHeight(.title2),
                                            "the empty-state title is cut to one line: \(title.frame)")
                shot("p5-empty-state")
            } else {
                dump(app, "p5-empty-state-miss"); XCTFail("Sähköposti shows no 'Sähköpostia ei ole yhdistetty': has the demo user a mailbox?")
            }
        } else {
            XCTFail("Sähköposti did not open from Kirjanpito")
        }

        tab("Koti")
        // At AX5 one card fills the screen: the overdue row can be far down Koti. Koti shows five
        // tasks; in a full run the earlier tests add tasks, and the overdue one moves behind
        // "Näytä enemmän". That button is looked for first: 20 swipes for the row alone went past it,
        // and it was then above the window (F005, run 39682519839).
        var opened = openOverdueFromKoti(scrolls: 20)
        XCTAssertTrue(opened, "Koti did not open the overdue invoice")
        if !opened {
            // The invoice itself is what the rest checks, so a Koti that missed is failed above and
            // the overdue row is opened from Myynti instead, by the status its label ends with.
            // 'Myöhäs' matched the receivables bar's 10 pt segment, left under the navigation bar by
            // the scrolled list: the bar took the tap, the list stayed on Kaikki, and the next
            // 'Lasku ' row was the paid Lasku 1 (run 39538176287).
            shot("p5-koti-miss"); dump(app, "p5-koti-miss")
            tab("Myynti"); sleep(3)
            opened = tapLabel("label CONTAINS 'Lasku ' AND label ENDSWITH %@", ", Myöhässä", scrolls: 10)
        }
        // Lasku 2 (U069 U070): the late tag on one line, the facts stacked, the reference as wide as the card.
        let tag = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Myöhässä '")).firstMatch
        XCTAssertTrue(opened, "no overdue invoice opened, from Koti or from Myynti")
        if opened, aim(tag, "p5-invoice-detail", above: tabs) {
            XCTAssertLessThanOrEqual(tag.frame.height, lineHeight(.caption2) * 1.3, "the status tag '\(tag.label)' wraps: \(tag.frame)")
            let issued = app.staticTexts["Laskun päivä"].firstMatch
            let due = app.staticTexts["Eräpäivä"].firstMatch
            let reference = app.staticTexts["Viite"].firstMatch
            let copy = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kopioi viitenumero")).firstMatch
            if issued.exists && due.exists && reference.exists && copy.exists {
                note("INFO p5-invoice-geometry: Laskun päivä \(issued.frame), Eräpäivä \(due.frame), Viite \(reference.frame), copy \(copy.frame)")
                XCTAssertGreaterThanOrEqual(due.frame.minY, issued.frame.maxY - 1, "Eräpäivä is beside Laskun päivä, not under it")
                XCTAssertGreaterThanOrEqual(reference.frame.minY, due.frame.maxY - 1, "Viite is beside Eräpäivä, not under it")
                // The card is the window less the list's 16 pt margins.
                let card = window.frame.width - 32
                XCTAssertGreaterThanOrEqual(copy.frame.width, card * 0.6, "'\(copy.label)' is \(copy.frame.width) pt of the card's \(card)")
                _ = aim(copy, "p5-invoice-facts", above: tabs)
            } else {
                dump(app, "p5-invoice-facts-miss"); XCTFail("the card shows no Laskun päivä, Eräpäivä, Viite or its copy button")
            }
        }
        check("P5 invoice detail opens at AX5", tag.exists)

        // Uusi lasku (U071): a full-width primary under Yhteensä alone, and the form keeps the screen.
        tab("Myynti"); _ = tap("Uusi lasku")
        let create = app.buttons["Luo lasku"].firstMatch
        let totals = app.descendants(matching: .any).matching(identifier: "invoice-form-total").firstMatch
        if aim(create, "p5-invoice-form", above: nil) {
            XCTAssertGreaterThanOrEqual(create.frame.width, window.frame.width - 33,
                                        "Luo lasku is \(create.frame.width) pt in a \(window.frame.width) pt window")
            if totals.exists {
                // From the bar's top (10 pt over its totals) to the bottom of the screen.
                let bar = window.frame.maxY - (totals.frame.minY - 10)
                XCTAssertLessThanOrEqual(bar, window.frame.height * 0.3, "the bar takes \(bar) pt of the \(window.frame.height) pt window")
            } else {
                XCTFail("the bar shows no Yhteensä")
            }
        }
        _ = aim(app.staticTexts["Rivi 1"].firstMatch, "p5-invoice-lines", lift: true, above: totals)
        check("P5 invoice form opens at AX5", app.navigationBars["Uusi lasku"].exists)
    }

    /// Scrolls (bounded, each swipe counted) until `target` lies whole in the window and over `above`
    /// (the tab bar, or the form's bar); with `lift`, then raises it to the top of the window with one
    /// held drag, so the shot shows what follows it. Asserts it is there, then shoots `name`.
    private func aim(_ target: XCUIElement, _ name: String, lift: Bool = false, above: XCUIElement?,
                     file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let window = app.windows.firstMatch
        func inPlace() -> Bool {
            guard target.exists else { return false }
            let frame = target.frame
            guard frame.minY > window.frame.minY + 30, frame.maxY <= window.frame.maxY else { return false }
            guard let above, above.exists else { return true }
            return frame.maxY <= above.frame.minY
        }
        // The screen is still loading, or its sheet still rising.
        if target.waitForExistence(timeout: 20) { waitStill(target) }
        var swipes = 0
        while !inPlace() && swipes < 12 {
            window.swipeUp(velocity: .slow); scrolls += 1; swipes += 1
        }
        let top = window.frame.minY + window.frame.height * 0.18
        if lift, inPlace(), target.frame.minY > top + 40 {
            let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: top - target.frame.minY)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        if target.exists { waitStill(target) }
        let placed = inPlace()
        note("INFO \(name): target \(target.exists ? "\(target.frame)" : "missing"), window \(window.frame), in place \(placed)")
        XCTAssertTrue(placed, "\(name): its target is not in the window after \(swipes) swipes", file: file, line: line)
        if !placed { dump(app, "\(name)-miss") }
        shot(name)
        return placed
    }

    /// One line of `style` at the size this test sets.
    private func lineHeight(_ style: UIFont.TextStyle) -> CGFloat {
        UIFont.preferredFont(forTextStyle: style,
                             compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)).lineHeight
    }
}
