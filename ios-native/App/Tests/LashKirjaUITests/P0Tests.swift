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
        // "+" is Uusi asiakas itself (X029): it opened a menu with Tuo CSV beside it.
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

    // P0.5 #1: payment sheet asks only when dirty. U007 U000 (asserted): the amount is named, and the
    // dirty question stacks over the form, which stays in view, so Jatka muokkausta returns to it.
    func testE_PaymentSheet() {
        // A miss fails: it returned quietly before, and the sheet checks below never ran (N1 run 39180264585).
        guard openOverdueFromKoti() else { XCTFail("no overdue invoice on Koti"); return }
        _ = app.navigationBars.buttons["Toiminnot"].firstMatch.waitForExistence(timeout: 30)
        sleep(1); shot("e2-invoice"); dump(app, "e2-invoice")
        // Kirjaa maksu is the primary or in Toiminnot (N6): the Maksu tile is gone.
        guard invoiceAction("Kirjaa maksu") else { XCTFail("the overdue invoice offers no Kirjaa maksu"); return }
        sleep(2); shot("e3-payment-clean")
        dump(app, "e3-payment")
        // The open sum is filled in at once, so a placeholder alone left the amount unnamed.
        XCTAssertTrue(app.staticTexts["Summa (€)"].waitForExistence(timeout: 5), "the clean payment sheet does not name its amount Summa (€)")
        swipeSheetDown("Kirjaa maksu"); sleep(2); shot("e4-clean-swipe")
        check("P0.5 clean payment sheet closes without asking", !discardDialog.exists && !app.navigationBars["Kirjaa maksu"].exists)
        guard invoiceAction("Kirjaa maksu") else { XCTFail("Kirjaa maksu did not open a second time"); return }
        sleep(2)
        let amount = app.textFields.firstMatch
        type(amount, "1")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let typed = amount.value as? String
        sleep(1); swipeSheetDown("Kirjaa maksu"); sleep(2); shot("e5-dirty-swipe")
        check("P0.5 dirty payment sheet asks Hylätäänkö muutokset?", discardDialog.exists)
        guard discardDialog.waitForExistence(timeout: 3) else { XCTFail("the dirty payment sheet did not ask Hylätäänkö muutokset?"); return }

        // On a half-height sheet the question pushed the form out of view: the bare invoice showed
        // behind it. The form's bar must be on the screen, above the question.
        let question = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        let bar = app.navigationBars["Kirjaa maksu"]
        waitStill(app.buttons["confirm-sheet-confirm"].firstMatch)
        waitStill(bar)
        XCTAssertTrue(question.exists, "the question is not the confirm sheet")
        XCTAssertTrue(bar.exists, "the Kirjaa maksu bar is gone behind the question")
        if question.exists, bar.exists {
            let window = app.windows.firstMatch.frame
            XCTAssertGreaterThanOrEqual(bar.frame.minY, window.minY, "the Kirjaa maksu bar \(bar.frame) is above the screen")
            XCTAssertLessThanOrEqual(bar.frame.maxY, question.frame.minY, "the Kirjaa maksu bar \(bar.frame) is not above the question \(question.frame)")
        }

        app.buttons["Jatka muokkausta"].firstMatch.tap()
        XCTAssertTrue(question.waitForNonExistence(timeout: 5), "Jatka muokkausta did not close the question")
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "Jatka muokkausta closed Kirjaa maksu")
        XCTAssertEqual(amount.value as? String, typed, "Jatka muokkausta did not keep the typed amount")
        shot("e6-jatka")
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

    // U002 U033 U093 M058: the forms and the pushed Asetukset screens are on the warm canvas, not the
    // cool system grey (242,242,247), and Laitteet, Sovelluslukitus and Ilmoitukset have the inline
    // title the other pushed screens have. Maksut has both already: the control. Asserted.
    func testI_WarmCanvasOnForms() {
        openSettings()
        // Top to bottom of Asetukset: tapLabel scrolls down only, and a pop keeps the list's offset.
        if tap("Laskuttajan tiedot") {
            assertWarmCanvas(app, under: app.navigationBars["Laskuttajan tiedot"], "Laskuttajan tiedot")
            backToSettings(from: "Laskuttajan tiedot")
        } else { XCTFail("Asetukset has no Laskuttajan tiedot") }
        if tap("Sähköpostimallit"), tap("Uusi malli") {
            assertWarmCanvas(app, under: app.navigationBars["Uusi malli"], "Uusi malli")
            closeSheet("Uusi malli")
            backToSettings(from: "Sähköpostimallit")
        } else { XCTFail("Sähköpostimallit > Uusi malli did not open") }
        for title in ["Maksut", "Laitteet", "Sovelluslukitus", "Ilmoitukset"] {
            guard tap(title) else { XCTFail("Asetukset has no \(title)"); continue }
            assertWarmCanvas(app, under: app.navigationBars[title], title)
            assertInlineTitle(title)
            backToSettings(from: title)
        }

        // The receipt form needs the capture fixture (`-LKUITest`). The flag stands for the one-time
        // notification question, which a later launch can raise over the screen being read (U027).
        app.terminate()
        app.launchArguments += ["-LKUITest", "-notifications.asked.v1", "YES"]
        launchSignedIn()
        dismissSystemPrompts()

        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        if tap("Uusi lasku") {
            assertWarmCanvas(app, under: app.navigationBars["Uusi lasku"], "Uusi lasku")
            closeSheet("Uusi lasku")
        } else { XCTFail("Myynti has no Uusi lasku") }
        if tap("Asiakkaat"), tap("Uusi asiakas") {
            assertWarmCanvas(app, under: app.navigationBars["Uusi asiakas"], "Uusi asiakas")
            closeSheet("Uusi asiakas")
        } else { XCTFail("Asiakkaat > Uusi asiakas did not open") }

        guard openKuitit() else { XCTFail("Kuitit did not open"); return }
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        (camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch).tap(); taps += 1
        let fixture = app.buttons["capture-fixture"].firstMatch
        guard fixture.waitForExistence(timeout: 10) else {
            XCTFail("no Testikuitti button: is the app a Debug build launched with -LKUITest?"); return
        }
        if !fixture.isHittable {
            app.swipeUp()
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: fixture)], timeout: 5)
        }
        fixture.tap(); taps += 1
        // Uploaded and read by the demo API (an empty reading), then the form opens by itself.
        let preview = app.descendants(matching: .any).matching(identifier: "captured-file-preview").firstMatch
        if !preview.waitForExistence(timeout: 90) {
            let use = app.buttons["Käytä lomakkeessa"].firstMatch
            if use.exists { use.tap(); taps += 1; _ = preview.waitForExistence(timeout: 10) }
        }
        guard preview.exists else { shot("i-no-receipt-form"); XCTFail("the receipt form did not open"); return }
        assertWarmCanvas(app, under: app.navigationBars["Uusi kuitti"], "Uusi kuitti, lomake")
    }

    // X123 X124: a refused sign-in is said under the password, as the web says it, without moving the
    // fields the owner is about to retype (a card above the form pushed them down about 81 pt), and
    // the words go once the password is edited. The e-mail placeholder is the quiet grey of the
    // password's: parsed as Markdown, 'nimi@yritys.fi' became a link in the system blue (0,122,255).
    // Asserted. It ends signed out; the next launch signs in again.
    func testL_WrongPasswordInPlace() {
        guard openSignOutQuestion() != nil else {
            shot("l0-no-question"); dump(app, "l0-no-question"); XCTFail("Asetukset > Kirjaudu ulos did not ask"); return
        }
        app.buttons["confirm-sheet-confirm"].firstMatch.tap(); taps += 1
        let email = app.textFields.firstMatch
        let password = app.secureTextFields.firstMatch
        guard password.waitForExistence(timeout: 20), email.exists else {
            shot("l0-no-form"); dump(app, "l0-no-form"); XCTFail("signing out did not open the sign-in screen"); return
        }
        waitStill(email)
        shot("l1-empty-form")

        // 60 pt of each placeholder: 'nimi@yr' and 'Salasan', glyph cores in both.
        let ink = placeholderInk([email, password], width: 60)
        let read = ink.map { $0?.description ?? "nothing" }
        note("INFO P0 L placeholder ink: e-mail \(read[0]), Salasana \(read[1])")
        if let mail = ink[0], let grey = ink[1] {
            XCTAssertTrue(mail.near(grey, within: 10), "the e-mail placeholder reads \(mail), not the grey \(grey) of Salasana's")
            XCTAssertFalse(mail.near(RGB(r: 0, g: 122, b: 255), within: 10), "the e-mail placeholder is drawn in the system link blue: \(mail)")
        } else {
            XCTFail("the placeholders could not be read off the screen: e-mail \(read[0]), Salasana \(read[1])")
        }

        type(email, "demo@lashkirja.fi")
        // Obviously not the demo password: one refused try, well inside the server's per-account limit.
        type(password, "not-the-password")
        waitStill(email)
        let before = email.frame
        // What sits under the password: the refusal must not push it down (about 40 pt when the
        // words took room only once they came).
        let forgot = app.buttons["Unohditko salasanan?"].firstMatch
        let forgotBefore = forgot.frame.minY
        app.buttons["Kirjaudu sisään"].firstMatch.tap(); taps += 1
        // The demo API's 401 (app/src/lib/auth-login.ts).
        let refusal = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "salasana on väärin")).firstMatch
        guard refusal.waitForExistence(timeout: 30) else {
            shot("l2-no-refusal"); dump(app, "l2-no-refusal"); XCTFail("a wrong password did not say so"); return
        }
        // The keyboard leaves at the tap, and the words fade in: measured once they stand still.
        waitStill(refusal)
        shot("l2-wrong-password")
        let after = email.frame
        let forgotAfter = forgot.frame.minY
        note("INFO P0 L Sähköposti minY \(before.minY) -> \(after.minY); Unohditko salasanan? minY \(forgotBefore) -> \(forgotAfter); Salasana maxY \(password.frame.maxY); refusal \(refusal.frame)")
        XCTAssertLessThanOrEqual(abs(after.minY - before.minY), 1,
                                 "the refusal moved Sähköposti from \(before.minY) to \(after.minY)")
        XCTAssertLessThanOrEqual(abs(forgotAfter - forgotBefore), 1,
                                 "the refusal moved 'Unohditko salasanan?' from \(forgotBefore) to \(forgotAfter)")
        XCTAssertGreaterThan(refusal.frame.minY, password.frame.maxY,
                             "the refusal starts at \(refusal.frame.minY), not under the password (maxY \(password.frame.maxY))")

        type(password, "x")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: refusal)
        let cleared = XCTWaiter().wait(for: [gone], timeout: 5) == .completed
        shot("l3-password-edited")
        XCTAssertTrue(cleared, "editing the password left the refusal up")
    }

    /// M058: the small inline title of the screens pushed through Route (appDestinations): a bar of
    /// one row, the title on the back button's line. The large title made it about 100 pt tall,
    /// with the 34 pt title on its own row under the back button.
    private func assertInlineTitle(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let bar = app.navigationBars[title]
        guard bar.exists else { XCTFail("\(title) did not open", file: file, line: line); return }
        waitStill(bar)
        XCTAssertLessThanOrEqual(bar.frame.height, 60, "\(title): the bar is \(bar.frame.height) pt tall, a large title", file: file, line: line)
        let back = bar.buttons.firstMatch
        let name = bar.staticTexts[title].firstMatch
        guard back.exists, name.exists else { XCTFail("\(title): the bar has no back button or no title", file: file, line: line); return }
        XCTAssertLessThanOrEqual(abs(back.frame.midY - name.frame.midY), 4,
                                 "\(title): the title's midY \(name.frame.midY) is not on the back button's \(back.frame.midY)", file: file, line: line)
    }

    /// The darkest pixel (lowest luma) of what is drawn at the left of each field, `width` points
    /// wide and 12 tall about its middle, all read off one screenshot: the core of a glyph, so the
    /// text's own colour and not an anti-aliased edge. Read once two looks 250 ms apart agree: the
    /// sign-in screen fades in after a sign-out.
    private func placeholderInk(_ fields: [XCUIElement], width: CGFloat, timeout: TimeInterval = 6) -> [RGB?] {
        let luma = { (c: RGB) in 299 * c.r + 587 * c.g + 114 * c.b }
        var last: [RGB?]?
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            // Half a point apart: no 3 px stroke falls between two samples.
            let bands = fields.map { field -> [CGPoint] in
                let frame = field.frame
                var points: [CGPoint] = []
                for dy in stride(from: CGFloat(-6), through: 6, by: 0.5) {
                    for dx in stride(from: CGFloat(1), through: min(width, frame.width - 1), by: 0.5) {
                        points.append(CGPoint(x: frame.minX + dx, y: frame.midY + dy))
                    }
                }
                return points
            }
            var reads = screenColours(app, at: bands.flatMap { $0 })[...]
            let now = bands.map { band -> RGB? in
                let mine = reads.prefix(band.count)
                reads = reads.dropFirst(band.count)
                return mine.compactMap { $0 }.min { luma($0) < luma($1) }
            }
            if let last, last == now { return now }
            last = now
            usleep(250_000)
        } while Date() < deadline
        return last ?? fields.map { _ -> RGB? in nil }
    }

    /// Back from a screen pushed inside the Asetukset sheet, by its bar's back button.
    private func backToSettings(from title: String) {
        let bar = app.navigationBars[title]
        if bar.exists { bar.buttons.firstMatch.tap(); taps += 1 }
        XCTAssertTrue(app.navigationBars["Asetukset"].waitForExistence(timeout: 10), "\(title): Back did not return to Asetukset")
    }

    /// Peruuta on a sheet nothing was typed into; a kept draft that asks first is let go.
    private func closeSheet(_ title: String) {
        let bar = app.navigationBars[title]
        let cancel = bar.buttons["Peruuta"]
        if cancel.exists { cancel.tap(); taps += 1 }
        if discardDialog.waitForExistence(timeout: 2) { app.buttons["Hylkää muutokset"].firstMatch.tap(); taps += 1 }
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: bar)
        let closed = XCTWaiter().wait(for: [gone], timeout: 10) == .completed
        XCTAssertTrue(closed, "\(title) did not close")
    }
}
