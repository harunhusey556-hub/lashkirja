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
        check(step, app.state == .runningForeground, file: file, line: line)
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
        // Selected, not only tapped: test01's tap came 1 s after 'Not Now' on the password manager's
        // offer and was lost, and the walk grew Koti's task list as if it were Kuitit (run 39538176287).
        XCTAssertTrue(selectTab("Kirjanpito"), "Kirjanpito is not selected")
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
        tapLabel("label BEGINSWITH %@", "Tulos ja tase, Tuloslaskelma"); sleep(3)
        for part in ["Tase", "Saldot", "Päiväkirja", "Tulos"] {
            // U086: the view the tap picked is the one shown; a running app alone passed whichever
            // view stayed, and a segment that never came was skipped without a word.
            let segment = app.segmentedControls.buttons[part].firstMatch
            let shown = segment.waitForExistence(timeout: 10)
            if shown { segment.tap(); taps += 1 }
            let selected = shown && XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: segment)],
                                                     timeout: 5) == .completed
            check("kirjanpito: \(part) selected after its tap", selected)
            assertResponsive("kirjanpito: \(part)")
        }
        XCTAssertFalse(app.staticTexts["Tase ei täsmää. Ilmoita tästä tukeen."].exists, "balance sheet does not balance")
        // U079: the books are on the warm canvas, as Pankki is (test04), not the system grey.
        if app.buttons["Tulos"].exists {
            assertWarmCanvas(app, under: app.navigationBars["Tulos ja tase"], "kirjanpito")
        } else { XCTFail("kirjanpito: the books did not open") }
        shot("stability-kirjanpito")
    }

    /// U086 X181: ALV opens and is read like the other pushed screens, and the probe says whether it
    /// held the main thread. Its PASS was the app running, true whether ALV opened or not.
    func test04_VatAndBankHubOpen() {
        let log = relaunchWithProbe("test04")
        XCTAssertTrue(selectTab("Kirjanpito"), "Kirjanpito is not selected")
        let since = Date().timeIntervalSince1970
        XCTAssertTrue(tap("ALV-ilmoitus"), "Kirjanpito has no ALV-ilmoitus")
        let alv = app.navigationBars["ALV-ilmoitus"]
        let opened = alv.waitForExistence(timeout: 15)
        let figure = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Maksettava ALV", "Palautettava ALV"])).firstMatch
        let read = opened && figure.waitForExistence(timeout: 20)
        shot("stability-alv")
        XCTAssertTrue(opened, "ALV-ilmoitus did not open")
        XCTAssertTrue(read, "ALV shows no Maksettava ALV or Palautettava ALV")
        assertAlvNotStalled(log, from: since, to: Date().timeIntervalSince1970, "alv")
        XCTAssertEqual(app.state, .runningForeground, "alv: app is not running")
        edgeSwipeBack()
        check("alv", app.state == .runningForeground)
        // The swipe is not taken on trust: in 3 of 9 suite runs it left ALV up (runs 38779539454,
        // 38895961757, 38993875695), "Pankki" was then looked for on ALV and the step passed
        // without Pankki ever opening. Its row shows once the pop has finished.
        let hubRow = app.staticTexts["Pankki"].firstMatch
        let popped = alv.waitForNonExistence(timeout: 10) && hubRow.waitForExistence(timeout: 10)
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
        _ = tap("Pankki")
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
        // X140 (N7): the page is named by the row that opened it.
        XCTAssertTrue(app.navigationBars["Lisää tiedosto"].waitForExistence(timeout: 10), "receipt page did not open")
        XCTAssertTrue(app.buttons["Valitse kuvista"].exists || app.staticTexts["Valitse kuvista"].exists, "picker buttons missing")
        shot("stability-lisaa-kuitti")
        _ = tap("Peruuta"); sleep(1)
        assertResponsive("lisää kuitti closed")
    }

    func test06_ReportProblemSends() {
        openSettings()
        XCTAssertTrue(tap("Ilmoita ongelmasta"), "Ilmoita ongelmasta missing from settings")
        // U079: read before the keyboard rises over the form.
        assertWarmCanvas(app, under: app.navigationBars["Ilmoita ongelmasta"], "ilmoita ongelmasta")
        let field = app.textFields.firstMatch.exists ? app.textFields.firstMatch : app.textViews.firstMatch
        if field.waitForExistence(timeout: 10) { type(field, "Simulaattoritesti") }
        _ = tap("Lähetä ilmoitus")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ilmoitus tallennettu")).firstMatch.waitForExistence(timeout: 15),
                      "no confirmation code after sending")
        // U081: the keyboard leaves with the sent note. It stayed up over the code's line and
        // 'Kopioi koodi', which showed only as a red blur behind the suggestion bar.
        let keyboardGone = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 5)
        XCTAssertEqual(keyboardGone, .completed, "the keyboard stayed up after the report was sent")
        let copy = app.buttons["Kopioi koodi"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5) && copy.isHittable, "Kopioi koodi is not hittable after sending")
        shot("stability-report")

        // X150 X151: Ohje's 'Ilmoita ongelmasta' opens this same screen, not a share sheet beside a
        // 'Kopioi tukikoodi', and Ohje no longer says that the support address is missing.
        let report = app.navigationBars["Ilmoita ongelmasta"]
        report.buttons["BackButton"].firstMatch.tap(); taps += 1
        XCTAssertTrue(report.waitForNonExistence(timeout: 10), "Ilmoita ongelmasta did not close")
        XCTAssertTrue(tap("Ohje"), "Ohje missing from settings")
        let help = app.navigationBars["Ohje ja tuki"]
        guard help.waitForExistence(timeout: 10) else { XCTFail("Ohje did not open"); return }
        let unfinished = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tukiosoitetta ei ole vielä"))
        XCTAssertEqual(unfinished.count, 0, "Ohje says the support address is missing")
        XCTAssertFalse(app.buttons["Kopioi tukikoodi"].exists, "Ohje still has Kopioi tukikoodi")
        shot("stability-ohje")
        XCTAssertTrue(tap("Ilmoita ongelmasta"), "Ohje has no Ilmoita ongelmasta")
        XCTAssertTrue(report.waitForExistence(timeout: 10), "Ohje's Ilmoita ongelmasta did not open the Asetukset row's screen")
        XCTAssertTrue(app.buttons["Lähetä ilmoitus"].waitForExistence(timeout: 5), "Ohje's Ilmoita ongelmasta opened a screen without Lähetä ilmoitus")
    }

    /// X095 (P4): files of one month read apart on Tiliotteet. Each row said its month twice ('Tiliote ·
    /// Lokakuu 2026' over 'Lokakuu 2026 · Käyttötili · N tapahtumaa'); the line under the title now
    /// names the file. The --ci seed has three files in the month 0, 2 and 4 days back.
    func test22_TiliotteetRowsReadApart() {
        guard selectTab("Kirjanpito"), tap("Pankki"), app.navigationBars["Pankki"].waitForExistence(timeout: 10) else {
            XCTFail("Pankki did not open"); return
        }
        let actions = app.navigationBars["Pankki"].buttons["Toiminnot"].firstMatch
        guard actions.waitForExistence(timeout: 10) else { XCTFail("Pankki has no Toiminnot"); return }
        actions.tap(); taps += 1
        let statements = app.buttons["Tiliotteet"].firstMatch
        guard statements.waitForExistence(timeout: 5) else { XCTFail("Toiminnot has no Tiliotteet"); return }
        statements.tap(); taps += 1
        guard app.navigationBars["Tiliotteet"].waitForExistence(timeout: 10) else { XCTFail("Tiliotteet did not open"); return }
        let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tiliote · "))
        guard rows.firstMatch.waitForExistence(timeout: 20) else { dump(app, "stability-22-no-rows"); XCTFail("Tiliotteet lists no files"); return }
        shot("stability-22-tiliotteet")
        let labels = rows.allElementsBoundByIndex.map(\.label)
        note("INFO stability 22: \(labels)")
        // "Tiliote · Lokakuu 2026, …": the title's month, said once in the row.
        var byMonth: [String: [String]] = [:]
        for label in labels {
            let title = String(label.prefix { $0 != "," })
            let month = String(title.dropFirst("Tiliote · ".count))
            byMonth[month, default: []].append(label)
            XCTAssertEqual(label.components(separatedBy: month).count - 1, 1, "the row says \(month) more than once: \(label)")
            XCTAssertTrue(label.contains(".csv"), "the row does not name its file: \(label)")
        }
        let shared = byMonth.filter { $0.value.count > 1 }
        XCTAssertFalse(shared.isEmpty, "no month with several files to tell apart (the --ci seed has three): \(labels)")
        for (month, same) in shared {
            XCTAssertEqual(Set(same).count, same.count, "files of \(month) read alike: \(same)")
        }
    }

    /// X180 (P4): the books are 'Tulos ja tase', not a second 'Kirjanpito' inside the Kirjanpito tab.
    func test23_LedgerHasItsOwnName() {
        guard selectTab("Kirjanpito"), app.navigationBars["Kirjanpito"].waitForExistence(timeout: 10) else {
            XCTFail("Kirjanpito did not open"); return
        }
        // Scrolled to: the row is the hub's last, under the tab bar at first.
        guard let row = firstReachable("label BEGINSWITH %@", "Tulos ja tase, ") else {
            dump(app, "stability-23-hub"); XCTFail("the Kirjanpito hub has no 'Tulos ja tase' row"); return
        }
        let doubles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kirjanpito, "))
        XCTAssertEqual(doubles.count, 0, "a row on the Kirjanpito hub is called Kirjanpito: \(doubles.allElementsBoundByIndex.map { $0.label })")
        row.tap(); taps += 1
        XCTAssertTrue(app.navigationBars["Tulos ja tase"].waitForExistence(timeout: 10), "the row did not open 'Tulos ja tase'")
        shot("stability-23-ledger")
        backToBooks("Tulos ja tase")
    }

    /// The first element matching, scrolled into the window as `tapLabel` does, without tapping it.
    private func firstReachable(_ format: String, _ arg: String) -> XCUIElement? {
        let element = app.descendants(matching: .any).matching(NSPredicate(format: format, arg)).firstMatch
        return reveal(element, scrolls: 6) ? element : nil
    }

    /// A receipt whose bank row has the same amount but another name lists that row and links it
    /// with one tap (seed: "ABC Prisma Kotka" / "KSO ABC Sahkonlataus", 9,43 €).
    func test08_SameAmountRowIsOfferedOnTheReceipt() {
        openHubRow("Kuitit"); sleep(2)
        XCTAssertTrue(tapLabel("label BEGINSWITH %@", "ABC Prisma Kotka"), "seeded receipt missing")
        sleep(3)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "KSO ABC Sahkonlataus")).firstMatch
        // U087: whole above the floating tab bar, so the shots show it and then the unlink button.
        // A row half under the bar counted as hittable: the loop never scrolled.
        let offered = revealAboveTabs(row)
        shot("stability-same-amount-candidate")
        XCTAssertTrue(row.exists, "the same-amount bank row is not offered")
        XCTAssertTrue(offered, "the same-amount bank row is not whole above the tab bar")
        row.tap(); taps += 1
        let unlink = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Poista kohdistus")).firstMatch
        XCTAssertTrue(unlink.waitForExistence(timeout: 10), "tapping the row did not link it")
        XCTAssertTrue(revealAboveTabs(unlink), "Poista kohdistus is not whole above the tab bar")
        shot("stability-same-amount-linked")
        assertResponsive("receipt linked")
    }

    /// Scrolls (each swipe counted) until `element` lies whole between the window's top and the
    /// floating tab bar: XCTest counts a row half under the bar as hittable (U087).
    func revealAboveTabs(_ element: XCUIElement, scrolls maxScrolls: Int = 6) -> Bool {
        let window = app.windows.firstMatch
        let tabs = app.tabBars.firstMatch
        func placed() -> Bool {
            guard element.exists, element.isHittable else { return false }
            let bottom = tabs.exists ? min(tabs.frame.minY, window.frame.maxY) : window.frame.maxY - 60
            return element.frame.minY > window.frame.minY + 30 && element.frame.maxY <= bottom
        }
        _ = element.waitForExistence(timeout: 5)
        for attempt in 0...maxScrolls {
            if placed() { return true }
            if attempt < maxScrolls { window.swipeUp(velocity: .slow); scrolls += 1 }
        }
        return false
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
        // The row's badge says "Myöhässä" and its line the due date, no longer "myöhässä" too (N6).
        guard tapLabel("label CONTAINS 'Myöhässä' AND label CONTAINS %@", "· eräpäivä"), invoice.waitForExistence(timeout: 20) else {
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

    /// X027 (N6): a customer's own invoice list printed the invoice date with no label ('Lasku 2' over
    /// '3.9.2026') where Myynti prints the labelled due date ('eräpäivä 3.10.2026'), so one invoice
    /// read as two days. The customer's row now says what Myynti's says.
    func test26_CustomerInvoiceRowSaysItsDueDate() {
        guard let late = overdueInvoice() else { XCTFail("the demo API lists no overdue invoice"); return }
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        let customers = app.navigationBars["Asiakkaat"]
        guard tapLabel("label == %@", "Asiakkaat"), customers.waitForExistence(timeout: 10) else {
            dump(app, "stability-26-no-customers"); XCTFail("Myynti > Asiakkaat did not open"); return
        }
        let customer = app.navigationBars[late.customer]
        guard tapLabel("label BEGINSWITH %@", late.customer), customer.waitForExistence(timeout: 15) else {
            dump(app, "stability-26-no-customer"); XCTFail("Asiakkaat > \(late.customer) did not open"); return
        }
        let line = "Lasku \(late.number) · eräpäivä \(late.due)"
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
        var found = row.waitForExistence(timeout: 10)
        // The invoices come after the contact rows and the totals.
        for _ in 0..<4 where !found {
            app.windows.firstMatch.swipeUp(velocity: .slow); scrolls += 1
            found = row.waitForExistence(timeout: 2)
        }
        shot("stability-26-customer")
        if !found { dump(app, "stability-26-customer") }
        XCTAssertTrue(found, "\(late.customer): no invoice row says '\(line)'")
        let bare = app.staticTexts.matching(NSPredicate(format: "label == %@", late.issue))
        XCTAssertEqual(bare.count, 0, "\(late.customer): an invoice row still prints the bare invoice date \(late.issue)")
    }

    /// X029 (N6): Asiakkaat's "+" opened a menu of Uusi asiakas and Tuo CSV, two taps for the screen's
    /// primary. One tap on Uusi asiakas opens the form; the import is in Toiminnot.
    func test27_CustomersPlusAddsOne() {
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        let customers = app.navigationBars["Asiakkaat"]
        guard tapLabel("label == %@", "Asiakkaat"), customers.waitForExistence(timeout: 10) else {
            dump(app, "stability-27-no-customers"); XCTFail("Myynti > Asiakkaat did not open"); return
        }
        let add = customers.buttons["Uusi asiakas"]
        guard add.waitForExistence(timeout: 10) else {
            dump(app, "stability-27-bar"); XCTFail("Asiakkaat's bar has no Uusi asiakas"); return
        }
        add.tap(); taps += 1
        let form = app.navigationBars["Uusi asiakas"]
        XCTAssertTrue(form.waitForExistence(timeout: 10), "one tap on Uusi asiakas did not open the form")
        shot("stability-27-form")
        form.buttons["Peruuta"].firstMatch.tap(); taps += 1
        XCTAssertTrue(form.waitForNonExistence(timeout: 10), "Peruuta did not close the untouched form")

        let actions = customers.buttons["Toiminnot"]
        guard actions.waitForExistence(timeout: 5) else { dump(app, "stability-27-bar"); XCTFail("Asiakkaat's bar has no Toiminnot"); return }
        actions.tap(); taps += 1
        let csv = app.buttons["Tuo CSV"].firstMatch
        guard csv.waitForExistence(timeout: 5) else { dump(app, "stability-27-menu"); XCTFail("Toiminnot has no Tuo CSV"); return }
        csv.tap(); taps += 1
        let sheet = app.navigationBars["Tuo asiakkaita"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Toiminnot > Tuo CSV did not open the import sheet")
        shot("stability-27-import")
        sheet.buttons["Peruuta"].firstMatch.tap(); taps += 1
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Peruuta did not close the import sheet")
    }

    /// F008: a customer opens on what its Asiakkaat row already says. It opened on a blank 'Asiakas'
    /// page with a spinner, and about 0.9 s later the page came at once and the title changed to the
    /// name (motion gates 39380209526, 39489886880, 39525842170). Opened offline, the first look is
    /// what the push had before any answer: the name in the bar, Toiminnot, the contact rows, no
    /// spinner or failure page. Online again, the invoices come under rows that stay put.
    func test33_CustomerOpensOnItsRow() {
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        let customers = app.navigationBars["Asiakkaat"]
        guard tapLabel("label == %@", "Asiakkaat"), customers.waitForExistence(timeout: 10) else {
            dump(app, "stability-33-no-customers"); XCTFail("Myynti > Asiakkaat did not open"); return
        }
        // The seed's Kauneus Oy (demo-seed.ts): laskut@kauneus.example, two invoices.
        let name = "Kauneus Oy"
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        guard row.waitForExistence(timeout: 15) else {
            dump(app, "stability-33-no-row"); XCTFail("Asiakkaat lists no \(name)"); return
        }
        goOffline()
        guard tapLabel("label BEGINSWITH %@", name) else { XCTFail("\(name) could not be tapped"); return }
        let pushed = app.navigationBars.matching(NSPredicate(format: "identifier IN %@", [name, "Asiakas"])).firstMatch
        guard pushed.waitForExistence(timeout: 10) else {
            dump(app, "stability-33-not-opened"); XCTFail("\(name) did not open from Asiakkaat"); return
        }
        let asked = Date()
        let picture = requestShot("stability-33-first-look")
        let title = pushed.identifier
        let actions = pushed.buttons["Toiminnot"].exists
        let spinner = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Ladataan")).firstMatch.exists
        let failurePage = app.buttons["load-failure-retry"].firstMatch.exists
        let email = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "laskut@kauneus.example")).firstMatch
        let contact = email.exists
        // Above the invoices and under them: where they stand once they have come.
        let terms = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Maksuaika")).firstMatch
        let byStatus = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Näytä tilan mukaan")).firstMatch
        let banner = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@ OR label BEGINSWITH %@",
                                                                           "Ei verkkoyhteyttä", "Palvelimeen ei saada yhteyttä", "Palvelin ei vastannut ajoissa")).firstMatch
        // The offline answer can already be in (its banner then stands above every row): the places
        // are compared only from a first look without it.
        let bannerAtFirst = banner.exists
        let termsAt: CGFloat? = terms.exists ? terms.frame.minY : nil
        let byStatusAt: CGFloat? = byStatus.exists ? byStatus.frame.minY : nil
        awaitShot(picture, since: asked)
        let termsText = termsAt.map { "\($0)" } ?? "none"
        let byStatusText = byStatusAt.map { "\($0)" } ?? "none"
        note("INFO stability 33 first look: title '\(title)', Toiminnot \(actions), spinner \(spinner), failure page \(failurePage), e-mail \(contact), banner \(bannerAtFirst), Maksuaika at \(termsText), Näytä tilan mukaan at \(byStatusText)")
        XCTAssertEqual(title, name, "the push opened on '\(title)': the title changes to the name when the customer loads")
        XCTAssertTrue(actions, "the bar has no Toiminnot at first: it comes with the customer and the bar changes")
        XCTAssertFalse(spinner, "the push landed on a spinner page")
        XCTAssertFalse(failurePage, "offline, the push landed on a failure page, not on the customer's row")
        XCTAssertTrue(contact, "the first look has no contact row (laskut@kauneus.example)")

        // Offline the invoices cannot come: the row stays under the refresh banner.
        if !banner.waitForExistence(timeout: 20) { note("INFO stability 33: no refresh banner within 20 s (Asiakkaat had warmed the customer)") }
        XCTAssertTrue(app.navigationBars[name].exists, "offline, the title left the name")
        XCTAssertTrue(email.exists, "offline, the failed load took the contact rows away")
        XCTAssertFalse(app.buttons["load-failure-retry"].firstMatch.exists, "offline, the failed load replaced the customer with a failure page")

        goOnline()
        // Back online the page reloads by itself (RetryWhenBackOnline, as Myynti in P3 A); the
        // banner's retry only if it has not after 30 s.
        let invoice = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Lasku ")).firstMatch
        if !invoice.waitForExistence(timeout: 30) {
            let retry = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Yritä uudelleen")).firstMatch
            note("INFO stability 33: no invoices 30 s after going online (Yritä uudelleen offered: \(retry.exists))")
            if retry.exists { retry.tap(); taps += 1 }
        }
        guard invoice.waitForExistence(timeout: 20) else {
            dump(app, "stability-33-no-invoices"); XCTFail("\(name)'s invoices never came"); return
        }
        XCTAssertTrue(banner.waitForNonExistence(timeout: 10), "the refresh banner stayed once the invoices came")
        waitStill(terms)
        shot("stability-33-loaded")
        XCTAssertTrue(app.navigationBars[name].exists, "the title changed when the customer loaded")
        guard !bannerAtFirst else { note("INFO stability 33: the banner was up at the first look; places not compared"); return }
        if let termsAt {
            note("INFO stability 33: Maksuaika at \(termsAt) on opening, \(terms.frame.minY) once loaded")
            XCTAssertEqual(terms.frame.minY, termsAt, accuracy: 1, "Maksuaika moved from \(termsAt) to \(terms.frame.minY) when the invoices came")
        } else {
            XCTFail("the first look had no Maksuaika row")
        }
        // Below the fold with a longer seed: nothing on the screen to hold still.
        if let byStatusAt, byStatus.exists {
            note("INFO stability 33: Näytä tilan mukaan at \(byStatusAt) on opening, \(byStatus.frame.minY) once loaded")
            XCTAssertEqual(byStatus.frame.minY, byStatusAt, accuracy: 1,
                           "Näytä tilan mukaan moved from \(byStatusAt) to \(byStatus.frame.minY): the greyed invoices did not hold their place")
        }
    }

    /// The seed's overdue invoice from the demo API: its number, its customer, and its due and
    /// invoice days as the app prints them. Test values from app/scripts/demo-seed.ts; only ever
    /// against the throwaway local server (the runner shares the Mac's loopback).
    private func overdueInvoice() -> (number: Int, customer: String, due: String, issue: String)? {
        func call(_ path: String, _ body: [String: String]?, _ token: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
            request.cachePolicy = .reloadIgnoringLocalCacheData
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
        // "2026-10-03" as the app prints a day: "3.10.2026".
        func shown(_ iso: String) -> String {
            let parts = iso.prefix(10).split(separator: "-").compactMap { Int($0) }
            return parts.count == 3 ? "\(parts[2]).\(parts[1]).\(parts[0])" : iso
        }
        guard let token = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String,
              let invoices = call("/api/invoices", nil, token)?["invoices"] as? [[String: Any]],
              let late = invoices.first(where: { $0["displayStatus"] as? String == "overdue" }),
              let number = late["number"] as? Int,
              let customer = (late["customer"] as? [String: Any])?["name"] as? String,
              let due = late["dueDate"] as? String, let issue = late["issueDate"] as? String else { return nil }
        return (number, customer, shown(due), shown(issue))
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
        // X084 (P5): titled in words, no longer by the API's type key ('profit-loss-2026.csv').
        let csv = app.navigationBars["Tuloslaskelma \(today.year)"]
        XCTAssertTrue(csv.waitForExistence(timeout: 15), "Tuloslaskelma did not open its CSV sheet titled 'Tuloslaskelma \(today.year)'")
        shot("stability-raportit-csv")
        // M047 (P5): a document sheet closes from its bar, not by a swipe alone.
        let done = csv.buttons["Valmis"]
        XCTAssertTrue(done.exists, "the CSV sheet has no Valmis")
        guard done.exists else { return }
        done.tap(); taps += 1
        XCTAssertTrue(csv.waitForNonExistence(timeout: 10), "Valmis did not close the CSV sheet")
    }

    /// M047 (P5): the zip opens on its own summary, its name, its size and 'Jaa kirjanpitäjälle' as
    /// the one primary, with Valmis to close. QuickLook drew a spinner, then a blank page with only
    /// a share icon for over 3 s, and the sheet closed by a swipe alone.
    func test31_ZipPackageSheet() {
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        let zip = app.buttons["Lataa zip"].firstMatch
        guard app.staticTexts["Kuukausittain"].firstMatch.waitForExistence(timeout: 15), reveal(zip, scrolls: 8) else {
            dump(app, "stability-31-no-zip"); XCTFail("Lataa zip is not hittable on Raportit"); return
        }
        // Kausi opens on last month, or on January when last month was another year.
        let today = Self.helsinkiMonth()
        let last = Self.helsinkiMonth(offset: -1)
        let key = last.year == today.year ? String(format: "%04d-%02d", last.year, last.month) : "\(today.year)-01"
        let name = "kirjanpito-\(key).zip"
        zip.tap(); taps += 1
        let bar = app.navigationBars[name]
        guard bar.waitForExistence(timeout: 10) else { dump(app, "stability-31-sheet"); XCTFail("Lataa zip did not open \(name)"); return }
        // The summary stands from the first frame; its primary wakes once the file is here.
        let share = app.buttons["Jaa kirjanpitäjälle"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 5), "the zip sheet has no Jaa kirjanpitäjälle")
        let arrived = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: share)], timeout: 20)
        XCTAssertEqual(arrived, .completed, "Jaa kirjanpitäjälle never woke: the package did not arrive")
        let size = app.staticTexts["document-zip-size"].firstMatch
        XCTAssertTrue(size.exists && size.label.contains(where: \.isNumber), "the summary gives no size: '\(size.exists ? size.label : "missing")'")
        let named = app.staticTexts.matching(NSPredicate(format: "label == %@", name)).count - bar.staticTexts.matching(NSPredicate(format: "label == %@", name)).count
        XCTAssertGreaterThan(named, 0, "the summary does not name \(name)")
        XCTAssertTrue(share.isHittable, "Jaa kirjanpitäjälle is not hittable")
        // One primary: the bar holds Valmis only, no share icon beside the summary's own.
        XCTAssertEqual(barItems(bar), ["Valmis"], "the zip sheet's bar holds \(barItems(bar))")
        shot("stability-31-zip")
        guard bar.buttons["Valmis"].exists else { return }
        bar.buttons["Valmis"].tap(); taps += 1
        XCTAssertTrue(bar.waitForNonExistence(timeout: 10), "Valmis did not close the zip sheet")
        XCTAssertTrue(app.navigationBars["Raportit"].exists, "Valmis did not return to Raportit")
    }

    /// X154 (P5): on Tietosuoja with no password typed, both requests say what is missing and send
    /// nothing. Disabled, they looked like live rows and a tap did nothing.
    func test32_PrivacyRequestsAskForThePassword() {
        openSettings()
        let screen = app.navigationBars["Tietosuoja"]
        let hint = app.staticTexts["Kirjoita nykyinen salasana."].firstMatch
        // The server's notes: 'Pyyntö kopiosta on kirjattu. …' and 'Pyyntö on kirjattu. …'.
        let sent = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Pyyntö", "kirjattu")).firstMatch
        let closing = app.navigationBars["Pyydetäänkö tilin sulkemista?"]
        for (index, title) in ["Pyydä kopio tiedoista", "Pyydä tilin sulkemista"].enumerated() {
            // Each request on a fresh screen: the first one's hint must not answer for the second.
            if index > 0 {
                screen.buttons["BackButton"].firstMatch.tap(); taps += 1
                XCTAssertTrue(screen.waitForNonExistence(timeout: 10), "Tietosuoja did not close")
            }
            guard tap("Tietosuoja"), screen.waitForExistence(timeout: 10) else { XCTFail("Tietosuoja did not open"); return }
            let password = app.secureTextFields["Nykyinen salasana"].firstMatch
            XCTAssertTrue(reveal(password, scrolls: 8), "Tietosuoja has no Nykyinen salasana")
            XCTAssertTrue((password.value as? String ?? "").isEmpty || password.value as? String == "Nykyinen salasana",
                          "the password field is not empty: the step tests nothing")
            XCTAssertFalse(hint.exists, "\(title): the hint shows before the tap")
            let button = app.buttons[title].firstMatch
            // Asetukset is a sheet: the closing request is the list's last row, 54 pt above the
            // window's foot with no tab bar under it (run 39538188381 dump: 768-820 of 874).
            guard reveal(button, scrolls: 8, bottomBar: 34) else { dump(app, "stability-32-\(index)"); XCTFail("Tietosuoja has no \(title)"); return }
            button.tap(); taps += 1
            XCTAssertTrue(hint.waitForExistence(timeout: 5), "\(title) with no password did not say 'Kirjoita nykyinen salasana.'")
            XCTAssertFalse(sent.exists, "\(title) with no password sent the request")
            XCTAssertFalse(closing.exists, "\(title) with no password opened the closing sheet")
            shot("stability-32-\(index)")
        }
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

    /// F012: a Luokittain swap at the end of Raportit holds the page still. With the page ending
    /// under Lataa zip (X078), Menot (3 rows in the --ci seed) to Tulot (2) shrank the page under its
    /// scroll offset: the List clamped it, and the picker with everything above the rows slid a row
    /// down under the finger while Lataa zip, at the page's foot, stayed (motion gates 39580643433
    /// and 39636460950: SCROLLJUMP dy=-66). Back to Menot, Lataa zip fell a row. Away from the end
    /// nothing is held: Kirjanpitopaketti follows the shorter list up, with no blank room under it.
    /// The end is reached as the motion walk reaches it (raportit-scroll): flung there, not scrolled
    /// until Lataa zip shows.
    func test33_RaportitCategorySwapHoldsThePage() {
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        let zip = app.buttons["Lataa zip"].firstMatch
        guard app.staticTexts["Kuukausittain"].firstMatch.waitForExistence(timeout: 15) else {
            dump(app, "stability-33-no-report"); XCTFail("Raportit shows no report"); return
        }
        let window = app.windows.firstMatch
        for _ in 0..<4 where !(zip.exists && zip.isHittable) {
            window.swipeUp(velocity: .fast); scrolls += 1
            _ = zip.waitForExistence(timeout: 3)
        }
        guard zip.exists, zip.isHittable else {
            dump(app, "stability-33-no-zip"); XCTFail("Lataa zip is not hittable on Raportit after 4 flings"); return
        }
        // To the end, where the motion walk's fling left the page: only there has the offset nowhere
        // to go, so one more swipe must move nothing.
        window.swipeUp(velocity: .fast); scrolls += 1
        waitStill(zip)
        let endY = zip.frame.minY
        window.swipeUp(velocity: .slow); scrolls += 1
        waitStill(zip)
        XCTAssertEqual(zip.frame.minY, endY, accuracy: 1, "Raportit was not at its end: the swaps below would prove nothing")
        // The swap comes after a fling, as in the walk.
        window.swipeUp(velocity: .fast); scrolls += 1
        waitStill(zip)
        let picker = app.segmentedControls.firstMatch
        guard picker.exists, picker.isHittable else {
            dump(app, "stability-33-no-picker"); XCTFail("Luokittain has no picker on screen at the end of Raportit (the seed books Tulot and Menot)"); return
        }
        // Shrinking first (the seed opens on Menot, the longer list), then growing back.
        for pass in 1...2 {
            let other = picker.buttons.matching(NSPredicate(format: "selected == false")).firstMatch
            guard other.exists else { dump(app, "stability-33-segment-\(pass)"); XCTFail("pass \(pass): Luokittain has no other segment"); return }
            let name = other.label
            let pickerY = picker.frame.minY
            let zipY = zip.frame.minY
            other.tap(); taps += 1
            // Polled through the swap, not read once after it: the clamp landed with the segment's lens.
            var pickerDrift: CGFloat = 0
            var zipDrift: CGFloat = 0
            let deadline = Date().addingTimeInterval(2.5)
            repeat {
                pickerDrift = max(pickerDrift, abs(picker.frame.minY - pickerY))
                zipDrift = max(zipDrift, abs(zip.frame.minY - zipY))
                usleep(100_000)
            } while Date() < deadline
            waitStill(zip)
            pickerDrift = max(pickerDrift, abs(picker.frame.minY - pickerY))
            zipDrift = max(zipDrift, abs(zip.frame.minY - zipY))
            note("INFO stability 33 pass \(pass): to \(name) the picker moved \(pickerDrift) pt, Lataa zip \(zipDrift) pt")
            XCTAssertTrue(picker.buttons[name].isSelected, "pass \(pass): \(name) is not selected after its tap")
            XCTAssertLessThanOrEqual(pickerDrift, 1, "pass \(pass): to \(name) the picker moved \(pickerDrift) pt under the finger")
            XCTAssertLessThanOrEqual(zipDrift, 1, "pass \(pass): to \(name) Lataa zip moved \(zipDrift) pt")
            XCTAssertTrue(picker.isHittable, "pass \(pass): the picker left the screen after \(name)")
            shot("stability-33-\(name.lowercased())")
        }

        // Away from the end, back on Menot: the page has room below to take the shorter list, so no
        // room is held and the header after the rows sits as far under the last row as before.
        let header = app.staticTexts["Kirjanpitopaketti"].firstMatch
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", " kpl"))
        func gapUnderRows() -> CGFloat? {
            let top = picker.frame.maxY
            let headerTop = header.frame.minY
            let bottoms = rows.allElementsBoundByIndex.map(\.frame).filter { $0.minY > top && $0.maxY <= headerTop + 1 }.map(\.maxY)
            return bottoms.max().map { headerTop - $0 }
        }
        guard header.exists else { dump(app, "stability-33-no-header"); XCTFail("Raportit has no Kirjanpitopaketti header"); return }
        let headerEndY = header.frame.minY
        // Down by less than the room under the header, so the rows and the header stay on screen.
        let drag = min(150, window.frame.maxY - 40 - header.frame.maxY)
        guard drag >= 100 else {
            dump(app, "stability-33-header-low"); XCTFail("Kirjanpitopaketti sits at \(header.frame.maxY): no room to drag Raportit off its end"); return
        }
        // From the rows, clear of the picker, and held before the release, so the page stops where
        // the finger does instead of gliding on.
        let from = window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: window.frame.midX, dy: (picker.frame.maxY + header.frame.minY) / 2))
        from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: drag)), withVelocity: .slow, thenHoldForDuration: 0.3)
        scrolls += 1
        waitStill(header)
        let away = header.frame.minY - headerEndY
        let other = picker.buttons.matching(NSPredicate(format: "selected == false")).firstMatch
        // More than the row Tulot is short of Menot (66 pt): the page then has room to give it back.
        guard away >= 90, other.exists, let gap = gapUnderRows() else {
            dump(app, "stability-33-away"); XCTFail("away from the end: Raportit moved \(away) pt, or Luokittain shows no other segment or no rows"); return
        }
        let name = other.label
        let pickerY = picker.frame.minY
        let headerBefore = header.frame.minY
        other.tap(); taps += 1
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: picker.buttons[name])
        XCTAssertEqual(XCTWaiter().wait(for: [selected], timeout: 5), .completed, "away: \(name) is not selected after its tap")
        waitStill(header)
        guard let after = gapUnderRows() else { dump(app, "stability-33-away-after"); XCTFail("away: no rows under Luokittain after \(name)"); return }
        note("INFO stability 33 away \(away) pt: to \(name) the gap under the rows went \(gap) -> \(after) pt, the header moved \(header.frame.minY - headerBefore) pt")
        XCTAssertLessThan(header.frame.minY, headerBefore - 30, "away: \(name) did not make the list shorter, so the gap check proves nothing")
        XCTAssertEqual(after, gap, accuracy: 1, "away from the end, \(name) left \(after - gap) pt of blank room under its last row")
        XCTAssertEqual(picker.frame.minY, pickerY, accuracy: 1, "away from the end, the picker moved on the swap to \(name)")
        shot("stability-33-away-\(name.lowercased())")
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

    /// Opens ALV and then reads nothing for 25 s: the probe's STALL lines tell whether ALV blocks
    /// the main thread, without the test's accessibility queries in the way (U086). The event log's
    /// hang watchdog was never read by the test, so a hang still passed.
    func test07_AlvLeftAlone() {
        let log = relaunchWithProbe("test07")
        XCTAssertTrue(selectTab("Kirjanpito"), "Kirjanpito is not selected")
        let since = Date().timeIntervalSince1970
        XCTAssertTrue(tap("ALV-ilmoitus"), "Kirjanpito has no ALV-ilmoitus")
        let opened = app.navigationBars["ALV-ilmoitus"].waitForExistence(timeout: 15)
        XCTAssertTrue(opened, "ALV-ilmoitus did not open")
        note("MARK alv-open \(Date().formatted(.iso8601))")
        sleep(25)
        note("MARK alv-end \(Date().formatted(.iso8601))")
        assertAlvNotStalled(log, from: since, to: Date().timeIntervalSince1970, "alv left alone")
        XCTAssertEqual(app.state, .runningForeground)
        let figure = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Maksettava ALV", "Palautettava ALV"])).firstMatch
        XCTAssertTrue(opened && figure.exists, "ALV shows no Maksettava ALV or Palautettava ALV after 25 s")
        shot("stability-alv-left-alone")
    }

    /// The app again with MotionProbe on (`-LKMotionAudit`, Debug builds), writing to a log of this
    /// test's own, which starts empty. Its STALL lines are the main thread's own gaps.
    func relaunchWithProbe(_ name: String) -> String {
        let log = "\(shotDir)/probe-\(name).log"
        try? FileManager.default.removeItem(atPath: log)
        app.terminate()
        app.launchArguments.append("-LKMotionAudit")
        app.launchEnvironment["LK_MOTION_LOG"] = log
        launchSignedIn()
        dismissSystemPrompts()
        return log
    }

    /// X181: ALV appeared (the probe's SCREEN line) and never held the main thread 3 s or more
    /// between `from` and `to` (epoch seconds): its STALL lines, the push and the reads included.
    func assertAlvNotStalled(_ log: String, from: Double, to: Double, _ step: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let lines = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").map { $0.split(separator: " ") }
        // 'SCREEN <t> alv("")', 'STALL <t> alv("") ms=<ms>': the route's name as Route describes it.
        let screens = lines.filter { $0.count >= 3 && $0[0] == "SCREEN" && $0[2].hasPrefix("alv") }
        XCTAssertFalse(screens.isEmpty, "\(step): the probe saw no ALV screen (a Debug build with -LKMotionAudit writes \(log))",
                       file: file, line: line)
        let stalls = lines.compactMap { parts -> Int? in
            guard parts.count >= 4, parts[0] == "STALL", parts[2].hasPrefix("alv"), let t = Double(parts[1]), t >= from, t <= to,
                  parts[3].hasPrefix("ms=") else { return nil }
            return Int(parts[3].dropFirst(3))
        }
        note("INFO \(step): ALV stalls \(stalls) ms")
        XCTAssertLessThan(stalls.max() ?? 0, 3000, "\(step): ALV held the main thread \(stalls.max() ?? 0) ms", file: file, line: line)
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

        // Ostolaskut: the CI seed's rent bill, filed as an ostolasku. Valitse is in Toiminnot from
        // the first frame (B6) and picks once the bills are in, which the Toistuvat row's count comes with.
        openHubRow("Ostolaskut")
        let purchases = app.navigationBars["Ostolaskut"]
        let purchaseActions = purchases.buttons["Toiminnot"].firstMatch
        guard purchaseActions.waitForExistence(timeout: 15), purchasesLoaded(under: purchases) else {
            dump(app, "stability-14-ostolaskut"); XCTFail("Ostolaskut has no Toiminnot, or its bills did not arrive"); return
        }
        purchaseActions.tap(); taps += 1
        let pick = app.buttons["Valitse"].firstMatch
        guard pick.waitForExistence(timeout: 5), pick.isEnabled else { dump(app, "stability-14-ostolaskut"); XCTFail("Ostolaskut has no Valitse"); return }
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

    /// X041 X064 (P3): the bulk bar and the toast are opaque ink. At 0.94 the rows under them read
    /// through their words; an empty spot of either measured (51,47,44), not ink (38,34,31).
    func test30_BulkBarAndToastAreOpaque() {
        let ink = RGB(r: 38, g: 34, b: 31)
        openHubRow("Kuitit")
        let chips = app.buttons["receipt-tab-all"].firstMatch
        let actions = app.navigationBars["Kuitit"].buttons["Toiminnot"].firstMatch
        guard chips.waitForExistence(timeout: 15), actions.waitForExistence(timeout: 15) else {
            dump(app, "stability-30-kuitit"); XCTFail("Kuitit opened without its chips or Toiminnot"); return
        }
        // The bulk bar over the list, as test14 brings it up.
        actions.tap(); taps += 1
        let select = app.buttons["Valitse kuitteja"].firstMatch
        guard select.waitForExistence(timeout: 5) else { dump(app, "stability-30-menu"); XCTFail("Toiminnot has no Valitse kuitteja"); return }
        select.tap(); taps += 1
        guard app.buttons["Valitse kaikki"].firstMatch.waitForExistence(timeout: 5), let row = firstListRow(below: chips) else {
            dump(app, "stability-30-no-row"); XCTFail("Valitse kuitteja left no receipt row to pick"); return
        }
        row.tap(); taps += 1
        guard let bar = bulkBar("kuitit") else { return }
        // Its leading padding, beside the count: nothing of the bar's own is drawn there.
        let barRead = screenColours(app, at: [CGPoint(x: bar.frame.minX + 6, y: bar.frame.midY)]).first ?? nil
        shot("stability-30-bulk-bar")
        note("INFO stability 30: bulk bar \(bar.frame) reads \(barRead?.description ?? "off screen")")
        XCTAssertTrue(barRead?.near(ink, within: 2) == true, "the bulk bar reads \(barRead?.description ?? "off screen"), not ink \(ink)")
        endSelectMode(bar, "Kuitit", "kuitit")

        // The toast: Ei kohdistettu's Kohdista varmat, then its Kumoa, which puts the seed's pairs back.
        let unlinked = app.buttons["receipt-tab-unlinked"].firstMatch
        revealChip(unlinked, inRow: "receipt-chips")
        unlinked.tap(); taps += 1
        let sure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat")).firstMatch
        guard sure.waitForExistence(timeout: 20) else {
            dump(app, "stability-30-no-sure"); XCTFail("no Kohdista varmat on Ei kohdistettu: does the seed have its sure pairs?"); return
        }
        sure.tap(); taps += 1
        // "2 kuittia kohdistettu." (or a run that stopped early); not a row's "Ei kohdistettu".
        let linked = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@ OR label ENDSWITH %@",
                                                          "kohdistettu.", "seuraavalla kerralla.")).firstMatch
        guard linked.waitForExistence(timeout: 20) else { dump(app, "stability-30-no-toast"); XCTFail("Kohdista varmat showed no toast"); return }
        // Inside the toast's 12 pt padding above its words. Read until the toast has risen whole: on
        // its way in it is still fading, and it goes by itself after five seconds.
        var toastRead: RGB?
        let deadline = Date().addingTimeInterval(5)
        repeat {
            guard linked.exists else { break }
            let words = linked.frame
            toastRead = screenColours(app, at: [CGPoint(x: words.midX, y: words.minY - 6)]).first ?? nil
            if toastRead?.near(ink, within: 2) == true { break }
        } while Date() < deadline && linked.exists
        // Kumoa first, while the toast is still up; the notes and the picture wait.
        let undo = app.buttons["Kumoa"].firstMatch
        let undoing = undo.exists
        if undoing { undo.tap(); taps += 1 }
        note("INFO stability 30: the toast reads \(toastRead?.description ?? "off screen")")
        XCTAssertTrue(toastRead?.near(ink, within: 2) == true, "the toast reads \(toastRead?.description ?? "off screen"), not ink \(ink)")
        guard undoing else { XCTFail("the toast went before its Kumoa: the seed's sure pairs stay linked"); return }
        let restored = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "kumottu")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 20), "Kumoa did not put the sure pairs back")
        shot("stability-30-toast-undone")
    }

    /// X092 (N9): the K-Market 1 row's sheet (Kuitti puuttuu) shows one primary, Kuvaa kuitti, on the
    /// medium detent without a scroll, and its Toiminnot holds the other four. Five rows of the same
    /// weight stood in the body, and the medium detent cut the last ones off.
    func test16_BankRowSheetHasOnePrimary() {
        openHubRow("Pankki")
        let anyRow = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.bankRow)).firstMatch
        XCTAssertTrue(anyRow.waitForExistence(timeout: 15), "Pankki shows no bank row")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "K-Market 1,")).firstMatch
        guard reveal(row) else {
            dump(app, "stability-16-no-row"); XCTFail("Pankki has no K-Market 1 row: is the seed demo-seed.ts --ci?"); return
        }
        XCTAssertTrue(row.label.contains("· Kuitti puuttuu, "), "K-Market 1 does not wait for a kuitti: \(row.label)")
        row.tap(); taps += 1
        let sheet = app.navigationBars["Kuitti puuttuu"]
        guard sheet.waitForExistence(timeout: 10) else { dump(app, "stability-16-no-sheet"); XCTFail("K-Market 1 did not open its sheet"); return }
        waitStill(sheet)
        let window = app.windows.firstMatch.frame
        // The medium detent: the sheet starts well down the screen, not under the status bar.
        XCTAssertGreaterThan(sheet.frame.minY, window.height / 3, "the sheet opened at \(sheet.frame.minY), not at the medium detent")
        guard let primary = reachable("Kuvaa kuitti") else {
            dump(app, "stability-16-no-primary"); XCTFail("the sheet has no Kuvaa kuitti a tap reaches"); return
        }
        note("INFO stability 16: sheet bar \(sheet.frame), Kuvaa kuitti \(primary.frame), window \(window)")
        XCTAssertTrue(primary.frame.minY > sheet.frame.maxY && primary.frame.maxY <= window.maxY,
                      "Kuvaa kuitti (\(primary.frame)) is not on the sheet's medium detent")
        let primaries = app.buttons.matching(NSPredicate(format: "label == %@", "Kuvaa kuitti")).allElementsBoundByIndex.filter { $0.isHittable }
        XCTAssertEqual(primaries.count, 1, "Kuvaa kuitti is on the sheet \(primaries.count) times")
        let others = ["Kuittia ei tarvita", "Kohdista ostolaskuun", "Etsi kuitti", "Avaa tiliote"]
        let inBody = others.filter { reachable($0, timeout: 0) != nil }
        XCTAssertEqual(inBody, [], "the sheet's body still has \(inBody)")
        shot("stability-bank-row-sheet")

        let actions = sheet.buttons["Toiminnot"].firstMatch
        guard actions.exists else { dump(app, "stability-16-no-toiminnot"); XCTFail("the sheet has no Toiminnot"); return }
        actions.tap(); taps += 1
        for label in others {
            XCTAssertNotNil(reachable(label), "Toiminnot has no \(label)")
        }
        shot("stability-bank-row-menu")
        // Closed by a tap on the bar's empty leading end, clear of the menu under the trailing button.
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Kuittia ei tarvita"].firstMatch.waitForNonExistence(timeout: 5), "Toiminnot did not close")
        sheet.buttons["Valmis"].firstMatch.tap(); taps += 1
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Valmis did not close the sheet")
    }

    /// X093 (N9): the Käyttötili sheet keeps Muokkaa and Poista in Toiminnot, not as two plain rows
    /// one above the other, and Poista still asks first. Its caption leaves the IBAN to the IBAN row:
    /// it repeated the list row word for word, masked IBAN included.
    func test21_AccountSheetActionsInToiminnot() {
        openHubRow("Pankki")
        XCTAssertTrue(tapLabel("label BEGINSWITH %@", "Saldo yhteensä"), "Pankki has no Saldo yhteensä row")
        guard app.navigationBars["Pankkiyhteys ja tilit"].waitForExistence(timeout: 15) else {
            dump(app, "stability-17-no-accounts"); XCTFail("Saldo yhteensä did not open Pankkiyhteys ja tilit"); return
        }
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Käyttötili,")).firstMatch
        guard reveal(row) else { dump(app, "stability-17-no-row"); XCTFail("Pankkiyhteys ja tilit has no Käyttötili row"); return }
        // "Käyttötili, <saldo>, <the row's line>": neither the saldo nor the line has a ", " of its own.
        let line = row.label.components(separatedBy: ", ").last ?? ""
        row.tap(); taps += 1
        let sheet = app.navigationBars["Käyttötili"]
        guard sheet.waitForExistence(timeout: 10) else { dump(app, "stability-17-no-sheet"); XCTFail("Käyttötili did not open its sheet"); return }
        waitStill(sheet)
        let caption = app.staticTexts["bank-account-caption"].firstMatch
        if caption.waitForExistence(timeout: 5) {
            note("INFO stability 17: list row line '\(line)', sheet caption '\(caption.label)'")
            XCTAssertNotEqual(caption.label, line, "the sheet's caption repeats the list row")
            XCTAssertFalse(caption.label.contains("••••"), "the caption repeats the masked IBAN over the IBAN row: \(caption.label)")
        } else {
            XCTFail("the sheet has no caption")
        }
        let inBody = ["Muokkaa", "Poista"].filter { reachable($0, timeout: 0) != nil }
        XCTAssertEqual(inBody, [], "the sheet's body still has \(inBody)")
        shot("stability-account-sheet")

        let actions = sheet.buttons["Toiminnot"].firstMatch
        guard actions.exists else { dump(app, "stability-17-no-toiminnot"); XCTFail("the sheet has no Toiminnot"); return }
        actions.tap(); taps += 1
        XCTAssertNotNil(reachable("Muokkaa"), "Toiminnot has no Muokkaa")
        guard let remove = reachable("Poista") else { dump(app, "stability-17-menu"); XCTFail("Toiminnot has no Poista"); return }
        shot("stability-account-menu")
        remove.tap(); taps += 1
        // The seed's account has tiliotteet, so a Poista that went through would archive it: only Peruuta here.
        let question = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        guard question.waitForExistence(timeout: 5) else { dump(app, "stability-17-no-question"); XCTFail("Poista did not ask first"); return }
        XCTAssertEqual(app.staticTexts["confirm-sheet-title"].firstMatch.label, "Poistetaanko pankkitili?")
        app.buttons["confirm-sheet-cancel"].firstMatch.tap(); taps += 1
        XCTAssertTrue(question.waitForNonExistence(timeout: 5), "Peruuta left the question up")
        XCTAssertTrue(sheet.exists, "Peruuta closed the account sheet")
        sheet.buttons["Valmis"].firstMatch.tap(); taps += 1
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Valmis did not close the sheet")
    }

    /// The button labelled `label` that a tap reaches, once there is one: not one behind a sheet or
    /// in another tab, which share its label. `timeout` 0 looks once.
    private func reachable(_ label: String, timeout: TimeInterval = 5) -> XCUIElement? {
        let buttons = app.buttons.matching(NSPredicate(format: "label == %@", label))
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let button = buttons.allElementsBoundByIndex.first(where: { $0.isHittable }) { return button }
            if timeout > 0 { usleep(250_000) }
        } while Date() < deadline
        return nil
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

    /// M072 M074 (B6): Ostolaskut's bar holds '+' and Toiminnot from the push to the settled page. It
    /// held Valitse, which came with the bills and moved the bar, and a repeat icon that opened the
    /// screen the 'Toistuvat ostolaskut' row opens; that row came with the list and pushed it down.
    /// Toiminnot holds Valitse and 'Hae ostolaskujen maksut pankista', which is no longer a row.
    func test28_PurchasesBarIsFixed() {
        openHubRow("Ostolaskut")
        let bar = app.navigationBars["Ostolaskut"]
        // At push, read first: the row is in the list (under the bar), not a bar item.
        let recurring = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Toistuvat ostolaskut"))
        let rowAtPush = recurring.allElementsBoundByIndex.contains { $0.frame.minY >= bar.frame.maxY - 1 }
        assertPurchasesBar(bar, "at push")
        XCTAssertTrue(rowAtPush, "at push: no Toistuvat ostolaskut row in the list")
        guard purchasesLoaded(under: bar) else {
            dump(app, "stability-28-not-loaded"); XCTFail("the Toistuvat ostolaskut row never showed its count"); return
        }
        assertPurchasesBar(bar, "after the load")
        shot("stability-ostolaskut-bar")
        XCTAssertFalse(app.buttons["Hae ostolaskujen maksut pankista"].exists, "the list still has its own Hae ostolaskujen maksut pankista row")
        bar.buttons["Toiminnot"].firstMatch.tap(); taps += 1
        let valitse = app.buttons["Valitse"].firstMatch
        XCTAssertTrue(valitse.waitForExistence(timeout: 5) && valitse.isHittable, "Toiminnot has no Valitse")
        XCTAssertTrue(valitse.isEnabled, "Valitse is off with the bills in")
        XCTAssertTrue(app.buttons["Hae ostolaskujen maksut pankista"].firstMatch.isHittable, "Toiminnot has no Hae ostolaskujen maksut pankista")
        dump(app, "stability-28-menu")
    }

    /// M071 (B6): Pankkiyhteys ja tilit opens in its final shape. It opened on a spinner, and 'Saldo
    /// yhteensä' and 'Kirjanpidon tilit' came in a beat later and pushed the page down 226 pt: too
    /// soon for a look from here, so the app says what its first frame was built from (`-LKUITest`).
    /// The first visit may draw the greyed shape; the second opens on what the first painted.
    func test29_BankAccountsFirstFrame() {
        app.terminate()
        app.launchArguments.append("-LKUITest")
        launchSignedIn()
        dismissSystemPrompts()
        openHubRow("Pankki")
        guard let first = openBankAccounts(1) else { return }
        XCTAssertTrue(["valmis", "paikka"].contains(first), "visit 1: the first frame did not show Saldo yhteensä (\(first))")
        guard let settled = assertTotalHolds(1) else { return }
        shot("stability-pankkiyhteys")
        app.navigationBars["Pankkiyhteys ja tilit"].buttons["BackButton"].firstMatch.tap(); taps += 1
        XCTAssertTrue(app.navigationBars["Pankki"].waitForExistence(timeout: 10), "Back did not return to Pankki")
        guard let second = openBankAccounts(2) else { return }
        XCTAssertEqual(second, "valmis", "visit 2: the first frame was not the accounts and connections painted on visit 1")
        _ = assertTotalHolds(2, opensAt: settled)
    }

    /// Ostolaskut's bar: '+' and Toiminnot beside Back, and no Toistuvat ostolaskut item (M074).
    private func assertPurchasesBar(_ bar: XCUIElement, _ moment: String, file: StaticString = #filePath, line: UInt = #line) {
        let items = barItems(bar).sorted()
        check("ostolaskut bar \(moment): items \(items)", items == ["Toiminnot", "Uusi ostolasku"])
        XCTAssertEqual(items, ["Toiminnot", "Uusi ostolasku"], "\(moment): the bar's items besides Back", file: file, line: line)
        XCTAssertFalse(bar.buttons["Toistuvat ostolaskut"].exists, "\(moment): the bar has a Toistuvat ostolaskut item", file: file, line: line)
    }

    /// Ostolaskut's bills are in: the Toistuvat ostolaskut row, in the list under the bar, shows its
    /// count, which comes in the same update as the bills.
    private func purchasesLoaded(under bar: XCUIElement, timeout: TimeInterval = 20) -> Bool {
        let counted = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Toistuvat ostolaskut, "))
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if counted.allElementsBoundByIndex.contains(where: { $0.frame.minY >= bar.frame.maxY - 1 }) { return true }
            usleep(250_000)
        } while Date() < deadline
        return false
    }

    /// From Pankki: its first row, once it shows its figure and its consent line (both answers are then
    /// in hand), opens Pankkiyhteys ja tilit. Returns what the screen's first frame was built from
    /// ("valmis": the accounts and the connections; "paikka": the greyed shape).
    private func openBankAccounts(_ visit: Int) -> String? {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Saldo yhteensä")).firstMatch
        // "Saldo yhteensä, 1 234,00 €, Tilit, saldot ja pankkiyhteys": the figure (or a dash), then the line.
        let painted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label MATCHES %@", "Saldo yhteensä, .*(€|–), .+"), object: row)
        guard row.waitForExistence(timeout: 15), XCTWaiter().wait(for: [painted], timeout: 20) == .completed else {
            dump(app, "stability-29-pankki-\(visit)"); XCTFail("visit \(visit): Pankki's first row shows no figure and consent line (\(row.exists ? row.label : "no row"))"); return nil
        }
        row.tap(); taps += 1
        guard app.navigationBars["Pankkiyhteys ja tilit"].waitForExistence(timeout: 10) else {
            dump(app, "stability-29-no-screen-\(visit)"); XCTFail("visit \(visit): Pankkiyhteys ja tilit did not open"); return nil
        }
        let opening = app.descendants(matching: .any).matching(identifier: "bank-accounts-opening").firstMatch
        guard opening.waitForExistence(timeout: 5) else {
            dump(app, "stability-29-no-marker-\(visit)")
            XCTFail("visit \(visit): the screen did not say what its first frame was (a Debug build launched with -LKUITest?)"); return nil
        }
        note("INFO stability 29 visit \(visit): first frame \(opening.label)")
        return opening.label
    }

    /// Saldo yhteensä on Pankkiyhteys ja tilit (its LabeledContent row, not Pankki's first row).
    private func bankAccountsTotal() -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "bank-accounts-total").firstMatch
    }

    /// Saldo yhteensä is on screen now (at `opensAt`, where an earlier visit left it) and stays at the
    /// same height once the server's accounts and connections are in. Returns its settled minY.
    private func assertTotalHolds(_ visit: Int, opensAt expected: CGFloat? = nil,
                                  file: StaticString = #filePath, line: UInt = #line) -> CGFloat? {
        let total = bankAccountsTotal()
        guard total.exists else {
            dump(app, "stability-29-no-total-\(visit)")
            XCTFail("visit \(visit): no Saldo yhteensä on Pankkiyhteys ja tilit", file: file, line: line); return nil
        }
        let before = total.frame.minY
        if let expected {
            XCTAssertEqual(before, expected, accuracy: 1, "visit \(visit): Saldo yhteensä opened at \(before), an earlier visit ended at \(expected)",
                           file: file, line: line)
        }
        let opening = app.descendants(matching: .any).matching(identifier: "bank-accounts-opening").firstMatch
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "ladattu"), object: opening)
        XCTAssertEqual(XCTWaiter().wait(for: [loaded], timeout: 20), .completed, "visit \(visit): the accounts and the connections did not load",
                       file: file, line: line)
        waitStill(total)
        let after = total.frame.minY
        note("INFO stability 29 visit \(visit): Saldo yhteensä at \(before) on opening, \(after) once loaded")
        XCTAssertEqual(after, before, accuracy: 1, "visit \(visit): Saldo yhteensä moved from \(before) to \(after) when the connections loaded",
                       file: file, line: line)
        return after
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

    /// X138 (N7): Lisää keeps its height. The mailbox screen grew the sheet to full height by code
    /// and Back left it there; each way out of ⋯ now returns the sheet to where it stood.
    func test23_LisaaKeepsItsHeight() {
        tab("Lisää")
        let bar = app.navigationBars["Lisää"]
        guard bar.waitForExistence(timeout: 10) else { dump(app, "stability-23-no-lisaa"); XCTFail("Lisää did not open"); return }
        waitStill(bar)
        let top = bar.frame.minY

        // The CI seed connects no mailbox, so ⋯ offers to connect one.
        if pickFromAddMenu(bar, "Yhdistä sähköposti") {
            let mail = app.navigationBars["Sähköpostien tuonti"]
            if mail.waitForExistence(timeout: 10) {
                waitStill(mail)
                shot("stability-23-mailbox")
                mail.buttons["BackButton"].firstMatch.tap(); taps += 1
                XCTAssertTrue(mail.waitForNonExistence(timeout: 10), "Back did not leave Sähköpostien tuonti")
                waitStill(bar)
                note("INFO stability 23: Lisää bar at \(top), back from the mailbox screen at \(bar.frame.minY)")
                XCTAssertEqual(bar.frame.minY, top, accuracy: 1, "Lisää changed its height around the mailbox screen")
            } else {
                dump(app, "stability-23-no-mailbox"); XCTFail("Yhdistä sähköposti did not open Sähköpostien tuonti")
            }
        } else { XCTFail("Lisää's ⋯ has no Yhdistä sähköposti") }

        if pickFromAddMenu(bar, "Tuo tiliote") {
            // The system's file picker, in whichever language it chose. Close and Sulje too: an icon
            // button, or the dimmed edge around the picker, leaves it as Cancel does.
            let cancel = app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancel", "Kumoa", "Peruuta", "Close", "Sulje"]))
            let covered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == false"), object: bar)
            if let button = hittable(cancel, last: true, timeout: 10) {
                button.tap(); taps += 1
            } else if XCTWaiter().wait(for: [covered], timeout: 2) == .completed {
                dump(app, "stability-23-picker")
                note("INFO stability 23: no Cancel found in the file picker; drawn down as a thumb would")
                let window = app.windows.firstMatch
                window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                    .press(forDuration: 0.1, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            } else {
                dump(app, "stability-23-no-picker"); XCTFail("Tuo tiliote did not open the file picker over Lisää")
            }
            let back = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: bar)
            XCTAssertEqual(XCTWaiter().wait(for: [back], timeout: 10), .completed, "the file picker did not leave Lisää")
            waitStill(bar)
            note("INFO stability 23: Lisää bar at \(top), after the file picker at \(bar.frame.minY)")
            XCTAssertEqual(bar.frame.minY, top, accuracy: 1, "Lisää changed its height around the file picker")
        } else { XCTFail("Lisää's ⋯ has no Tuo tiliote") }
        shot("stability-23-lisaa")
    }

    /// X139 (N7): a new invoice from Lisää closes in one movement. The form went down onto Lisää,
    /// which then went down too, and its actions showed between the two. Peruuta and Luo lasku now
    /// close through Lisää, which takes the form with it.
    func test24_LisaaInvoiceClosesOnce() {
        if openInvoiceFromAdd("Peruuta") {
            app.navigationBars["Uusi lasku"].buttons["Peruuta"].firstMatch.tap(); taps += 1
            // A form with changes asks first; Hylkää muutokset then closes it.
            assertClosesOnce(onto: app.tabBars.buttons["Koti"].firstMatch, within: 3,
                             answering: app.buttons["confirm-sheet-confirm"].firstMatch, "Peruuta")
        }

        guard openInvoiceFromAdd("Luo lasku"), fillNewInvoice() else { return }
        app.buttons["Luo lasku"].firstMatch.tap(); taps += 1
        let myynti = app.tabBars.buttons["Myynti"].firstMatch
        // The form waits for the server's answer before anything closes.
        assertClosesOnce(onto: myynti, within: 20, "Luo lasku")
        XCTAssertTrue(myynti.isSelected, "Luo lasku did not end on Myynti")
        let invoice = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        XCTAssertTrue(invoice.waitForExistence(timeout: 10), "Luo lasku did not open the new invoice")
        shot("stability-24-invoice")
    }

    /// N7: a statement imported from Lisää's ⋯ links to its rows. "Näytä tapahtumat ›" opens
    /// Kirjanpito > Pankki with the new row, and Lisää goes. A test cannot pick a file in the system's
    /// picker, so ⋯ has a statement fixture under `-LKUITest`. Last of the class: the row it brings is
    /// one more bank row without a receipt for any test after it.
    func test25_StatementImportLinksToItsRows() {
        app.terminate()
        app.launchArguments += ["-LKUITest", "-notifications.asked.v1", "YES"]
        launchSignedIn()
        dismissSystemPrompts()
        tab("Lisää")
        let bar = app.navigationBars["Lisää"]
        guard bar.waitForExistence(timeout: 10) else { dump(app, "stability-25-no-lisaa"); XCTFail("Lisää did not open"); return }
        guard pickFromAddMenu(bar, "Testitiliote") else {
            XCTFail("Lisää's ⋯ has no Testitiliote: is the app a Debug build launched with -LKUITest?"); return
        }
        let link = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Näytä tapahtumat ›")).firstMatch
        guard link.waitForExistence(timeout: 30) else {
            dump(app, "stability-25-no-link"); XCTFail("the import did not offer Näytä tapahtumat ›"); return
        }
        note("INFO stability 25: \(link.label)")
        XCTAssertTrue(link.label.hasPrefix("Tuotiin 1 tapahtumaa."), "the link reads \(link.label)")
        shot("stability-25-imported")
        link.tap(); taps += 1
        let pankki = app.navigationBars["Pankki"]
        XCTAssertTrue(pankki.waitForExistence(timeout: 15), "Näytä tapahtumat did not open Pankki")
        // The rows' screen (N2), not a screen that is only named Pankki.
        XCTAssertTrue(pankki.buttons["Toiminnot"].waitForExistence(timeout: 10), "Pankki opened without its rows' Toiminnot")
        XCTAssertTrue(bar.waitForNonExistence(timeout: 10), "Lisää stayed up over Pankki")
        XCTAssertTrue(app.tabBars.buttons["Kirjanpito"].firstMatch.isSelected, "Pankki opened outside Kirjanpito")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tiliotetesti ")).firstMatch
        let shown = row.waitForExistence(timeout: 15) || reveal(row, scrolls: 4)
        if !shown { dump(app, "stability-25-no-row") }
        XCTAssertTrue(shown, "Pankki does not show the imported row")
        shot("stability-25-pankki")
    }

    /// Lisää > Tuo tiliote with a file the app cannot open (the scope refused, or the file gone) did
    /// nothing and said nothing: the import returned silently. It now says "Tiedostoa ei voitu lukea."
    /// as any failed import does. A test cannot pick a file in the system's picker, so ⋯ has a fixture
    /// under `-LKUITest` that hands the import a statement file that is not there. It brings no row,
    /// so it can run anywhere in the class.
    func test34_UnreadableStatementSaysSo() {
        app.terminate()
        app.launchArguments += ["-LKUITest", "-notifications.asked.v1", "YES"]
        launchSignedIn()
        dismissSystemPrompts()
        tab("Lisää")
        let bar = app.navigationBars["Lisää"]
        guard bar.waitForExistence(timeout: 10) else { dump(app, "stability-34-no-lisaa"); XCTFail("Lisää did not open"); return }
        guard pickFromAddMenu(bar, "Testitiliote (ei luettavissa)") else {
            XCTFail("Lisää's ⋯ has no Testitiliote (ei luettavissa): is the app a Debug build launched with -LKUITest?"); return
        }
        let notice = app.staticTexts["Tiedostoa ei voitu lukea."]
        guard notice.waitForExistence(timeout: 10) else {
            dump(app, "stability-34-no-notice"); XCTFail("an unreadable statement left Lisää without a word"); return
        }
        shot("stability-34-unreadable")
        // A failure, not an import: no link to rows. The spinner is gone and ⋯ answers again.
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Näytä tapahtumat ›")).firstMatch
        XCTAssertFalse(rows.exists, "an unreadable statement offered Näytä tapahtumat")
        let free = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: bar.buttons["Toiminnot"].firstMatch)
        XCTAssertEqual(XCTWaiter().wait(for: [free], timeout: 10), .completed, "⋯ stayed busy after the failed read")
    }

    /// Taps `item` in Lisää's ⋯. The mailbox item reads "Hae sähköpostista" until the sheet has read
    /// that none is connected, so the menu is looked into up to three times.
    private func pickFromAddMenu(_ bar: XCUIElement, _ item: String) -> Bool {
        let menu = bar.buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 10) else { dump(app, "stability-lisaa-no-menu"); note("MISS Lisää has no Toiminnot"); return false }
        for _ in 0..<3 {
            menu.tap(); taps += 1
            if let button = hittable(app.buttons.matching(NSPredicate(format: "label == %@", item)), last: true, timeout: 5) {
                button.tap(); taps += 1
                return true
            }
            // Closed by a tap on the bar left of its title, clear of the menu under the trailing button.
            bar.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)).tap()
            _ = menu.waitForExistence(timeout: 2)
        }
        dump(app, "stability-lisaa-menu")
        note("MISS \(item) in Lisää's Toiminnot")
        return false
    }

    /// Lisää > Uusi myyntilasku from the tab showing, once the form has risen.
    private func openInvoiceFromAdd(_ step: String) -> Bool {
        app.tabBars.buttons["Lisää"].firstMatch.tap(); taps += 1
        guard app.navigationBars["Lisää"].waitForExistence(timeout: 10),
              let new = hittable(app.buttons.matching(NSPredicate(format: "label == %@", "Uusi myyntilasku")), timeout: 10) else {
            dump(app, "stability-24-no-lisaa"); XCTFail("\(step): Lisää did not open with Uusi myyntilasku"); return false
        }
        new.tap(); taps += 1
        let form = app.navigationBars["Uusi lasku"]
        guard form.waitForExistence(timeout: 15) else {
            dump(app, "stability-24-no-form"); XCTFail("\(step): Uusi myyntilasku did not open the form"); return false
        }
        waitStill(form)
        return true
    }

    /// Anna Asiakas and one priced line, as P2Tests fills the form; the tap on Luo lasku is the caller's.
    private func fillNewInvoice() -> Bool {
        app.buttons["Valitse asiakas"].firstMatch.tap(); taps += 1
        let picker = app.navigationBars["Valitse asiakas"]
        guard picker.waitForExistence(timeout: 10) else { XCTFail("Valitse asiakas did not open"); return false }
        // Rows under the sheets can carry the same name; only the picker's row can be tapped.
        guard let anna = hittable(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Anna Asiakas")), timeout: 10) else {
            dump(app, "stability-24-customers"); XCTFail("no Anna Asiakas to pick"); return false
        }
        anna.tap(); taps += 1
        _ = picker.waitForNonExistence(timeout: 10)
        let description = app.textViews["Rivin 1 kuvaus"].exists ? app.textViews["Rivin 1 kuvaus"] : app.textFields["Rivin 1 kuvaus"]
        type(description, "Ripsienpidennys")
        // The keyboard's bar lies over the price field under the description: the keyboard goes first.
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let price = app.textFields["Rivin 1 à-hinta euroina"]
        if !price.isHittable { app.swipeUp() }
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: price)], timeout: 5)
        type(price, "10")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let create = app.buttons["Luo lasku"].firstMatch
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: create)
        guard XCTWaiter().wait(for: [enabled], timeout: 15) == .completed else { XCTFail("Luo lasku is not enabled"); return false }
        return true
    }

    /// From a tap that closes the form: samples every 0.05 s until `done` (a tab) can be tapped or
    /// `seconds` pass, and no sample may find Lisää's bar on top. Under the form it is in the tree
    /// all along, covered, so a sample counts it only when it can be hit. `answer` (a question the
    /// close asks) is tapped when it comes up, and the sampling goes on.
    private func assertClosesOnce(onto done: XCUIElement, within seconds: TimeInterval, answering answer: XCUIElement? = nil,
                                  _ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let lisaa = app.navigationBars["Lisää"]
        var samples = 0, seen = 0, reached = false
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            samples += 1
            if lisaa.exists && lisaa.isHittable { seen += 1 }
            if let answer, answer.exists, answer.isHittable { answer.tap(); taps += 1 }
            if done.exists && done.isHittable { reached = true; break }
            usleep(50_000)
        } while Date() < deadline
        note("INFO stability 24 \(step): \(samples) samples, Lisää on top in \(seen), the tab bar back \(reached)")
        XCTAssertTrue(reached, "\(step): the tab bar was not back within \(Int(seconds)) s", file: file, line: line)
        XCTAssertEqual(seen, 0, "\(step): Lisää showed again while the form closed (\(seen) of \(samples) samples)", file: file, line: line)
    }
}

/// What an audit's handler found; a class, so the handler fills it in place.
private final class ClippedTexts {
    var labels: [String] = []
}
