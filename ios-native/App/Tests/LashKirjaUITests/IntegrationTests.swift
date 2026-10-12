import XCTest

/// Quick actions / App Intents route through lashkirja:// links; each must open its screen.
final class IntegrationTests: WalkTestCase {
    func testA_InvoiceLink() {
        openURL("lashkirja://invoice/new")
        let ok = app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15)
        shot("int-invoice"); check("Link invoice/new opens Uusi lasku", ok)
    }
    func testB_CaptureLink() {
        openURL("lashkirja://capture")
        sleep(3); shot("int-capture"); dump(app, "int-capture")
        // The simulator has no camera or scanner: the capture flow opens with its library/file choices.
        let ok = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'kuva' OR label CONTAINS[c] 'tiedosto' OR label CONTAINS[c] 'kuitti'")).firstMatch.exists
        check("Link capture opens the receipt capture flow", ok)
    }
    func testC_AssistantLink() {
        openURL("lashkirja://assistant")
        sleep(3); shot("int-assistant")
        check("Link assistant opens the assistant", app.textFields.firstMatch.exists || app.textViews.firstMatch.exists)
    }
    func testD_LinkFromOtherTab() {
        tab("Raportit")
        openURL("lashkirja://invoice/new")
        let ok = app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15)
        shot("int-invoice-from-raportit"); check("Link works while on another tab", ok)
    }
}
