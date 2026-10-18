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
        let opened = tapLabel("label CONTAINS %@", "· myöhässä")
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
    /// then the bar of the sheet it opens, which is titled by the row's state.
    func test05_UnmatchedBankTransaction() {
        tab("Kirjanpito"); let hub = tap("Pankki"); sleep(3); dump(app, "nav-bankhub")
        let filtered = tapLabel("label BEGINSWITH %@", "Vaatii toimia"); sleep(3); dump(app, "nav-open-rows")
        let control = app.segmentedControls.firstMatch
        let row = app.buttons.matching(NSPredicate(format: "label MATCHES %@", Self.openBankRow)).firstMatch
        var sheet: XCUIElement?
        if row.waitForExistence(timeout: 10), control.exists, row.frame.minY >= control.frame.maxY {
            sheet = Self.openBankStates.first { row.label.contains("· \($0), ") }.map { app.navigationBars[$0] }
        }
        let opened = sheet != nil && tapLabel("label MATCHES %@", Self.openBankRow)
        let shown = opened && (sheet?.waitForExistence(timeout: 10) ?? false) && (sheet?.buttons["Valmis"].exists ?? false)
        measure("open unmatched bank transaction", reached: hub && filtered && shown, maxTaps: 4)
    }
    /// The open states BankRow prints after the date, which are also its sheet's title (BankFeed.label).
    static let openBankStates = ["Kuitti puuttuu", "Ehdotus", "Hyväksy myynti"]
    /// A bank row's button: "<title>, <date> · <state>, <amount>".
    static let openBankRow = ".*· (Kuitti puuttuu|Ehdotus|Hyväksy myynti), .*"
    func test06_BankAccount() {
        tab("Kirjanpito"); let hub = tap("Pankki"); sleep(2)
        let opened = tapLabel("label BEGINSWITH %@", "Pankkiyhteys ja tilit")
        // Its own bar: any label containing "Tili" passed, and the hub has several (U023).
        let reached = hub && opened && app.navigationBars["Pankkiyhteys ja tilit"].waitForExistence(timeout: 15)
        measure("open bank account / connection", reached: reached, maxTaps: 3, maxScrolls: 1)
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
}
