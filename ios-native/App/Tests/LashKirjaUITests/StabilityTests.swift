import XCTest

/// Stability walk (2026-10-08): every long list grows and folds back with "Näytä enemmän", and the
/// screens added in October open and answer. Unlike the acceptance walks these ASSERT: a freeze
/// (the app not answering) or a crash fails the run. Needs the demo seed with `--ci` (long lists).
final class StabilityTests: WalkTestCase {
    /// The app answers a tap within a few seconds: a frozen main thread fails here.
    func assertResponsive(_ step: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.state, .runningForeground, "\(step): app is not running", file: file, line: line)
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10), "\(step): tab bar gone (frozen or crashed)", file: file, line: line)
        check(step, app.state == .runningForeground)
    }

    /// Taps "Näytä enemmän" until the list is fully open, then "Näytä vähemmän".
    func growAndFold(_ screen: String) {
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Näytä enemmän")).firstMatch
        var opened = 0
        for _ in 0..<4 {
            guard tapLabel("label BEGINSWITH %@", "Näytä enemmän") else { break }
            opened += 1
            sleep(1)
            assertResponsive("\(screen): Näytä enemmän #\(opened)")
            if !more.exists { break }
        }
        XCTAssertGreaterThan(opened, 0, "\(screen): no Näytä enemmän (long list missing from the seed?)")
        if tapLabel("label BEGINSWITH %@", "Näytä vähemmän") {
            sleep(1)
            assertResponsive("\(screen): Näytä vähemmän")
        }
        shot("stability-\(screen)")
    }

    func test01_ReceiptsGrowAndFold() {
        tab("Kirjanpito"); tap("Kuitit"); sleep(3)
        growAndFold("kuitit")
    }

    func test02_BankFeedGrowsAndFolds() {
        tab("Kirjanpito"); tap("Pankki"); sleep(3)
        tapLabel("label BEGINSWITH %@", "Näytä kaikki"); sleep(3)
        growAndFold("pankkitapahtumat")
    }

    func test03_BooksOpenInEveryView() {
        tab("Kirjanpito"); sleep(2)
        tapLabel("label BEGINSWITH %@", "Kirjanpito, Tuloslaskelma"); sleep(3)
        for part in ["Tase", "Saldot", "Päiväkirja", "Tulos"] {
            if app.buttons[part].waitForExistence(timeout: 10) { app.buttons[part].tap(); taps += 1 }
            sleep(1)
            assertResponsive("kirjanpito: \(part)")
        }
        XCTAssertFalse(app.staticTexts["Tase ei täsmää. Ilmoita tästä tukeen."].exists, "balance sheet does not balance")
        shot("stability-kirjanpito")
    }

    func test04_VatAndBankHubOpen() {
        tab("Kirjanpito"); tap("ALV-ilmoitus"); sleep(3)
        assertResponsive("alv")
        edgeSwipeBack(); sleep(1)
        tap("Pankki"); sleep(3)
        assertResponsive("pankki")
        shot("stability-pankki")
    }

    func test05_AddSheetOpensTheReceiptPageNotTheCamera() {
        tab("Lisää"); sleep(1)
        XCTAssertTrue(tap("Lisää kuitti"), "Lisää kuitti missing from the + sheet")
        sleep(2)
        XCTAssertTrue(app.navigationBars["Uusi kuitti"].waitForExistence(timeout: 10), "receipt page did not open")
        XCTAssertTrue(app.buttons["Valitse kuvista"].exists || app.staticTexts["Valitse kuvista"].exists, "picker buttons missing")
        shot("stability-lisaa-kuitti")
        tap("Peruuta"); sleep(1)
        assertResponsive("lisää kuitti closed")
    }

    func test06_ReportProblemSends() {
        openSettings()
        XCTAssertTrue(tap("Ilmoita ongelmasta"), "Ilmoita ongelmasta missing from settings")
        let field = app.textFields.firstMatch.exists ? app.textFields.firstMatch : app.textViews.firstMatch
        if field.waitForExistence(timeout: 10) { type(field, "Simulaattoritesti") }
        tap("Lähetä ilmoitus"); sleep(3)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ilmoitus tallennettu")).firstMatch.waitForExistence(timeout: 10),
                      "no confirmation code after sending")
        shot("stability-report")
    }

    /// Opens ALV and then reads nothing for 25 s: the app's own hang watchdog (event log) tells
    /// whether ALV blocks the main thread, without the test's accessibility queries in the way.
    func test07_AlvLeftAlone() {
        tab("Kirjanpito"); tap("ALV-ilmoitus")
        note("MARK alv-open \(Date().formatted(.iso8601))")
        sleep(25)
        note("MARK alv-end \(Date().formatted(.iso8601))")
        XCTAssertEqual(app.state, .runningForeground)
    }
}
