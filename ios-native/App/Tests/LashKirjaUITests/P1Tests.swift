import XCTest

/// P1 acceptance: taps from a fresh launch (Koti) to each common task.
final class P1Tests: WalkTestCase {
    func exists(_ pred: String, _ arg: String, _ timeout: Double = 15) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch.waitForExistence(timeout: timeout)
    }

    func test01_CreateInvoiceFromMyynti() {
        tab("Myynti"); tap("Uusi lasku")
        measure("create invoice (Myynti)", reached: app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15))
    }
    func test02_CreateInvoiceFromAdd() {
        tab("Lisää"); sleep(1); tap("Uusi myyntilasku")
        measure("create invoice (Lisää)", reached: app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15))
    }
    func test03_OpenOverdueInvoice() {
        tapLabel("label CONTAINS %@", "· myöhässä")
        measure("open overdue invoice (Koti)", reached: exists("label BEGINSWITH %@", "Myöhässä "))
    }
    func test04_ReviewReceipt() {
        tab("Kirjanpito"); tap("Kuitit"); sleep(3); dump(app, "nav-receipts")
        // Rows are buttons labelled "<vendor>, <date · category>, <amount>"; the demo seed has Sähköyhtiö.
        tapLabel("label BEGINSWITH %@", "Sähköyhtiö,")
        sleep(3)
        measure("review receipt", reached: !app.navigationBars["Kuitit"].exists)
    }
    func test05_UnmatchedBankTransaction() {
        tab("Kirjanpito"); tap("Pankki"); sleep(3); dump(app, "nav-bankhub")
        tapLabel("label BEGINSWITH %@", "Vaatii toimia"); sleep(3); dump(app, "nav-open-rows")
        let first = app.cells.firstMatch
        if first.waitForExistence(timeout: 10) { first.tap(); taps += 1 }
        sleep(2)
        measure("open unmatched bank transaction", reached: true)
    }
    func test06_BankAccount() {
        tab("Kirjanpito"); tap("Pankki"); sleep(2); tapLabel("label BEGINSWITH %@", "Pankkiyhteys ja tilit")
        measure("open bank account / connection", reached: exists("label CONTAINS %@", "Tili"))
    }
    func test07_VatStatus() {
        tab("Kirjanpito"); tap("ALV-ilmoitus")
        measure("open VAT status", reached: exists("label CONTAINS %@", "ALV"))
    }
    func test08_CompanyProfile() {
        openSettings(); tap("Yritysmuoto ja ALV")
        measure("change company/profile info", reached: app.textFields.firstMatch.waitForExistence(timeout: 10) || app.switches.firstMatch.exists)
    }
    func test09_Assistant() {
        app.buttons["Avustaja"].firstMatch.tap(); taps += 1; sleep(2)
        measure("open AI assistant", reached: app.textFields.firstMatch.exists || app.textViews.firstMatch.exists)
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
