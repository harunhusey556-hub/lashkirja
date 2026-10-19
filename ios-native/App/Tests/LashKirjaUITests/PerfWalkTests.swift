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
            if openRow(label) { sleep(3); back() }
        }
        // The rows above were found by scrolling down: back to the top, where the Pankki row is.
        // Its title exactly: "Pankki" as a prefix also matched the subtitles further down
        // ("Pankkitapahtumat, joille puuttuu kuitti"), which open Kohdista kuitit instead.
        app.windows.firstMatch.swipeDown(velocity: .fast)
        if openRow("Pankki", exact: true) {
            sleep(2)
            // Pankki opens on its rows (N2); its first row, Saldo yhteensä, opens Pankkiyhteys ja
            // tilit with a bank connection or without one.
            if openRow("Saldo yhteensä") { sleep(3); back() }
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

    /// Taps the on-screen row whose label starts with `prefix` (is `prefix`, when `exact`), scrolling down for it.
    private func openRow(_ prefix: String, exact: Bool = false) -> Bool {
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: exact ? "label == %@" : "label BEGINSWITH %@", prefix))
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

    /// The pushed screen's back button. Not the bar's first button: at a tab's root that is the
    /// Avustaja toolbar button, which opened the assistant over the rest of the walk (PR #16's
    /// MISS Asetukset / Pankkiyhteys ja tilit, and its "open chat" figures came from there).
    private func back() {
        let buttons = app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex
        if let button = buttons.first(where: { $0.isHittable }) { button.tap() } else { edgeSwipeBack() }
        sleep(1)
    }
}
