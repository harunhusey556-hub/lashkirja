import XCTest

/// The timing walk (w35): fresh launches, then every tab and the measured screens once per round.
/// The figures are the app's own log lines (`perf <kind> <row> <ms>`, subsystem
/// `fi.lashkirja.perf`), read on the host with `log show`; this test only drives the screens and
/// leaves each one open long enough for its data. Not part of CI: it needs the demo server.
final class PerfWalkTests: WalkTestCase {
    func testPerfWalk() {
        // Round 0 is the warm-up (first launch after install, cold server): not a figure.
        for round in 0...3 {
            // When the round starts: perf-walk.sh files the app's log lines under it.
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
        if tap("Uusi lasku") {
            sleep(3)
            app.buttons["Peruuta"].firstMatch.tap()
            sleep(1)
        }
        tab("Kirjanpito")
        for label in ["Kuitit", "Kohdista kuitit", "Kuukauden sulku", "ALV-ilmoitus"] {
            if tapLabel("label BEGINSWITH %@", label) { sleep(3); back() }
        }
        if tapLabel("label BEGINSWITH %@", "Pankki") {
            sleep(2)
            if tapLabel("label BEGINSWITH %@", "Pankkiyhteys ja tilit") { sleep(3); back() }
            back()
        }
        for sheet in ["Asetukset", "Avustaja"] {
            app.buttons[sheet].firstMatch.tap()
            sleep(3)
            app.buttons["Valmis"].firstMatch.tap()
            sleep(1)
        }
        tab("Koti")
    }

    private func back() {
        app.navigationBars.firstMatch.buttons.element(boundBy: 0).tap()
        sleep(1)
    }
}
