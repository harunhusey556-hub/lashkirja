import XCTest

/// P1 acceptance: taps from a fresh launch (Koti) to each common task.
final class P1Tests: WalkTestCase {
    func exists(_ pred: String, _ arg: String, _ timeout: Double = 15) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch.waitForExistence(timeout: timeout)
    }

    func test01_CreateInvoiceFromMyynti() {
        tab("Myynti"); let opened = tap("Uusi lasku")
        measure("create invoice (Myynti)", reached: opened && app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15))
    }
    func test02_CreateInvoiceFromAdd() {
        tab("Lisää"); sleep(1); let opened = tap("Uusi myyntilasku")
        measure("create invoice (Lisää)", reached: opened && app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15))
    }
    func test03_OpenOverdueInvoice() {
        let opened = openOverdueFromKoti()
        measure("open overdue invoice (Koti)", reached: opened && exists("label BEGINSWITH %@", "Myöhässä "))
    }
    /// U023: the seed had no pending receipt, so this opened an approved one and passed on any detail.
    /// N3 (O3, U098): the task is done, not only reached. Hyväksy is the screen's one primary, held at
    /// the bottom, so it is tapped without a scroll and Tila then reads Hyväksytty; the rest is in
    /// Toiminnot. Nothing reseeds between tests, so the seed's receipt stays approved for the rest of
    /// the run; StabilityTests test15 opens the seed's other pending one, Audit Hyvitys Odottaa Oy.
    func test04_ReviewReceipt() {
        tab("Kirjanpito"); let kuitit = tap("Kuitit"); sleep(3); dump(app, "nav-receipts")
        // Rows are buttons labelled "<vendor>, <date · category>, <amount>"; demo-seed.ts --ci has
        // Lumo Kosmetiikka Oy waiting in "Odottaa hyväksyntää".
        let opened = tapLabel("label BEGINSWITH %@", "Lumo Kosmetiikka Oy,")
        // Toiminnot comes with the loaded receipt; the row's preview has neither it nor the actions.
        let actions = app.navigationBars["Kuitti"].buttons["Toiminnot"]
        let loaded = actions.waitForExistence(timeout: 15)
        let approve = app.buttons.matching(NSPredicate(format: "label == %@", "Hyväksy")).firstMatch
        let shown = approve.waitForExistence(timeout: 10) && approve.isHittable
        check("P1 04 Hyväksy is on screen without a scroll", shown)
        XCTAssertTrue(shown, "Hyväksy is not on screen without a scroll")
        // A look into Toiminnot, not a step of the task: its taps are not counted.
        if loaded {
            actions.firstMatch.tap()
            for item in ["Hylkää", "Lue uudelleen"] {
                let inMenu = app.buttons[item].firstMatch.waitForExistence(timeout: 5)
                check("P1 04 Toiminnot has \(item)", inMenu)
                XCTAssertTrue(inMenu, "Toiminnot has no \(item)")
            }
            shot("p1-04-toiminnot")
            // Closed by a tap on the bar between Back and the title, clear of the menu, which opens
            // under the trailing button; the bar does nothing with it.
            app.navigationBars["Kuitti"].coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
            XCTAssertTrue(app.buttons["Hylkää"].firstMatch.waitForNonExistence(timeout: 5), "Toiminnot did not close")
        }
        var approved = false
        if shown {
            approve.tap(); taps += 1
            let state = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@ OR value == %@ OR label == %@", "Hyväksytty", "Hyväksytty", "Tila, Hyväksytty")).firstMatch
            approved = state.waitForExistence(timeout: 15)
            if !approved { dump(app, "p1-04-after-hyvaksy") }
            XCTAssertTrue(approved, "Tila does not read Hyväksytty after Hyväksy")
        }
        measure("review receipt", reached: kuitit && opened && loaded && approved, maxTaps: 4, maxScrolls: 0)
    }
    /// U021: `app.cells.firstMatch` was the Kaikki / Vaatii toimia control's cell, and the step passed
    /// with `reached: true` while the list stayed on screen. Now the first row below the control,
    /// then the bar of the sheet it opens, which is titled by the row's state. N2: through Kohdista
    /// kuitit, which opens Pankki on Vaatii toimia; the hub's own "Vaatii toimia" row was a fourth tap.
    func test05_UnmatchedBankTransaction() {
        tab("Kirjanpito"); let kohdista = tap("Kohdista kuitit")
        let control = app.segmentedControls.firstMatch
        let needsAction = control.buttons["Vaatii toimia"]
        let filtered = kohdista && app.navigationBars["Pankki"].waitForExistence(timeout: 15)
            && needsAction.waitForExistence(timeout: 10) && needsAction.isSelected
        let row = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.openBankRow)).firstMatch
        var sheet: XCUIElement?
        if row.waitForExistence(timeout: 10), control.exists, row.frame.minY >= control.frame.maxY {
            sheet = Self.openBankStates.first { row.label.contains("· \($0), ") }.map { app.navigationBars[$0] }
        }
        dump(app, "nav-open-rows")
        let opened = sheet != nil && tapLabel("label MATCHES %@", Self.openBankRow)
        let shown = opened && (sheet?.waitForExistence(timeout: 10) ?? false) && (sheet?.buttons["Valmis"].exists ?? false)
        measure("open unmatched bank transaction", reached: filtered && shown, maxTaps: 3)
    }
    /// The open states BankRow prints after the date, which are also its sheet's title (BankFeed.label).
    static let openBankStates = ["Kuitti puuttuu", "Ehdotus", "Hyväksy myynti"]
    /// A bank row's button: "<title>, <date> · <state>, <amount>".
    static let openBankRow = ".*· (Kuitti puuttuu|Ehdotus|Hyväksy myynti), .*"
    /// Any bank row's button, whatever its state.
    static let bankRow = ".*, [0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4} · .*, .*"
    /// N2: through Pankki's first row (Saldo yhteensä and the consent), at the top of the rows.
    func test06_BankAccount() {
        tab("Kirjanpito"); let pankki = tap("Pankki"); sleep(2)
        let opened = pankki && app.navigationBars["Pankki"].waitForExistence(timeout: 15)
            && tapLabel("label BEGINSWITH %@", "Saldo yhteensä")
        // Its own bar: any label containing "Tili" passed, and the hub had several (U023).
        let reached = opened && app.navigationBars["Pankkiyhteys ja tilit"].waitForExistence(timeout: 15)
        measure("open bank account / connection", reached: reached, maxTaps: 3, maxScrolls: 0)
    }
    func test07_VatStatus() {
        tab("Kirjanpito"); let opened = tap("ALV-ilmoitus")
        measure("open VAT status", reached: opened && exists("label CONTAINS %@", "ALV"))
    }
    func test08_CompanyProfile() {
        openSettings(); let opened = tap("Yritysmuoto ja ALV")
        // The pushed screen's bar: any text field or switch passed, Asetukset's own toggle among them (U023).
        measure("change company/profile info", reached: opened && app.navigationBars["Yritysmuoto ja ALV"].waitForExistence(timeout: 10))
    }
    func test09_Assistant() {
        app.buttons["Avustaja"].firstMatch.tap(); taps += 1
        // The composer by its placeholder: any text field or text view passed (U023).
        let composer = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Kirjoita viesti…")).firstMatch
        measure("open AI assistant", reached: composer.waitForExistence(timeout: 10))
    }
    /// P1 01's flake (OPEN-ISSUES row 20b): the tap on "Uusi lasku" landing while Myynti is still
    /// painting its first list. No settling time after the tab, and the form opened a second time
    /// after it was closed, so a tap that was swallowed once cannot hide behind the next one.
    func test10_NewInvoiceRightAfterTheTab() {
        app.tabBars.buttons["Myynti"].firstMatch.tap(); taps += 1
        let new = app.buttons["Uusi lasku"].firstMatch
        XCTAssertTrue(new.waitForExistence(timeout: 15), "no Uusi lasku on Myynti")
        new.tap(); taps += 1
        let form = app.navigationBars["Uusi lasku"]
        let first = form.waitForExistence(timeout: 15)
        check("Uusi lasku opens on the first tap right after the tab", first)
        XCTAssertTrue(first, "the first tap on Uusi lasku did not open the form")
        app.navigationBars["Uusi lasku"].buttons["Peruuta"].firstMatch.tap()
        if app.buttons["Hylkää muutokset"].waitForExistence(timeout: 2) { app.buttons["Hylkää muutokset"].tap() }
        XCTAssertTrue(form.waitForNonExistence(timeout: 10), "the form did not close")
        new.tap(); taps += 1
        let second = form.waitForExistence(timeout: 15)
        check("Uusi lasku opens again after the form was closed", second)
        XCTAssertTrue(second, "the second tap on Uusi lasku did not open the form")
        measure("create invoice right after the tab (Myynti)", reached: first && second)
    }

    /// M024, M033, X021: Asiakkaat and Toistuvat laskut open on the tab's path, so Back goes through
    /// the screens in the order they opened. Pushed beside the path, a customer opened under
    /// Asiakkaat (the stack read Myynti, customer, Asiakkaat).
    func test11_ShortcutTilesStayOnThePath() {
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        guard onTop("Myynti") else { return }

        tap("Asiakkaat")
        guard onTop("Asiakkaat") else { return }
        inlineTitle("Asiakkaat")
        tapLabel("label BEGINSWITH %@", "Kauneus Oy")
        guard onTop("Kauneus Oy") else { return }
        back("Kauneus Oy")
        guard onTop("Asiakkaat") else { return }
        back("Asiakkaat")
        guard onTop("Myynti") else { return }

        // Its own screen, not the tile beside it: two NavigationLinks in one List row share one tap.
        tap("Toistuvat laskut")
        guard onTop("Toistuvat laskut") else { return }
        inlineTitle("Toistuvat laskut")
        back("Toistuvat laskut")
        guard onTop("Myynti") else { return }
        measure("Myynti tiles stay on the path", reached: true)
    }

    /// G005: an invoice's customer opens on the tab's path too. Pushed beside it, the customer's own
    /// invoice opened under the customer. A launch of its own, not test 11's tail: where Asiakkaat
    /// still pushes beside the path, test 11 stops there and never reaches the customer.
    func test12_InvoiceCustomerStaysOnThePath() {
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        guard onTop("Myynti", "P1 12") else { return }

        // Lasku 2's customer, then another of that customer's invoices from the customer.
        tapLabel("label CONTAINS %@", "Lasku 2 · ")
        guard onTop("Lasku 2", "P1 12") else { return }
        let customer = app.buttons["Kauneus Oy"].firstMatch
        XCTAssertTrue(customer.waitForExistence(timeout: 15), "Lasku 2 does not name its customer")
        // Once the pushed invoice holds still: a tap during the push stayed on Lasku 2 (UI suite 39326372755).
        waitStill(customer)
        customer.tap(); taps += 1
        guard onTop("Kauneus Oy", "P1 12") else { return }
        let other = app.buttons.matching(NSPredicate(format: "label MATCHES %@ AND NOT (label BEGINSWITH %@)", "Lasku [0-9]+.*", "Lasku 2"))
            .firstMatch
        guard other.waitForExistence(timeout: 15) else { dump(app, "p1-12-customer"); XCTFail("Kauneus Oy lists no other invoice"); return }
        let number = other.label.range(of: "Lasku [0-9]+", options: .regularExpression).map { String(other.label[$0]) } ?? other.label
        other.tap(); taps += 1
        guard onTop(number, "P1 12") else { return }
        back(number)
        guard onTop("Kauneus Oy", "P1 12") else { return }
        back("Kauneus Oy")
        guard onTop("Lasku 2", "P1 12") else { return }
        back("Lasku 2")
        guard onTop("Myynti", "P1 12") else { return }
        measure("an invoice's customer stays on the path", reached: true)
    }

    /// N2 (O2, U078): the bank rows are two taps from the Kirjanpito tab. Pankki opens them on
    /// Kaikki; the hub that stood between them needed a third ("Näytä kaikki").
    func test12_BankRowsWithinTwoTaps() {
        tab("Kirjanpito"); let opened = tap("Pankki")
        let bar = opened && app.navigationBars["Pankki"].waitForExistence(timeout: 15)
        let control = app.segmentedControls.firstMatch
        let all = control.buttons["Kaikki"]
        let onAll = bar && all.waitForExistence(timeout: 10) && all.isSelected
        let row = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.bankRow)).firstMatch
        let rows = onAll && row.waitForExistence(timeout: 15) && row.frame.minY >= control.frame.maxY
        if !rows { dump(app, "p1-12-bank-rows") }
        check("P1 12 Pankki bar \(bar), Kaikki selected \(onAll), a bank row below the control \(rows)", rows)
        measure("bank rows from Kirjanpito", reached: rows, maxTaps: 2, maxScrolls: 0)
    }

    /// N2: Koti's Rahatilanne heading (its hint "Avaa pankin") opens Pankki's rows in one tap. The
    /// heading is found by its label, the title and the balance sentence: a hint is no query key.
    func test13_BankFromKoti() {
        let heading = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Rahatilanne")).firstMatch
        let shown = heading.waitForExistence(timeout: 20) && reveal(heading)
        if shown { heading.tap(); taps += 1 }
        let bar = app.navigationBars["Pankki"]
        // The rows' bar (Toiminnot) and control, not only a screen named Pankki: the hub was one too.
        let opened = shown && bar.waitForExistence(timeout: 15) && bar.buttons["Toiminnot"].waitForExistence(timeout: 10)
        let all = app.segmentedControls.firstMatch.buttons["Kaikki"]
        let onAll = opened && all.waitForExistence(timeout: 10) && all.isSelected
        if !onAll { dump(app, "p1-13-bank-from-koti") }
        check("P1 13 heading shown \(shown), Pankki with Toiminnot \(opened), Kaikki selected \(onAll)", onAll)
        measure("bank from Koti", reached: onAll, maxTaps: 1)
    }

    /// O3 change 5 (B8): the month's result without a scroll, Kuukausittain right under the year
    /// (it sat under the year's result, at the foot of the first screen or below it). Then a
    /// finished month's Kuukauden sulku sends that month's zip with its one primary, 'Lähetä
    /// kirjanpitäjälle', instead of a link to Raportit where the period was picked again. The --ci
    /// seed finishes the month three months back.
    func test17_MonthResultNoScroll() {
        XCTAssertTrue(selectTab("Raportit"), "Raportit is not selected")
        // The month row's second line: "Tulot 65,00 € · Menot 137,69 €".
        let monthRow = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", " · Menot ")).firstMatch
        let shown = monthRow.waitForExistence(timeout: 15) && reveal(monthRow, scrolls: 0)
        if !shown { dump(app, "p1-17-month-row") }
        measure("month result (Raportit)", reached: shown, maxTaps: 1, maxScrolls: 0)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Helsinki") ?? .current
        let finished = calendar.dateComponents([.year, .month], from: calendar.date(byAdding: .month, value: -3, to: Date()) ?? Date())
        let year = finished.year ?? 2026, month = finished.month ?? 1
        let names = ["Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu",
                     "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu"]
        let key = String(format: "%04d-%02d", year, month)
        guard selectTab("Kirjanpito"), tapLabel("label BEGINSWITH %@", "Kuukauden sulku"),
              app.navigationBars["Kuukauden sulku"].waitForExistence(timeout: 15) else {
            XCTFail("Kuukauden sulku did not open"); return
        }
        // Back to the finished month, one month at a time as the owner would.
        let title = app.staticTexts["\(names[month - 1]) \(year)"].firstMatch
        let previous = app.buttons["Edellinen kuukausi"].firstMatch
        for _ in 0..<6 where !title.exists {
            guard previous.waitForExistence(timeout: 5) else { break }
            previous.tap(); taps += 1
            _ = title.waitForExistence(timeout: 5)
        }
        let send = app.buttons["Lähetä kirjanpitäjälle"].firstMatch
        guard title.exists, send.waitForExistence(timeout: 15), reveal(send) else {
            dump(app, "p1-17-finished-month"); XCTFail("\(key) on Kuukauden sulku has no Lähetä kirjanpitäjälle"); return
        }
        send.tap(); taps += 1
        let sheet = app.navigationBars["kirjanpito-\(key).zip"]
        check("P1 17 Lähetä kirjanpitäjälle opens kirjanpito-\(key).zip", sheet.waitForExistence(timeout: 15))
        XCTAssertTrue(sheet.exists, "Lähetä kirjanpitäjälle did not open kirjanpito-\(key).zip")
    }

    /// N7 (O3, Q4): the camera is two taps from any tab, Lisää and then Kuvaa kuitti; through Lisää
    /// tiedosto's page it was three. The simulator has no camera, so the capture page opens on its
    /// picker either way and says, under `-LKUITest` (hence the second launch), that it asked for one.
    /// The imports moved behind Lisää's ⋯.
    func test16_CameraFromLisaa() {
        app.terminate()
        app.launchArguments += ["-LKUITest", "-notifications.asked.v1", "YES"]
        launchSignedIn()
        dismissSystemPrompts()
        tab("Lisää")
        let sheet = app.navigationBars["Lisää"]
        var opened = false
        // Koti under the sheet can carry a "Kuvaa kuitti" of its own; only the sheet's row can be tapped.
        if sheet.waitForExistence(timeout: 10), let row = firstHittable(app.buttons.matching(NSPredicate(format: "label == %@", "Kuvaa kuitti")), timeout: 10) {
            row.tap(); taps += 1
            opened = app.navigationBars["Uusi kuitti"].waitForExistence(timeout: 15)
        }
        let marker = app.descendants(matching: .any).matching(identifier: "capture-camera-asked").firstMatch
        let asked = opened && marker.waitForExistence(timeout: 5)
        if !asked { dump(app, "p1-16-camera") }
        check("P1 16 Lisää open \(sheet.exists), Uusi kuitti \(opened), the camera asked for \(asked)", asked)
        measure("camera from Lisää", reached: asked, maxTaps: 2, maxScrolls: 0)
        guard opened else { return }

        // Not a step of the task: closing the page takes Lisää down with it, and Lisää opens again.
        app.navigationBars["Uusi kuitti"].buttons.matching(NSPredicate(format: "label IN %@", ["Peruuta", "Sulje"])).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Uusi kuitti"].waitForNonExistence(timeout: 10), "Peruuta did not close the capture page")
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Lisää stayed up under the closed capture page")
        tab("Lisää")
        guard sheet.waitForExistence(timeout: 10) else { XCTFail("Lisää did not open again"); return }
        let statement = app.buttons.matching(NSPredicate(format: "label == %@", "Tuo tiliote"))
        XCTAssertNil(firstHittable(statement, timeout: 2), "Tuo tiliote is still a row of Lisää, not in ⋯")
        let menu = sheet.buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 5) else { dump(app, "p1-16-no-menu"); XCTFail("Lisää has no ⋯ (Toiminnot)"); return }
        menu.tap()
        let inMenu = firstHittable(statement, timeout: 5) != nil
        let mail = firstHittable(app.buttons.matching(NSPredicate(format: "label IN %@", ["Hae sähköpostista", "Yhdistä sähköposti"])), timeout: 2) != nil
        shot("p1-16-lisaa-toiminnot")
        check("P1 16 ⋯ has Tuo tiliote \(inMenu) and the mailbox \(mail)", inMenu && mail)
        XCTAssertTrue(inMenu, "Lisää's ⋯ has no Tuo tiliote")
        XCTAssertTrue(mail, "Lisää's ⋯ has neither Hae sähköpostista nor Yhdistä sähköposti")
    }

    /// The first hittable element of `query`, looked for until `timeout`; nil when none was.
    private func firstHittable(_ query: XCUIElementQuery, timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let element = query.allElementsBoundByIndex.first(where: { $0.isHittable }) { return element }
            usleep(250_000)
        } while Date() < deadline
        return nil
    }

    /// The screen on top is `title`; recorded under `step` and asserted, and a miss keeps the tree.
    private func onTop(_ title: String, _ step: String = "P1 11") -> Bool {
        let shown = app.navigationBars[title].waitForExistence(timeout: 15)
        check("\(step) \(title) on top", shown)
        if !shown {
            let bars = app.navigationBars.allElementsBoundByIndex.map(\.identifier).joined(separator: ", ")
            dump(app, "\(step.lowercased().replacingOccurrences(of: " ", with: "-"))-not-\(title)")
            XCTFail("\(title) is not on top; navigation bars: \(bars)")
        }
        return shown
    }

    /// A pushed screen's small inline title: the large one is about 106 pt tall, the inline one 54.
    @discardableResult
    private func inlineTitle(_ title: String) -> Bool {
        let bar = app.navigationBars[title]
        // The push has settled once the bar is small; a large title never gets there.
        let deadline = Date().addingTimeInterval(5)
        while bar.frame.height > 60, Date() < deadline { usleep(250_000) }
        let height = bar.frame.height
        check("P1 11 \(title) has the inline title (\(Int(height)) pt)", height <= 60)
        XCTAssertLessThanOrEqual(height, 60, "\(title) opened with a large title")
        return height <= 60
    }

    /// The bar's Back button, as the owner taps it.
    private func back(_ title: String) {
        let bar = app.navigationBars[title]
        let button = bar.buttons["BackButton"].exists ? bar.buttons["BackButton"] : bar.buttons.element(boundBy: 0)
        button.tap(); taps += 1
    }
}
