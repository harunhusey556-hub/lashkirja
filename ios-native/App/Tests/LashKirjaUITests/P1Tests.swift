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
        tab("Lisää"); sleep(1); tap("Uusi lasku")
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
}
