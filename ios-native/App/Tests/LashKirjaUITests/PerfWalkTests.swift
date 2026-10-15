import XCTest

/// The timing walk (w35): fresh launches, then every tab and the measured screens once per round.
/// The figures are the app's own log lines (`perf <kind> <row> <ms>`, subsystem
/// `fi.lashkirja.perf`), read on the host with `log show`; this test only drives the screens and
/// leaves each one open long enough for its data. Not part of CI: it needs the demo server.
/// Every tap is guarded: a screen missing on one account is a MISS note, not the end of the walk.
final class PerfWalkTests: WalkTestCase {
    func testPerfWalk() {
        // Round 0 is the warm-up (first launch after install, cold server): not a figure.
        for round in 0...3 {
            // When the round starts: perf-medians.py files the app's log lines under it.
            note("ROUND \(round) \(Date().timeIntervalSince1970)")
            app.terminate()
            app.launch()
            _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
            // As an owner would: a moment on Koti before the first tap.
            sleep(3)
            walk()
        }
    }

    private func walk() {
        for name in ["Myynti", "Kirjanpito", "Raportit", "Koti"] { tab(name) }
        tab("Myynti")
        if press("Uusi lasku") {
            sleep(3)
            press("Peruuta")
            sleep(1)
        }
        tab("Kirjanpito")
        for label in ["Kuitit", "Kohdista kuitit", "Kuukauden sulku", "ALV-ilmoitus"] {
            if open(label) { sleep(3); back() }
        }
        if open("Pankki") {
            sleep(2)
            // Without a bank connection the hub offers "Yhdistä pankki" instead of its links.
            if press("Yhdistä pankki") || open("Pankkiyhteys ja tilit") { sleep(3); back() }
            back()
        }
        // The sheets open from a tab's root, where the toolbar is.
        tab("Koti")
        for sheet in ["Asetukset", "Avustaja"] where press(sheet) {
            sleep(3)
            press("Valmis")
            sleep(1)
        }
    }

    /// Taps the on-screen button (every tab's toolbar is in the tree; only the shown one is
    /// hittable); a MISS note when none shows up within a few seconds.
    @discardableResult
    private func press(_ label: String) -> Bool {
        _ = app.buttons[label].firstMatch.waitForExistence(timeout: 4)
        guard let button = app.buttons.matching(identifier: label).allElementsBoundByIndex.first(where: { $0.isHittable }) else {
            note("MISS \(label)")
            return false
        }
        button.tap()
        taps += 1
        return true
    }

    /// Taps the on-screen row whose label starts with `prefix`, scrolling down for it.
    private func open(_ prefix: String) -> Bool {
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
        _ = rows.firstMatch.waitForExistence(timeout: 8)
        for _ in 0...6 {
            if let row = rows.allElementsBoundByIndex.first(where: { $0.isHittable && $0.frame.minY > 30 }) {
                row.tap()
                taps += 1
                return true
            }
            app.windows.firstMatch.swipeUp(velocity: .slow)
        }
        note("MISS \(prefix)")
        return false
    }

    private func back() {
        let button = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        if button.exists { button.tap() } else { edgeSwipeBack() }
        sleep(1)
    }
}
