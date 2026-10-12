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

    /// Opens a Kirjanpito hub row ("Kuitit, 28 kuittia") and checks the screen really opened.
    func openHubRow(_ title: String) {
        tab("Kirjanpito")
        for _ in 0..<2 where !app.navigationBars[title].exists {
            tapLabel("label BEGINSWITH %@", title)
            _ = app.navigationBars[title].waitForExistence(timeout: 10)
        }
        XCTAssertTrue(app.navigationBars[title].exists, "\(title) did not open")
    }

    func test01_ReceiptsGrowAndFold() {
        openHubRow("Kuitit"); sleep(2)
        growAndFold("kuitit")
    }

    func test02_BankFeedGrowsAndFolds() {
        openHubRow("Pankki"); sleep(2)
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
        tab("Kirjanpito"); tap("ALV-ilmoitus"); sleep(5)
        // No element query on ALV: reading its accessibility tree outlasts XCTest's snapshot
        // timeout in a Debug build, while the app itself stays idle (sampled 2026-10-08,
        // test07). The swipe waits for the app to be idle, so a real freeze still fails here.
        XCTAssertEqual(app.state, .runningForeground, "alv: app is not running")
        edgeSwipeBack(); sleep(2)
        check("alv", app.state == .runningForeground)
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

    /// A receipt whose bank row has the same amount but another name lists that row and links it
    /// with one tap (seed: "ABC Prisma Kotka" / "KSO ABC Sahkonlataus", 9,43 €).
    func test08_SameAmountRowIsOfferedOnTheReceipt() {
        openHubRow("Kuitit"); sleep(2)
        XCTAssertTrue(tapLabel("label BEGINSWITH %@", "ABC Prisma Kotka"), "seeded receipt missing")
        sleep(3)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "KSO ABC Sahkonlataus")).firstMatch
        for _ in 0..<4 where !row.isHittable { app.swipeUp(velocity: .slow) }
        shot("stability-same-amount-candidate")
        XCTAssertTrue(row.exists, "the same-amount bank row is not offered")
        row.tap(); taps += 1
        let unlink = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Poista kohdistus")).firstMatch
        XCTAssertTrue(unlink.waitForExistence(timeout: 10), "tapping the row did not link it")
        shot("stability-same-amount-linked")
        assertResponsive("receipt linked")
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
