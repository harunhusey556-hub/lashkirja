import XCTest

/// Simulator walk of the P0.4 / P0.5 device checklists.
final class P0Tests: WalkTestCase {
    // P0.5 #3: dirty profile form blocks swipe-back and asks via "Takaisin".
    func testA_ProfileSwipeBack() {
        openSettings(); shot("a1-settings"); dump(app, "a1-settings")
        guard tap("Laskuttajan tiedot") else { return }
        sleep(2); shot("a2-profile-clean"); dump(app, "a2-profile")
        let field = app.textFields.firstMatch
        guard field.waitForExistence(timeout: 5) else { check("P0.5 profile has a text field", false); return }
        type(field, "x")
        shot("a3-profile-dirty")
        check("P0.5 dirty profile shows Takaisin", app.buttons["Takaisin"].firstMatch.exists)
        edgeSwipeBack(); sleep(2); shot("a4-after-edge-swipe")
        check("P0.5 edge swipe does not leave dirty profile", app.buttons["Takaisin"].firstMatch.exists || discardDialog.exists)
        if app.buttons["Takaisin"].firstMatch.exists { app.buttons["Takaisin"].firstMatch.tap() }
        sleep(1); shot("a5-takaisin-dialog")
        check("P0.5 Takaisin asks Hylätäänkö muutokset?", discardDialog.waitForExistence(timeout: 3))
        if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap() }
        sleep(1); shot("a6-after-discard")
        check("P0.5 discard returns to settings", app.staticTexts["Sähköpostimallit"].waitForExistence(timeout: 5))
    }

    // P0.5 #4: device sign-out asks first.
    func testB_DevicesSignOut() {
        openSettings()
        guard tap("Laitteet") else { return }
        sleep(3); shot("b1-devices"); dump(app, "b1-devices")
        _ = app.staticTexts["Selain"].waitForExistence(timeout: 15)
        guard tap("Kirjaa ulos kaikki muut laitteet") else { return }
        sleep(2); shot("b2-signout-confirm"); dump(app, "b2-signout-confirm")
        check("P0.5 sign out all other devices shows a confirmation", app.sheets.count > 0 || app.alerts.count > 0 || app.buttons["Peruuta"].exists)
        if app.buttons["Peruuta"].exists { app.buttons["Peruuta"].tap() } else { app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap() }
        sleep(1)
        let row = app.staticTexts["Selain"].firstMatch
        if row.exists { row.swipeLeft(); sleep(1); shot("b3-row-swipe"); dump(app, "b3-row-swipe")
            let one = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Kirjaa ulos'")).firstMatch
            if one.exists { one.tap(); sleep(1); shot("b4-one-confirm")
                check("P0.5 sign out one device shows a confirmation", app.sheets.count > 0 || app.alerts.count > 0 || app.buttons["Peruuta"].exists) }
            else { note("INFO no per-row sign-out action on swipe") } }
    }

    // P0.4 #5: template editor asks before swipe-dismiss when dirty, not when clean.
    func testC_TemplateEditor() {
        openSettings()
        guard tap("Sähköpostimallit") else { return }
        sleep(2)
        guard tap("Uusi malli") else { return }
        sleep(2); shot("c2-editor-clean"); dump(app, "c2-editor")
        swipeSheetDown("Uusi malli"); sleep(2); shot("c3-clean-swipe")
        check("P0.4 clean template editor closes without asking", !discardDialog.exists && !app.buttons["Tallenna"].exists)
        guard tap("Uusi malli") else { return }
        sleep(2)
        let tv = app.textFields.firstMatch.exists ? app.textFields.firstMatch : app.textViews.firstMatch
        type(tv, "Muutos")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        sleep(1)
        swipeSheetDown("Uusi malli"); sleep(2); shot("c4-dirty-swipe")
        check("P0.4 dirty template editor asks Hylätäänkö muutokset? on swipe", discardDialog.exists)
        check("P0.4 dirty template editor stays open after swipe", app.buttons["Tallenna"].exists)
        if app.buttons["Jatka muokkausta"].exists { app.buttons["Jatka muokkausta"].tap(); sleep(1) }
        if app.buttons["Peruuta"].exists { app.buttons["Peruuta"].tap(); sleep(1); shot("c5-dirty-peruuta")
            check("P0.4 dirty template Peruuta asks", discardDialog.exists) }
    }

    // P0.4 #1 + #3: customer form Return chain and keyboard Valmis.
    func testD_CustomerForm() {
        app.tabBars.buttons["Myynti"].tap(); sleep(2)
        guard tap("Asiakkaat") else { return }
        sleep(3); shot("d1-customers"); dump(app, "d1-customers")
        guard tap("Lisää asiakkaita") else { return }
        sleep(1)
        guard tap("Uusi asiakas") else { return }
        sleep(2); shot("d2-form"); dump(app, "d2-form")
        let name = app.textFields.firstMatch
        type(name, "Testi Oy\n"); sleep(1)
        sleep(1)
        let ytunnus = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Y-tunnus'")).firstMatch
        shot("d3-after-return")
        check("P0.4 Return moves from name to Y-tunnus", ytunnus.value(forKey: "hasKeyboardFocus") as? Bool == true)
        check("P0.4 keyboard shows Valmis", app.buttons["Valmis"].exists)
    }

    // P0.5 #1: payment sheet asks only when dirty.
    func testE_PaymentSheet() {
        guard tapLabel("label CONTAINS %@", "· myöhässä") else { return }
        _ = app.buttons["Maksu"].waitForExistence(timeout: 30)
        sleep(1); shot("e2-invoice"); dump(app, "e2-invoice")
        let pay = app.buttons["Kirjaa maksu"].firstMatch
        guard tap("Maksu") else { return }
        sleep(2); shot("e3-payment-clean")
        dump(app, "e3-payment")
        swipeSheetDown("Kirjaa maksu"); sleep(2); shot("e4-clean-swipe")
        check("P0.5 clean payment sheet closes without asking", !discardDialog.exists && !app.navigationBars["Kirjaa maksu"].exists)
        guard tap("Maksu") else { return }
        sleep(2)
        let amount = app.textFields.firstMatch
        type(amount, "1")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        sleep(1); swipeSheetDown("Kirjaa maksu"); sleep(2); shot("e5-dirty-swipe")
        check("P0.5 dirty payment sheet asks Hylätäänkö muutokset?", discardDialog.exists)
    }

    // P0.4 #5 isolated: Peruuta on a fresh dirty template editor asks.
    func testF_TemplatePeruuta() {
        openSettings()
        guard tap("Sähköpostimallit") else { return }
        sleep(2)
        guard tap("Uusi malli") else { return }
        sleep(2)
        type(app.textFields.firstMatch, "Muutos")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        sleep(1)
        app.navigationBars["Uusi malli"].buttons["Peruuta"].tap()
        sleep(2); shot("f1-peruuta")
        check("P0.4 dirty template Peruuta asks (isolated)", discardDialog.exists)
    }

    // Swipe → dialog → Jatka muokkausta → Peruuta must ask again.
    func testG_SwipeThenPeruuta() {
        openSettings()
        guard tap("Sähköpostimallit") else { return }
        sleep(2)
        guard tap("Uusi malli") else { return }
        sleep(2)
        type(app.textFields.firstMatch, "Muutos")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        sleep(1)
        swipeSheetDown("Uusi malli"); sleep(2); shot("g1-swipe-dialog")
        note("INFO g swipe dialog shown: \(discardDialog.exists)")
        let keep = app.buttons["Jatka muokkausta"]
        note("INFO g Jatka button exists: \(keep.exists)")
        if keep.exists { keep.tap() }
        sleep(3); shot("g2-after-jatka"); dump(app, "g2-after-jatka")
        note("INFO g dialog gone after Jatka: \(!discardDialog.exists)")
        let cancel = app.navigationBars["Uusi malli"].buttons["Peruuta"]
        note("INFO g Peruuta exists: \(cancel.exists) hittable: \(cancel.exists && cancel.isHittable)")
        cancel.tap()
        sleep(2); shot("g3-peruuta")
        check("P0.4 Peruuta asks after a swipe dialog was dismissed", discardDialog.exists)
        if !discardDialog.exists { cancel.tap(); sleep(2); shot("g4-peruuta-again")
            check("P0.4 second Peruuta tap asks", discardDialog.exists) }
    }

    // Customer form (own sheet, now on the shared guard): dirty swipe asks, alert has both buttons.
    func testH_CustomerSwipe() {
        app.tabBars.buttons["Myynti"].tap(); sleep(2)
        guard tap("Asiakkaat") else { return }
        sleep(3)
        guard tap("Lisää asiakkaita") else { return }
        sleep(1)
        guard tap("Uusi asiakas") else { return }
        sleep(2)
        type(app.textFields.firstMatch, "Testi Oy")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        sleep(1)
        swipeSheetDown("Uusi asiakas"); sleep(2); shot("h1-customer-swipe")
        check("P0.5 dirty customer form asks on swipe", discardDialog.exists)
        check("P0.5 discard alert shows Jatka muokkausta", app.buttons["Jatka muokkausta"].exists)
        if app.buttons["Jatka muokkausta"].exists { app.buttons["Jatka muokkausta"].tap() }
        sleep(1)
        check("P0.5 Jatka keeps the customer form open", app.navigationBars["Uusi asiakas"].exists)
    }
}
