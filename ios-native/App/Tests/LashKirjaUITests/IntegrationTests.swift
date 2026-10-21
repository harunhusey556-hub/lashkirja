import XCTest

/// Quick actions / App Intents route through lashkirja:// links; each must open its screen.
final class IntegrationTests: WalkTestCase {
    func testA_InvoiceLink() {
        openURL("lashkirja://invoice/new")
        let ok = app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15)
        shot("int-invoice"); check("Link invoice/new opens Uusi lasku", ok)
        assertNoSystemAlert("int-invoice")
    }
    /// U105: the capture page itself. Any 'kuva', 'tiedosto' or 'kuitti' in the app passed, and
    /// Koti under the cover has 'Kuitti puuttuu' rows and 'Kuvaa kuitti' buttons.
    func testB_CaptureLink() {
        openURL("lashkirja://capture")
        let page = app.navigationBars["Uusi kuitti"]
        let opened = page.waitForExistence(timeout: 15)
        // The simulator has no camera or scanner: the capture flow opens with its library/file choices.
        let photos = app.buttons["Valitse kuvista"].firstMatch
        let offered = photos.waitForExistence(timeout: 5)
        shot("int-capture"); dump(app, "int-capture")
        check("Link capture opens Uusi kuitti with Valitse kuvista (page \(opened), Valitse kuvista \(offered))", opened && offered)
        assertNoSystemAlert("int-capture")
    }
    /// U106: the assistant's own composer, inside its sheet under the bar with Keskustelut; any text
    /// field or text view passed.
    func testC_AssistantLink() {
        openURL("lashkirja://assistant")
        let bar = app.navigationBars.containing(NSPredicate(format: "label == %@", "Keskustelut")).firstMatch
        // A text field or, grown to more lines, a text view: by its placeholder either way.
        let composer = app.descendants(matching: .any).matching(NSPredicate(format: "placeholderValue IN %@",
                                                                            ["Kirjoita viesti…", "Kirjoittaminen ei ole nyt käytössä"])).firstMatch
        let opened = bar.waitForExistence(timeout: 15) && composer.waitForExistence(timeout: 10)
        // Measured where the rising sheet stops.
        if opened { waitStill(composer) }
        let inside = opened && composer.frame.minY > bar.frame.maxY && app.windows.firstMatch.frame.contains(composer.frame)
        shot("int-assistant")
        check("Link assistant opens the assistant's composer in its sheet (\(opened ? "\(composer.frame) under \(bar.frame)" : "not opened"))", inside)
        assertNoSystemAlert("int-assistant")
    }
    /// U106: from Raportit, asserted selected, and Raportit is still the tab once the form closes.
    /// tab() only tapped and slept, and the shot of the sheet alone could not show the tab.
    func testD_LinkFromOtherTab() {
        check("Raportit is selected before the link", selectTab("Raportit"))
        openURL("lashkirja://invoice/new")
        let form = app.navigationBars["Uusi lasku"]
        let ok = form.waitForExistence(timeout: 15)
        shot("int-invoice-from-raportit"); check("Link works while on another tab", ok)
        assertNoSystemAlert("int-invoice-from-raportit")
        guard ok else { return }
        let cancel = form.buttons["Peruuta"]
        XCTAssertTrue(cancel.exists, "Uusi lasku has no Peruuta")
        if cancel.exists { cancel.tap(); taps += 1 }
        // Nothing typed, so no question; one left from a kept draft is let go.
        if discardDialog.waitForExistence(timeout: 2) { app.buttons["Hylkää muutokset"].firstMatch.tap(); taps += 1 }
        XCTAssertTrue(form.waitForNonExistence(timeout: 10), "Uusi lasku did not close")
        shot("int-after-form")
        check("Raportit is still selected after the form closed", app.tabBars.buttons["Raportit"].firstMatch.isSelected)
    }
}
