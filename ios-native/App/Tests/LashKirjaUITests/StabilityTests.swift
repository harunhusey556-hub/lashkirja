import XCTest
import UIKit

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

    /// The list's "Näytä enemmän (N)" / "Näytä vähemmän" row, scrolled into view. A tap moves it below
    /// the screen and a List keeps off-screen rows out of the tree, so `exists` right after a tap is
    /// false while the list is still growing (CI 2026-10-15: both lists stopped after one tap).
    func toggleRow(up: Bool = false) -> XCUIElement? {
        let q = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label == %@", "Näytä enemmän", "Näytä vähemmän"))
        let w = app.windows.firstMatch
        // A page being fetched reads "Ladataan…" for a moment.
        _ = q.firstMatch.waitForExistence(timeout: 3)
        for down in [!up, up] {
            for _ in 0...12 {
                let e = q.firstMatch
                if e.exists && e.frame.minY > 30 && e.frame.maxY < w.frame.maxY - 60 { return e }
                if down { w.swipeUp(velocity: .slow) } else { w.swipeDown(velocity: .slow) }
                scrolls += 1
            }
        }
        return nil
    }

    /// Rows behind "Näytä enemmän (N)" (0 when the title has no count); nil once the row folds.
    func hiddenRows(_ row: XCUIElement) -> Int? {
        row.label.hasPrefix("Näytä enemmän") ? Int(row.label.filter(\.isNumber)) ?? 0 : nil
    }

    /// Taps "Näytä enemmän" until the list is fully open, then "Näytä vähemmän".
    func growAndFold(_ screen: String) {
        var opened = 0
        var hiddenAtStart = 0
        // Bounded: the seed's longest list opens in three or four taps.
        for _ in 0..<8 {
            guard let row = toggleRow(), let hidden = hiddenRows(row) else { break }
            if opened == 0 { hiddenAtStart = hidden }
            row.tap(); taps += 1
            opened += 1
            sleep(1)
            assertResponsive("\(screen): Näytä enemmän #\(opened)")
        }
        XCTAssertGreaterThan(opened, 0, "\(screen): no Näytä enemmän (long list missing from the seed?)")
        if tapLabel("label BEGINSWITH %@", "Näytä vähemmän") {
            sleep(1)
            assertResponsive("\(screen): Näytä vähemmän")
            // Folded back to the first rows: the rest hide again behind "Näytä enemmän (N)".
            let folded = toggleRow(up: true).flatMap(hiddenRows)
            check("\(screen): folded back to the first rows", (folded ?? 0) > 0)
            XCTAssertNotNil(folded, "\(screen): no Näytä enemmän after folding")
            XCTAssertGreaterThan(folded ?? 0, 0, "\(screen): folding hid no rows")
            XCTAssertGreaterThanOrEqual(folded ?? 0, hiddenAtStart, "\(screen): fold left more rows open than at the start")
        } else {
            XCTFail("\(screen): list did not open fully to Näytä vähemmän in \(opened) taps")
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

    /// N2: Pankki opens on the rows themselves; the hub's "Näytä kaikki" is gone.
    func test02_BankFeedGrowsAndFolds() {
        openHubRow("Pankki"); sleep(2)
        let all = app.segmentedControls.firstMatch.buttons["Kaikki"]
        XCTAssertTrue(all.waitForExistence(timeout: 10) && all.isSelected, "Pankki did not open on Kaikki")
        let row = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.bankRow)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Pankki shows no bank row")
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
        // U079: the books are on the warm canvas, as Pankki is (test04), not the system grey.
        if app.buttons["Tulos"].exists {
            assertWarmCanvas(app, under: app.navigationBars["Kirjanpito"], "kirjanpito")
        } else { XCTFail("kirjanpito: the books did not open") }
        shot("stability-kirjanpito")
    }

    func test04_VatAndBankHubOpen() {
        tab("Kirjanpito"); tap("ALV-ilmoitus"); sleep(5)
        // No element query on ALV: reading its accessibility tree outlasts XCTest's snapshot
        // timeout in a Debug build, while the app itself stays idle (sampled 2026-10-08,
        // test07). The swipe waits for the app to be idle, so a real freeze still fails here.
        XCTAssertEqual(app.state, .runningForeground, "alv: app is not running")
        edgeSwipeBack()
        check("alv", app.state == .runningForeground)
        // The swipe is not taken on trust: in 3 of 9 suite runs it left ALV up (runs 38779539454,
        // 38895961757, 38993875695), "Pankki" was then looked for on ALV and the step passed
        // without Pankki ever opening. Its row shows once the pop has finished.
        let hubRow = app.staticTexts["Pankki"].firstMatch
        let popped = hubRow.waitForExistence(timeout: 10)
        if !popped {
            shot("stability-alv-swipe-back-stayed")
            if let back = app.navigationBars["ALV-ilmoitus"].buttons.allElementsBoundByIndex.first(where: { $0.isHittable }) { back.tap() }
        }
        check("alv: edge swipe back returned to Kirjanpito", popped)
        // The pop returns to the offset tapLabel scrolled to for ALV: the Pankki row then sits under
        // the navigation bar (y 59–80 under a bar ending at 116, run 39012905317), passes tapLabel's
        // 30 pt margin, and the tap lands on the bar. Back to the top first, so the row is clear of it.
        let bar = app.navigationBars["Kirjanpito"].firstMatch
        for _ in 0..<4 where hubRow.exists && bar.exists && hubRow.frame.minY < bar.frame.maxY {
            app.windows.firstMatch.swipeDown(velocity: .slow)
        }
        tap("Pankki")
        XCTAssertTrue(app.navigationBars["Pankki"].waitForExistence(timeout: 10), "Pankki did not open")
        // The rows' screen (N2), not a screen that is only named Pankki: the hub was one too.
        XCTAssertTrue(app.navigationBars["Pankki"].buttons["Toiminnot"].waitForExistence(timeout: 10), "Pankki opened without its rows' Toiminnot")
        assertResponsive("pankki")
        // The control for the canvas reads in test03 and test06: Pankki has had the canvas pair all along.
        assertWarmCanvas(app, under: app.navigationBars["Pankki"], "pankki")
        shot("stability-pankki")
    }

    func test05_AddSheetOpensTheReceiptPageNotTheCamera() {
        tab("Lisää"); sleep(1)
        XCTAssertTrue(tap("Lisää tiedosto"), "Lisää tiedosto missing from the + sheet")
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
        // U079: read before the keyboard rises over the form.
        assertWarmCanvas(app, under: app.navigationBars["Ilmoita ongelmasta"], "ilmoita ongelmasta")
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

    /// A stored token the server no longer accepts, as the motion gate's pr-run1 restored from the
    /// walk before it (CI 2026-10-15): the app paints the tabs, drops to the sign-in screen once the
    /// server refuses the token, and a fresh launch signs in from there instead of losing the walk.
    func test09_RefusedStoredSessionSignsInAgain() {
        app.terminate()
        XCTAssertTrue(revokeAppSessions(), "could not revoke the app's session on the demo API")
        let started = Date()
        XCTAssertTrue(launchSignedIn(), "the refused session never reached the sign-in screen")
        note("MARK refused-session launch to tabs \(Int(Date().timeIntervalSince(started))) s")
        XCTAssertTrue(app.tabBars.firstMatch.exists, "no tab bar after signing in again")
        XCTAssertTrue(launchPhase(["signedIn"]).waitForExistence(timeout: 10), "the new session was not accepted")
    }

    /// A revoked stored session reaches the sign-in screen within 1 s of the app's FIRST FRAME (w67,
    /// row 27, as the owner accepted: the trusted session paints the cached Koti at once and the
    /// screens' own loads verify it). Three launches, each from a painted Koti whose session was then
    /// revoked on the demo API. Asserted on the app's own clock (the marker's label: when each phase
    /// was first built, ms after the process started); process start → sign-in screen (w49's figure)
    /// and XCUITest's `launch()` → password field are noted, not asserted.
    func test10_RevokedSessionReachesSignInFast() {
        var fromFrame: [Int] = []
        for round in 1...3 {
            // Koti painted and kept on disk: the launch below paints from the cache, as on the phone.
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "round \(round): no tab bar before the revoke")
            sleep(2)
            app.terminate()
            XCTAssertTrue(revokeAppSessions(), "round \(round): could not revoke the app's session on the demo API")
            let started = Date()
            app.launch()
            let launched = Int(Date().timeIntervalSince(started) * 1000)
            XCTAssertTrue(app.secureTextFields.firstMatch.waitForExistence(timeout: 30), "round \(round): no sign-in screen")
            let wall = Int(Date().timeIntervalSince(started) * 1000)
            let moments = launchMoments(["signedOut"])
            let frame = Self.firstFrame(moments)
            let signedOut = moments["signedOut"].flatMap { $0 >= 0 ? $0 : nil }
            let ms = signedOut.flatMap { out in frame.map { out - $0 } }
            if let ms { fromFrame.append(ms) }
            note("MARK revoked-session round \(round): first frame → sign-in \(ms.map(String.init) ?? "?") ms; process start → sign-in \(signedOut.map(String.init) ?? "?") ms (\(Self.timeline(moments))), launch() returned \(launched) ms, → password field \(wall) ms")
            // A calm way out: no load failure or offline notice on the way to the sign-in screen.
            let failure = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Lataus epäonnistui", "Palvelimeen ei saada yhteyttä", "Istunto on päättynyt"])).firstMatch
            XCTAssertFalse(failure.exists, "round \(round): an error showed on the way out: \(failure.label)")
            signIn(app)
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "round \(round): no tab bar after signing in again")
            probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) }
            sleep(1); dismissSystemPrompts()
        }
        let sorted = fromFrame.sorted()
        note("MARK revoked-session first frame → sign-in ms \(fromFrame) median \(sorted.isEmpty ? -1 : sorted[sorted.count / 2])")
        XCTAssertEqual(fromFrame.count, 3, "the launch marker did not say when the first frame and the sign-in screen came")
        if !sorted.isEmpty { XCTAssertLessThanOrEqual(sorted[sorted.count / 2], 1000, "revoked session: first frame → sign-in screen \(fromFrame) ms") }
    }

    /// A valid stored session: launch → Koti's figures (Perf's `launch koti`, on the marker's clock)
    /// and what the first frame was. Three launches from a painted Koti; noted for the before/after
    /// table (ios-session-gate.yml), not asserted.
    func test11_ValidSessionOpensOnKoti() {
        var toKoti: [Int] = []
        for round in 1...3 {
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 30), "round \(round): no tab bar before the relaunch")
            sleep(2)
            app.terminate()
            app.launch()
            let moments = launchMoments(["restored", "signedIn"], waitingFor: "koti")
            let koti = moments["koti"].flatMap { $0 >= 0 ? $0 : nil }
            if let koti { toKoti.append(koti) }
            let firstPhase = moments.filter { ["launching", "tabs", "signedOut"].contains($0.key) }.min { $0.value < $1.value }?.key ?? "?"
            note("MARK valid-session round \(round): launch → Koti \(koti.map(String.init) ?? "?") ms, first frame \(Self.firstFrame(moments).map(String.init) ?? "?") ms (\(firstPhase)) (\(Self.timeline(moments)))")
            XCTAssertFalse(app.secureTextFields.firstMatch.exists, "round \(round): a valid session went to the sign-in screen")
        }
        let sorted = toKoti.sorted()
        note("MARK valid-session launch → Koti ms \(toKoti) median \(sorted.isEmpty ? -1 : sorted[sorted.count / 2])")
    }

    /// U014, X096, X097 (N2): Pankki's bar shows its title and one item, Toiminnot, from the push
    /// on, by either way in. Four items crowded the title out, and Valitse came with the rows.
    /// Toiminnot holds Valitse, Kuukausi and Tiliotteet but not "Hyväksy kuittiehdotukset" (the
    /// Kuittien kohdistus card's button), and its Kuukausi moves the chips: one month control.
    func test12_BankBarIsStable() {
        for entry in ["Pankki", "Kohdista kuitit"] {
            guard selectTab("Kirjanpito"), app.navigationBars["Kirjanpito"].waitForExistence(timeout: 10) else {
                XCTFail("\(entry): Kirjanpito is not on top"); return
            }
            XCTAssertTrue(tap(entry), "\(entry): no such row on Kirjanpito")
            let bar = app.navigationBars["Pankki"]
            guard bar.waitForExistence(timeout: 10) else {
                dump(app, "stability-12-not-pankki"); XCTFail("\(entry) did not open Pankki"); continue
            }
            assertBankBar(bar, "\(entry), at push")
            let row = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.bankRow)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 15), "\(entry): no bank row arrived")
            assertBankBar(bar, "\(entry), with rows")
            checkBankActions(bar, entry)
            shot("stability-pankki-bar-\(entry)")
            bar.buttons["BackButton"].firstMatch.tap(); taps += 1
        }
    }

    /// X002 X022 X160 X161 (B3): at the default text size on a 402 pt phone, each confirm sheet's
    /// inline title reads whole between Peruuta and the confirm button. Long confirm labels cut the
    /// titles ('Lähetä maksumuis…', 'Hyvitä la…', 'Hyvitä os…') or pushed one out of the bar ('Kirjaa
    /// maksu' beside 'Merkitse maksetuksi'), and the credit amount's label lost its '(€)'. Text the
    /// audit finds cut on the screen under a sheet is that screen's and is not counted.
    func test17_SheetTitlesFit() {
        // From Myynti, not Koti: Koti's tasks can put the overdue invoice behind "Näytä enemmän".
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        let invoice = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        guard tapLabel("label CONTAINS %@", "· myöhässä"), invoice.waitForExistence(timeout: 20) else {
            dump(app, "stability-17-no-invoice"); XCTFail("no overdue invoice opened from Myynti"); return
        }
        var under = clippedTexts()
        // The primary while a reminder may go, a Toiminnot item while it waits for its date.
        if let remind = hittable(app.buttons.matching(NSPredicate(format: "label == %@", "Lähetä maksumuistutus")), timeout: 15) {
            remind.tap(); taps += 1
            assertSheetFits("Maksumuistutus", beyond: under)
        } else if pickFromMenu(invoice, "Lähetä maksumuistutus") {
            assertSheetFits("Maksumuistutus", beyond: under)
        } else {
            XCTFail("the overdue invoice offers no Lähetä maksumuistutus")
        }
        if pickFromMenu(invoice, "Hyvitä") { assertSheetFits("Hyvitä laskua", beyond: under) } else { XCTFail("Toiminnot has no Hyvitä") }

        openHubRow("Ostolaskut")
        let purchase = app.navigationBars["Ripsitukku Oy"]
        guard tapLabel("label CONTAINS %@", "Ripsitukku Oy"), purchase.waitForExistence(timeout: 20) else {
            dump(app, "stability-17-no-purchase"); XCTFail("the seed's Ripsitukku Oy ostolasku did not open"); return
        }
        under = clippedTexts()
        if pickFromMenu(purchase, "Hyvitä") { assertSheetFits("Hyvitä ostolasku", beyond: under) } else { XCTFail("Ripsitukku Oy: Toiminnot has no Hyvitä") }
        if pickFromMenu(purchase, "Kirjaa maksu") { assertSheetFits("Kirjaa maksu", beyond: under) } else { XCTFail("Ripsitukku Oy: Toiminnot has no Kirjaa maksu") }
    }

    /// The sheet titled `title` has risen: its bar shows the whole title, and the textClipped audit finds no
    /// text cut beyond `under` (the screen beneath, read before the sheet opened). Closed with Peruuta.
    private func assertSheetFits(_ title: String, beyond under: [String], file: StaticString = #filePath, line: UInt = #line) {
        let bar = app.navigationBars[title]
        guard bar.waitForExistence(timeout: 10) else {
            dump(app, "stability-17-no-sheet"); XCTFail("\(title) did not open", file: file, line: line); return
        }
        waitStill(bar)
        shot("stability-17-\(title)")
        let name = bar.staticTexts[title].firstMatch
        XCTAssertTrue(name.exists && name.frame.width > 1, "\(title): the bar does not show its title", file: file, line: line)
        // iOS 26 draws a half-height sheet as its full-width layout scaled into the inset card: its bar
        // is 386 x 51.9 pt against 402 x 54 at full height, and 'Peruuta' 80.0 x 34.6 against 83.3 x 36
        // (P0 e3-payment dump). The audit then read every snug label of Hyvitä laskua and Kirjaa maksu
        // as cut, 'Peruuta' and 'Tallenna' included, while their screenshots show them whole (run
        // 39322642358). The layout is the same at both heights, so such a sheet is dragged up by its
        // bar and audited unscaled.
        if !spansWindow(bar) {
            bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .press(forDuration: 0.1, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
            let deadline = Date().addingTimeInterval(5)
            while !spansWindow(bar) && Date() < deadline { usleep(250_000) }
            waitStill(bar)
            shot("stability-17-\(title)-full")
        }
        if spansWindow(bar) {
            // What the audit says for a real cut is unseen, so the title is measured too: cut, its frame
            // is narrower than the whole title in the bar's 17 pt semibold (about 129 pt, run 39322642358).
            let whole = (title as NSString).size(withAttributes: [.font: UIFont.preferredFont(forTextStyle: .headline)]).width
            XCTAssertGreaterThanOrEqual(name.frame.width, whole - 3, "\(title): the title is cut (\(name.frame.width) of \(whole) pt)", file: file, line: line)
            let cut = clippedTexts().filter { !under.contains($0) }
            XCTAssertEqual(cut, [], "\(title): text cut on the sheet", file: file, line: line)
        } else {
            dump(app, "stability-17-not-full")
            XCTFail("\(title): the sheet did not rise to full height (bar \(bar.frame)), so it was not audited", file: file, line: line)
        }
        bar.buttons["Peruuta"].firstMatch.tap(); taps += 1
        XCTAssertTrue(bar.waitForNonExistence(timeout: 10), "\(title): Peruuta did not close the sheet", file: file, line: line)
    }

    /// Taps `item` in the bar's Toiminnot menu. The screen under the menu can have a button of that
    /// name too (Ostolasku's own "Kirjaa maksu"); the menu lies over it, so its item is the last match.
    private func pickFromMenu(_ bar: XCUIElement, _ item: String) -> Bool {
        let menu = bar.buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 15) else { note("MISS \(item): no Toiminnot"); return false }
        menu.tap(); taps += 1
        guard let button = hittable(app.buttons.matching(NSPredicate(format: "label == %@", item)), last: true, timeout: 5) else {
            dump(app, "stability-17-menu"); note("MISS \(item) in Toiminnot")
            // Closes the menu, so the next step starts from the screen.
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            return false
        }
        button.tap(); taps += 1
        return true
    }

    /// The first hittable element of `query` (the last one with `last`), looked for until `timeout`.
    private func hittable(_ query: XCUIElementQuery, last: Bool = false, timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let all = query.allElementsBoundByIndex
            if let element = last ? all.last(where: { $0.isHittable }) : all.first(where: { $0.isHittable }) { return element }
            usleep(250_000)
        } while Date() < deadline
        return nil
    }

    /// A sheet's bar spans the window only at full height, where the sheet is drawn unscaled.
    private func spansWindow(_ bar: XCUIElement) -> Bool {
        bar.frame.width >= app.windows.firstMatch.frame.width - 1
    }

    /// The texts the textClipped audit finds cut on the screen at this text size, by label and what the
    /// audit said; the audit itself records nothing. Its guesses at larger sizes ("may be clipped at
    /// larger Dynamic Type sizes") are only noted, as in P2Tests.testI: those belong to B5, and the
    /// audit makes them for whole text too (OwnerScreensTests.testD, run 39207976615). P2Tests has a
    /// copy: the session gate builds this file alone onto an older ref.
    private func clippedTexts() -> [String] {
        let found = ClippedTexts()
        do {
            try app.performAccessibilityAudit(for: .textClipped) { issue in
                let label = issue.element?.label ?? ""
                let text = "\(label.isEmpty ? issue.compactDescription : label): \(issue.detailedDescription)"
                if "\(issue.compactDescription) \(issue.detailedDescription)".localizedCaseInsensitiveContains("larger") {
                    self.note("INFO 17 audit at larger sizes: \(text)")
                } else {
                    found.labels.append(text)
                }
                return true
            }
        } catch {
            XCTFail("the textClipped audit did not run: \(error)")
        }
        return found.labels
    }

    /// A month chip's button: "Syyskuu, 3", or "Joulukuu 2025, 3" for another year (SectionChip).
    static let monthChip = "[A-ZÄÖÅ][a-zäöå]+( [0-9]{4})?, [0-9]+"
    /// Any bank row's button, whatever its state. A copy of P1Tests.bankRow: the session gate
    /// builds this file alone onto an older ref, so it cannot borrow from P1Tests.
    static let bankRow = ".*, [0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4} · .*, .*"

    /// Pankki's bar: its title shown, and Toiminnot the one item beside Back, at the trailing end.
    private func assertBankBar(_ bar: XCUIElement, _ moment: String, file: StaticString = #filePath, line: UInt = #line) {
        let title = bar.staticTexts["Pankki"].exists
        // A toolbar Menu is a labelled button around an unlabelled one: each label once.
        var items: [String] = []
        for button in bar.buttons.allElementsBoundByIndex where button.identifier != "BackButton" {
            let label = button.label
            if !label.isEmpty && !items.contains(label) { items.append(label) }
        }
        let actions = bar.buttons["Toiminnot"].firstMatch
        let trailing = actions.exists && actions.frame.minX > bar.frame.midX
        check("pankki bar \(moment): title \(title), items \(items), Toiminnot trailing \(trailing)", title && items == ["Toiminnot"] && trailing)
        XCTAssertTrue(title, "\(moment): the bar does not show the title Pankki", file: file, line: line)
        XCTAssertEqual(items, ["Toiminnot"], "\(moment): the bar's items besides Back", file: file, line: line)
        XCTAssertTrue(trailing, "\(moment): Toiminnot is not at the bar's trailing end", file: file, line: line)
    }

    /// Toiminnot's items; then a month the list does not show, picked from Kuukausi, selects its
    /// chip and names itself in Kuukausi; then Valitse brings Valitse kaikki and Valmis.
    private func checkBankActions(_ bar: XCUIElement, _ entry: String) {
        let chips = app.buttons.matching(NSPredicate(format: "label MATCHES %@ AND NOT (label BEGINSWITH %@)", Self.monthChip, "Päiväämättömät"))
        // Kohdista kuitit opens on Vaatii toimia, and the --ci seed's open rows are in statements
        // 0, 4 and 30 days back: one month on a 31st. Kaikki adds the finished month 3 months back.
        if entry == "Kohdista kuitit" && !chips.allElementsBoundByIndex.contains(where: { !$0.isSelected }) {
            app.segmentedControls.firstMatch.buttons["Kaikki"].tap(); taps += 1
            _ = chips.matching(NSPredicate(format: "selected == false")).firstMatch.waitForExistence(timeout: 5)
        }
        guard let chip = chips.allElementsBoundByIndex.first(where: { !$0.isSelected }) else {
            dump(app, "stability-12-chips"); XCTFail("\(entry): one month chip only (the --ci seed has rows in several months)"); return
        }
        let name = String(chip.label.prefix { $0 != "," })
        let menu = bar.buttons["Toiminnot"].firstMatch
        menu.tap(); taps += 1
        let valitse = app.buttons["Valitse"].firstMatch
        XCTAssertTrue(valitse.waitForExistence(timeout: 5) && valitse.isHittable, "\(entry): Toiminnot has no Valitse")
        XCTAssertTrue(app.buttons["Tiliotteet"].firstMatch.isHittable, "\(entry): Toiminnot has no Tiliotteet")
        let month = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kuukausi")).firstMatch
        XCTAssertTrue(month.exists && month.isHittable, "\(entry): Toiminnot has no Kuukausi")
        // The card's own button stays in the list behind the menu: a menu item shares Valitse's column.
        let approve = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Hyväksy kuittiehdotukset")).allElementsBoundByIndex
        let column = valitse.frame
        let inMenu = approve.contains(where: { (button: XCUIElement) -> Bool in
            abs(button.frame.minX - column.minX) < 2 && abs(button.frame.width - column.width) < 2
        })
        XCTAssertFalse(inMenu, "\(entry): Toiminnot holds Hyväksy kuittiehdotukset")
        dump(app, "stability-12-menu")
        guard month.exists else { return }
        month.tap(); taps += 1
        // The option ("Syyskuu 2026"), not the chip behind the menu ("Syyskuu, 3").
        let options = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT (label CONTAINS %@)", name, ","))
        _ = options.firstMatch.waitForExistence(timeout: 5)
        guard let option = options.allElementsBoundByIndex.first(where: { $0.isHittable }) else {
            dump(app, "stability-12-kuukausi"); XCTFail("\(entry): Kuukausi does not offer \(name)"); return
        }
        option.tap(); taps += 1
        let picked = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + ",")).firstMatch
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: picked)
        XCTAssertEqual(XCTWaiter().wait(for: [selected], timeout: 5), .completed, "\(entry): picking \(name) in Kuukausi did not select its chip")
        menu.tap(); taps += 1
        XCTAssertTrue(month.waitForExistence(timeout: 5), "\(entry): Toiminnot has no Kuukausi the second time")
        XCTAssertTrue(month.label.contains(name), "\(entry): Kuukausi says '\(month.label)' while the list shows \(name)")
        XCTAssertTrue(valitse.isHittable, "\(entry): Toiminnot has no Valitse the second time")
        valitse.tap(); taps += 1
        XCTAssertTrue(bar.buttons["Valmis"].waitForExistence(timeout: 5), "\(entry): Valitse did not bring Valmis")
        XCTAssertTrue(bar.buttons["Valitse kaikki"].exists, "\(entry): Valitse did not bring Valitse kaikki")
        bar.buttons["Valmis"].tap(); taps += 1
        XCTAssertTrue(bar.buttons["Toiminnot"].waitForExistence(timeout: 5), "\(entry): Valmis did not bring Toiminnot back")
        assertBankBar(bar, "\(entry), after Valmis")
    }

    /// The marker's moments ("tabs=<ms> signedOut=<ms> …", ms after the process started) once it
    /// shows one of `phases` (and, with `waitingFor`, once that moment is in the label too).
    private func launchMoments(_ phases: [String], waitingFor moment: String? = nil) -> [String: Int] {
        let marker = launchPhase(phases)
        guard marker.waitForExistence(timeout: 30) else { return [:] }
        var label = marker.label
        if let moment {
            let deadline = Date().addingTimeInterval(30)
            while !label.contains(moment + "="), Date() < deadline {
                usleep(200_000)
                label = marker.label
            }
        }
        var moments: [String: Int] = [:]
        for entry in label.split(separator: " ") {
            let pair = entry.split(separator: "=")
            if pair.count == 2, let ms = Int(pair[1]) { moments[String(pair[0])] = ms }
        }
        return moments
    }

    /// The first frame: whichever phase the marker was first built in.
    private static func firstFrame(_ moments: [String: Int]) -> Int? {
        moments.filter { ["launching", "tabs", "signedOut"].contains($0.key) && $0.value >= 0 }.values.min()
    }

    private static func timeline(_ moments: [String: Int]) -> String {
        moments.sorted { $0.value < $1.value }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
    }

    /// Revokes the demo user's app sessions on the demo API, so the token in the simulator's
    /// Keychain is refused at the next launch. Test values from app/scripts/demo-seed.ts; only ever
    /// against the throwaway local server (the runner shares the Mac's loopback).
    private func revokeAppSessions() -> Bool {
        func call(_ path: String, _ body: [String: String]?, _ token: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
            if let body {
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            var result: [String: Any]?
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, _, _ in
                result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 30)
            return result
        }
        guard let token = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String,
              let sessions = call("/api/auth/sessions", nil, token)?["sessions"] as? [[String: Any]] else { return false }
        // The app signs in as "ios-app"; this token (a plain one) is the current session and stays.
        let appSessions = sessions.filter { $0["label"] as? String == "iPhone · LashKirja-sovellus" && $0["current"] as? Bool != true }
        let revoked = appSessions.compactMap { $0["id"] as? String }
            .filter { call("/api/auth/sessions", ["id": $0], token)?["ok"] as? Bool == true }
        return !appSessions.isEmpty && revoked.count == appSessions.count
    }

    // MARK: Raportit (B8)

    /// M039, M048, X086: 'Edellinen vuosi' swaps the year in place. Once this year's figures have
    /// painted the year before is warmed, so the swap needs no spinner: the report used to empty
    /// into a spinner page while Kirjanpitopaketti rode up, then fell back 245-448 pt when the
    /// figures came. A year with nothing booked says so once, not with a blank chart and a
    /// 'Joulukuu 0,00 €' row. The hard asserts live here: MotionAuditTests only records.
    func test11_RaportitYearSwapInPlace() throws {
        let today = Self.helsinkiMonth()
        try XCTSkipIf(today.month <= 4, "the --ci seed's rows reach into \(today.year - 1) until May: no empty year before this one")
        let previous = String(today.year - 1)
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        let monthly = app.staticTexts["Kuukausittain"].firstMatch
        guard monthly.waitForExistence(timeout: 15) else {
            dump(app, "stability-11-no-report"); XCTFail("Raportit shows no Kuukausittain"); return
        }
        // X086: the bars' key under the chart before any bar is tapped.
        let legend = app.descendants(matching: .any)["raportit-legend"]
        XCTAssertTrue(legend.waitForExistence(timeout: 5), "Kuukausittain has no legend")
        XCTAssertTrue(legend.label.contains("Tulot") && legend.label.contains("Menot"), "the legend reads '\(legend.label)'")
        XCTAssertGreaterThan(legend.frame.minY, monthly.frame.maxY, "the legend is not under the Kuukausittain heading")
        waitStill(monthly)

        let stepper = app.buttons["Edellinen vuosi"].firstMatch
        let stepperY = stepper.frame.minY
        let yearShown = app.staticTexts[previous].firstMatch
        let emptyYear = app.staticTexts["Ei kirjauksia vuodelta \(previous)"].firstMatch
        stepper.tap(); taps += 1
        var polls = 0
        var swapped = false
        let deadline = Date().addingTimeInterval(20)
        repeat {
            polls += 1
            let spinners = app.activityIndicators.count
            XCTAssertEqual(spinners, 0, "poll \(polls): a spinner showed while the year swapped")
            XCTAssertEqual(stepper.frame.minY, stepperY, accuracy: 1, "poll \(polls): the year stepper moved")
            swapped = yearShown.exists && emptyYear.exists
            if !swapped { usleep(100_000) }
        } while !swapped && Date() < deadline
        check("raportit year swap: \(previous) with its empty state after \(polls) polls", swapped)
        guard swapped else {
            dump(app, "stability-11-swap"); XCTFail("\(previous) and 'Ei kirjauksia vuodelta \(previous)' never showed"); return
        }
        // The package below took its place in one move: once settled it holds still (the second
        // pass was the fall back when the figures came).
        let package = app.staticTexts["Kirjanpitopaketti"].firstMatch
        XCTAssertTrue(package.waitForExistence(timeout: 5), "Kirjanpitopaketti is not under the empty year")
        waitStill(package)
        let packageY = package.frame.minY
        for poll in 1...8 {
            usleep(150_000)
            XCTAssertEqual(package.frame.minY, packageY, accuracy: 1, "Kirjanpitopaketti moved again \(poll * 150) ms after it settled")
        }
        XCTAssertEqual(app.activityIndicators.count, 0, "a spinner showed after the swap")
        XCTAssertFalse(app.staticTexts["Kuukausittain"].exists, "\(previous) still draws Kuukausittain")
        let december = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Joulukuu", "Joulukuu,")).firstMatch
        XCTAssertFalse(december.exists, "\(previous) picks a Joulukuu row")
        shot("stability-raportit-empty-year")
    }

    /// X078, X085: Raportit keeps one visible action, Lataa zip, drawn as the primary; the six CSV
    /// exports sit in Toiminnot › Vienti (CSV) instead of six accent rows under the package. Kausi
    /// names its period as Kuukauden sulku does ('Syyskuu 2026'), not '09/2026'.
    func test19_RaportitOnePrimary() {
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        let zip = app.buttons["Lataa zip"].firstMatch
        // The package closes the page, under the month and the year's figures: the List builds its
        // row only once scrolled near, so the wait is for the report and the zip is scrolled to (run
        // 39334491019 waited 15 s for a row it never scrolled to).
        guard app.staticTexts["Kuukausittain"].firstMatch.waitForExistence(timeout: 15), reveal(zip, scrolls: 8) else {
            dump(app, "stability-19-no-zip"); XCTFail("Lataa zip is not hittable on Raportit"); return
        }
        // On to the end of the page, where the owner's scroll stops: a reveal can leave the button
        // in the tab bar's soft edge, which pales the fill read below.
        app.windows.firstMatch.swipeUp(velocity: .fast); scrolls += 1
        waitStill(zip)
        XCTAssertLessThan(zip.frame.maxY, app.tabBars.firstMatch.frame.minY, "Lataa zip sits under the tab bar")
        // The primary's ink capsule, read beside its label: a plain row is the white card.
        let fill = screenColours(app, at: [CGPoint(x: zip.frame.minX + zip.frame.width * 0.15, y: zip.frame.midY)]).first ?? nil
        XCTAssertTrue(fill?.near(RGB(r: 38, g: 34, b: 31), within: 12) == true,
                      "Lataa zip is not drawn as the primary: \(fill?.description ?? "off screen")")
        let today = Self.helsinkiMonth()
        let last = Self.helsinkiMonth(offset: -1)
        let kausi = last.year == today.year ? "\(Self.monthNames[last.month - 1]) \(last.year)" : "Tammikuu \(today.year)"
        let picker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kausi")).firstMatch
        let named = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", kausi)).firstMatch
        let reads = named.exists || (picker.exists && (picker.label.contains(kausi) || (picker.value as? String)?.contains(kausi) == true))
        XCTAssertTrue(reads, "Kausi does not read \(kausi) (picker '\(picker.exists ? picker.label : "missing")')")
        // The end of the page, where the export rows were.
        for _ in 0..<3 { app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1 }
        XCTAssertFalse(app.buttons["Tuloslaskelma"].exists, "the page still lists a Tuloslaskelma export")
        XCTAssertFalse(app.staticTexts["Vienti (CSV)"].exists, "the page still has the Vienti (CSV) section")
        shot("stability-raportit-end")

        let menu = app.navigationBars["Raportit"].buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 5) else { XCTFail("Raportit's bar has no Toiminnot"); return }
        menu.tap(); taps += 1
        let vienti = app.buttons["Vienti (CSV)"].firstMatch
        guard vienti.waitForExistence(timeout: 5) else { dump(app, "stability-19-menu"); XCTFail("Toiminnot has no Vienti (CSV)"); return }
        vienti.tap(); taps += 1
        for title in ["Tuloslaskelma", "Kuitit", "Myyntilaskut", "Pankkitapahtumat", "Ostolaskut", "Asiakkaat"] {
            XCTAssertTrue(app.buttons[title].firstMatch.waitForExistence(timeout: 5), "Vienti (CSV) has no \(title)")
        }
        dump(app, "stability-19-vienti")
        app.buttons["Tuloslaskelma"].firstMatch.tap(); taps += 1
        XCTAssertTrue(app.navigationBars["profit-loss-\(today.year).csv"].waitForExistence(timeout: 15), "Tuloslaskelma did not open its CSV sheet")
        shot("stability-raportit-csv")
    }

    /// X079: the list behind Menot holds the rows the figure is made of. The figure and Luokittain
    /// count the bill the --ci seed files as an ostolasku; the list asked for kuitit only and said
    /// one fewer (34 kuittia under a Menot of 35).
    func test20_RaportitMenotListMatchesItsFigure() {
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        guard app.staticTexts["Kuukausittain"].firstMatch.waitForExistence(timeout: 15) else {
            dump(app, "stability-20-no-report"); XCTFail("Raportit shows no report"); return
        }
        guard let menot = menotFigure() else { dump(app, "stability-20-no-menot"); XCTFail("Raportit has no Menot figure"); return }
        menot.tap(); taps += 1
        let kuitit = app.navigationBars["Kuitit"]
        guard kuitit.waitForExistence(timeout: 15) else { XCTFail("Menot did not open Kuitit"); return }
        let header = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+ kuittia")).firstMatch
        guard header.waitForExistence(timeout: 15) || reveal(header, scrolls: 4) else {
            dump(app, "stability-20-no-count"); XCTFail("the Menot list has no count"); return
        }
        let listed = Int(header.label.filter(\.isNumber)) ?? -1
        shot("stability-raportit-menot-list")
        kuitit.buttons["BackButton"].firstMatch.tap(); taps += 1
        guard app.navigationBars["Raportit"].waitForExistence(timeout: 10) else { XCTFail("Back did not return to Raportit"); return }

        // Luokittain opens on Menot; each row reads "<category>, <n> kpl, <amount>". Read on the
        // way down, as a List keeps only the rows on screen.
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", " kpl"))
        var counted: [String: Int] = [:]
        for attempt in 0..<5 {
            for row in rows.allElementsBoundByIndex where row.exists {
                let label = row.label
                if let range = label.range(of: "[0-9]+ kpl", options: .regularExpression),
                   let count = Int(label[range].filter(\.isNumber)) { counted[label] = count }
            }
            if attempt < 4 { app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1 }
        }
        let figure = counted.values.reduce(0, +)
        check("raportit menot: Luokittain \(figure) (\(counted.count) rows), list \(listed)", figure > 0 && listed == figure)
        XCTAssertGreaterThan(figure, 0, "no Luokittain counts read")
        XCTAssertEqual(listed, figure, "the Menot list says \(listed) kuittia, Luokittain counts \(figure)")
    }

    /// Raportit's Menot figure, scrolled into view: a "Menot…" button outside Luokittain's
    /// segmented control, whose segment has the same name.
    private func menotFigure() -> XCUIElement? {
        let window = app.windows.firstMatch
        for attempt in 0...6 {
            let segments = app.segmentedControls.allElementsBoundByIndex.map(\.frame)
            let candidates = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Menot")).allElementsBoundByIndex
            let figure = candidates.first { button in
                button.isHittable && button.frame.minY > 100 && button.frame.maxY < window.frame.maxY - 90
                    && !segments.contains { $0.intersects(button.frame) }
            }
            if let figure { return figure }
            if attempt < 6 { window.swipeUp(velocity: .slow); scrolls += 1 }
        }
        return nil
    }

    static let monthNames = ["Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu",
                             "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu"]

    /// The year and month (1-12) in Helsinki, where the app keeps its months, `offset` months from now.
    static func helsinkiMonth(offset: Int = 0) -> (year: Int, month: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Helsinki") ?? .current
        let date = calendar.date(byAdding: .month, value: offset, to: Date()) ?? Date()
        let parts = calendar.dateComponents([.year, .month], from: date)
        return (parts.year ?? 2026, parts.month ?? 1)
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

    /// X040 (B12): picking rows moves nothing. On Kuitit the review card left as the mode began and
    /// pulled the chips and every row up by its height; the bulk bar had its own Peruuta beside the
    /// toolbar's Valmis, and stood two rows tall around a single action. The same bar is checked on
    /// Ostolaskut and on the bank rows, which share it.
    func test14_SelectModeHoldsStill() {
        openHubRow("Kuitit")
        let chips = app.buttons["receipt-tab-all"].firstMatch
        let actions = app.navigationBars["Kuitit"].buttons["Toiminnot"].firstMatch
        guard chips.waitForExistence(timeout: 15), actions.waitForExistence(timeout: 15) else {
            dump(app, "stability-14-kuitit"); XCTFail("Kuitit opened without its chips or Toiminnot"); return
        }
        // The CI seed's two receipts wait for review: the card is on screen before the mode starts.
        let pending = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", ", Tarkista")).firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 15), "no Odottaa hyväksyntää card: is the seed demo-seed.ts --ci?")
        waitStill(chips)
        let before = chips.frame.minY
        actions.tap(); taps += 1
        let select = app.buttons["Valitse kuitteja"].firstMatch
        guard select.waitForExistence(timeout: 5) else { dump(app, "stability-14-menu"); XCTFail("Toiminnot has no Valitse kuitteja"); return }
        select.tap(); taps += 1
        guard app.buttons["Valitse kaikki"].firstMatch.waitForExistence(timeout: 5) else {
            dump(app, "stability-14-no-mode"); XCTFail("Valitse kuitteja did not start picking"); return
        }
        guard let row = firstListRow(below: chips) else {
            dump(app, "stability-14-no-row"); XCTFail("no receipt row on screen under the chips"); return
        }
        row.tap(); taps += 1
        guard let bar = bulkBar("kuitit") else { return }
        waitStill(chips)
        note("INFO stability 14: chips at \(before) before Valitse, \(chips.frame.minY) with a row picked")
        XCTAssertEqual(chips.frame.minY, before, accuracy: 1, "the chips moved when picking started")
        XCTAssertTrue(pending.exists, "the Odottaa hyväksyntää card left when picking started")
        shot("stability-select-kuitit")
        endSelectMode(bar, "Kuitit", "kuitit")
        XCTAssertEqual(chips.frame.minY, before, accuracy: 1, "the chips moved when picking ended")
        backToBooks("Kuitit")

        // Ostolaskut: the CI seed's rent bill, filed as an ostolasku.
        openHubRow("Ostolaskut")
        let pick = app.navigationBars["Ostolaskut"].buttons["Valitse"].firstMatch
        guard pick.waitForExistence(timeout: 15) else { dump(app, "stability-14-ostolaskut"); XCTFail("Ostolaskut has no Valitse"); return }
        pick.tap(); taps += 1
        guard tapLabel("label CONTAINS %@", "Kiinteistö Oy Kauppakatu 1") else {
            dump(app, "stability-14-ostolaskut-no-row"); XCTFail("Ostolaskut: no Kiinteistö Oy Kauppakatu 1 row to pick"); return
        }
        guard let invoiceBar = bulkBar("ostolaskut") else { return }
        shot("stability-select-ostolaskut")
        endSelectMode(invoiceBar, "Ostolaskut", "ostolaskut")
        backToBooks("Ostolaskut")

        // The bank rows: today behind the Pankki hub's "Näytä kaikki" on Pankkitapahtumat, and with
        // N2 Pankki itself, where Valitse is in Toiminnot. Either way in, the same bar.
        openHubRow("Pankki")
        let bankRow = app.buttons.matching(NSPredicate(format: "label MATCHES %@", ".*, [0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4} · .*, .*")).firstMatch
        if !app.navigationBars["Pankki"].buttons["Toiminnot"].waitForExistence(timeout: 5) {
            tapLabel("label == %@", "Näytä kaikki")
            _ = app.navigationBars["Pankkitapahtumat"].waitForExistence(timeout: 10)
        }
        let feed = app.navigationBars["Pankkitapahtumat"].exists ? app.navigationBars["Pankkitapahtumat"] : app.navigationBars["Pankki"]
        guard bankRow.waitForExistence(timeout: 15) else { dump(app, "stability-14-bank"); XCTFail("no bank row arrived"); return }
        let feedTitle = feed.identifier
        if feed.buttons["Valitse"].exists {
            feed.buttons["Valitse"].firstMatch.tap(); taps += 1
        } else {
            feed.buttons["Toiminnot"].firstMatch.tap(); taps += 1
            let item = app.buttons["Valitse"].firstMatch
            guard item.waitForExistence(timeout: 5) else { dump(app, "stability-14-bank-menu"); XCTFail("\(feedTitle): no Valitse"); return }
            item.tap(); taps += 1
        }
        guard tapLabel("label MATCHES %@", ".*, [0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4} · .*, .*") else {
            dump(app, "stability-14-bank-no-row"); XCTFail("\(feedTitle): no bank row to pick"); return
        }
        guard let bankBar = bulkBar("pankki") else { return }
        shot("stability-select-pankki")
        endSelectMode(bankBar, feedTitle, "pankki")
    }

    /// X065 (B12, N3): under a bottom bar, down to the tab bar, the canvas and nothing else. The
    /// rows under Kuitit's "Kohdista varmat" showed through the gap above the floating tab bar.
    /// The receipt's Hyväksy, at the bottom since N3, has the same backing.
    func test15_BottomBarsHaveABacking() {
        openHubRow("Kuitit")
        let unlinked = app.buttons["receipt-tab-unlinked"].firstMatch
        guard unlinked.waitForExistence(timeout: 15) else { dump(app, "stability-15-kuitit"); XCTFail("no Ei kohdistettu chip"); return }
        // The chips scroll sideways; the fifth may sit past the edge.
        revealChip(unlinked, inRow: "receipt-chips")
        unlinked.tap(); taps += 1
        // The seed's two sure pairs. At the top of the list, rows run on under the bar.
        let sure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat")).firstMatch
        guard sure.waitForExistence(timeout: 20) else {
            dump(app, "stability-15-no-sure"); XCTFail("no Kohdista varmat on Ei kohdistettu: does the seed have its sure pairs?"); return
        }
        assertCanvasUnderBar(sure, "Ei kohdistettu, Kohdista varmat")
        shot("stability-sure-bar")

        // Not Lumo Kosmetiikka Oy: P1 test04 approves it, and nothing reseeds between tests.
        guard tapLabel("label BEGINSWITH %@", "Audit Hyvitys Odottaa Oy,") else { XCTFail("no Audit Hyvitys Odottaa Oy waiting for review"); return }
        let approve = app.buttons.matching(NSPredicate(format: "label == %@", "Hyväksy")).firstMatch
        guard approve.waitForExistence(timeout: 15) else { dump(app, "stability-15-no-hyvaksy"); XCTFail("the pending receipt has no Hyväksy"); return }
        assertCanvasUnderBar(approve, "Kuitti, Hyväksy")
        shot("stability-receipt-bar")
    }

    /// X025 (B11): a picked chip turns semibold and moves nothing. Its wider label pushed every chip
    /// after it by about 3 pt, on Myynti, on an invoice's tabs, on Kuitit and on Ostolaskut. The
    /// outline did too: drawn centred on the edge, it made an unpicked chip 1 pt wider (run 39334173559).
    func test18_ChipsKeepTheirWidth() {
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        assertChipsHoldStill("sales-chips", "Myynti", counted: true)
        // Lasku 2, the seed's overdue invoice: listed on Kaikki and on Myöhässä alike.
        guard tapLabel("label CONTAINS %@", "Lasku 2 · "), app.navigationBars["Lasku 2"].waitForExistence(timeout: 20) else {
            dump(app, "stability-18-no-invoice"); XCTFail("Lasku 2 did not open from Myynti"); return
        }
        assertChipsHoldStill("invoice-tabs", "Lasku 2", counted: false)
        openHubRow("Kuitit")
        assertChipsHoldStill("receipt-chips", "Kuitit", counted: true)
        shot("stability-chips-kuitit")
        // Ostolaskut draws its own copy of the chip. Its pick is kept between visits (ostolaskut.filter):
        // Kaikki is picked again after.
        backToBooks("Kuitit")
        openHubRow("Ostolaskut")
        assertChipsHoldStill("purchase-chips", "Ostolaskut", counted: true)
        app.scrollViews.matching(identifier: "purchase-chips").firstMatch.buttons.element(boundBy: 0).tap(); taps += 1
    }

    /// The first picked-mode row of a list on screen below `top`, not under the bottom of the
    /// screen: a row's button names a day ("15.10.2026").
    private func firstListRow(below top: XCUIElement) -> XCUIElement? {
        let window = app.windows.firstMatch.frame
        let rows = app.buttons.matching(NSPredicate(format: "label MATCHES %@", ".*[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4}.*"))
        return rows.allElementsBoundByIndex.first { row in
            row.exists && row.isHittable && row.frame.minY > top.frame.maxY && row.frame.maxY < window.maxY - 120
        }
    }

    /// The bulk bar once a row is picked: no Peruuta of its own, and with one action one row high.
    private func bulkBar(_ screen: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement? {
        let bar = app.descendants(matching: .any).matching(identifier: "bulk-bar").firstMatch
        guard bar.waitForExistence(timeout: 5) else {
            dump(app, "stability-14-\(screen)-no-bar"); XCTFail("\(screen): no bulk bar after picking a row", file: file, line: line); return nil
        }
        waitStill(bar)
        var actions: [String] = []
        for button in bar.buttons.allElementsBoundByIndex where !button.label.isEmpty && !actions.contains(button.label) {
            actions.append(button.label)
        }
        note("INFO stability 14 \(screen): bulk bar \(bar.frame), actions \(actions)")
        XCTAssertFalse(actions.isEmpty, "\(screen): the bulk bar has no action", file: file, line: line)
        XCTAssertFalse(actions.contains("Peruuta"), "\(screen): the bulk bar has its own Peruuta", file: file, line: line)
        if actions.count == 1 {
            XCTAssertLessThanOrEqual(bar.frame.height, 64, "\(screen): one action in a \(bar.frame.height) pt bar", file: file, line: line)
        }
        return bar
    }

    /// Back from a Kirjanpito screen to the hub, as the owner goes.
    private func backToBooks(_ title: String) {
        app.navigationBars[title].buttons["BackButton"].firstMatch.tap(); taps += 1
        XCTAssertTrue(app.navigationBars["Kirjanpito"].waitForExistence(timeout: 10), "Back from \(title) did not reach Kirjanpito")
    }

    /// X025: picks the first chip of the row not picked yet (one wholly on the screen, so XCTest does
    /// not scroll the row to reach it), waits until it reports itself selected, and compares every
    /// chip's place and width with before the tap.
    private func assertChipsHoldStill(_ identifier: String, _ screen: String, counted: Bool,
                                      file: StaticString = #filePath, line: UInt = #line) {
        let row = app.scrollViews.matching(identifier: identifier).firstMatch
        guard row.waitForExistence(timeout: 20) else {
            dump(app, "stability-18-\(identifier)"); XCTFail("\(screen): no chip row '\(identifier)'", file: file, line: line); return
        }
        let chips = row.buttons
        let before = chipFrames(chips, counted: counted)
        let window = app.windows.firstMatch.frame
        let shown = chips.allElementsBoundByIndex
        guard let index = shown.indices.first(where: {
            !shown[$0].isSelected && shown[$0].frame.minX >= window.minX && shown[$0].frame.maxX <= window.maxX
        }) else {
            dump(app, "stability-18-\(identifier)"); XCTFail("\(screen): no chip on the screen to pick", file: file, line: line); return
        }
        let chip = chips.element(boundBy: index)
        let label = chip.label
        chip.tap(); taps += 1
        let picked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: chip)
        guard XCTWaiter().wait(for: [picked], timeout: 10) == .completed else {
            dump(app, "stability-18-\(identifier)"); XCTFail("\(screen): '\(label)' did not report itself selected", file: file, line: line); return
        }
        let after = chipFrames(chips, counted: counted)
        func places(_ frames: [CGRect]) -> String { frames.map { "\($0.minX)+\($0.width)" }.joined(separator: " ") }
        note("INFO stability 18 \(screen): picked '\(label)'; x+width before \(places(before)), after \(places(after))")
        XCTAssertEqual(after.count, before.count, "\(screen): the row has \(after.count) chips after the pick, \(before.count) before",
                       file: file, line: line)
        for (position, (old, new)) in zip(before, after).enumerated() {
            XCTAssertEqual(new.minX, old.minX, accuracy: 0.5, "\(screen): chip \(position) moved from x \(old.minX) to \(new.minX)",
                           file: file, line: line)
            XCTAssertEqual(new.width, old.width, accuracy: 0.5, "\(screen): chip \(position) went from \(old.width) pt wide to \(new.width)",
                           file: file, line: line)
        }
    }

    /// The row's chip frames once two looks half a second apart agree, and in a counted row once every
    /// chip shows its count: a count arriving widens its chip, which is not the pick's doing.
    private func chipFrames(_ chips: XCUIElementQuery, counted: Bool) -> [CGRect] {
        var last: [CGRect] = []
        let deadline = Date().addingTimeInterval(15)
        repeat {
            let shown = chips.allElementsBoundByIndex
            let frames = shown.map(\.frame)
            let ready = !counted || shown.allSatisfy { $0.label.contains(where: \.isNumber) }
            if ready, !frames.isEmpty, frames == last { return frames }
            last = frames
            usleep(500_000)
        } while Date() < deadline
        return last
    }

    /// The toolbar's Valmis ends the mode: the bar and Valitse kaikki go.
    private func endSelectMode(_ bar: XCUIElement, _ title: String, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        let done = app.navigationBars[title].buttons["Valmis"].firstMatch
        guard done.exists else { XCTFail("\(screen): no Valmis in the bar", file: file, line: line); return }
        done.tap(); taps += 1
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5), "\(screen): Valmis left the bulk bar up", file: file, line: line)
        XCTAssertFalse(app.buttons["Valitse kaikki"].exists, "\(screen): Valmis left the mode on", file: file, line: line)
    }
}

/// What an audit's handler found; a class, so the handler fills it in place.
private final class ClippedTexts {
    var labels: [String] = []
}
