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
    /// The task ends on the pending receipt's Hyväksy, on screen; tapping it would approve the seed's
    /// receipt for every test after this one.
    func test04_ReviewReceipt() {
        tab("Kirjanpito"); let kuitit = tap("Kuitit"); sleep(3); dump(app, "nav-receipts")
        // Rows are buttons labelled "<vendor>, <date · category>, <amount>"; demo-seed.ts --ci has
        // Lumo Kosmetiikka Oy waiting in "Odottaa hyväksyntää".
        let opened = tapLabel("label BEGINSWITH %@", "Lumo Kosmetiikka Oy,")
        // Toiminnot comes with the loaded receipt; the row's preview has neither it nor the actions.
        let loaded = app.navigationBars["Kuitti"].buttons["Toiminnot"].waitForExistence(timeout: 15)
        let approve = app.buttons.matching(NSPredicate(format: "label == %@", "Hyväksy")).firstMatch
        measure("review receipt", reached: kuitit && opened && loaded && reveal(approve), maxTaps: 4, maxScrolls: 2)
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
