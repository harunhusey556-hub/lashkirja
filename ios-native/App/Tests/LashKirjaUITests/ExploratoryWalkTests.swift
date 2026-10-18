import XCTest

/// Phase 2 exploratory walk (the owner's checklist; branch audit/phase2-walk, never merged): every
/// tab, every sheet and every 3-dot menu is opened, shot, closed the way an owner closes it and shot
/// again so a leftover shows; every list's "Näytä enemmän"; upload → review → link; "Kohdista
/// varmat" → "Kumoa"; a credit note; Asetukset → Laitteet; sign out → sign in; offline and back.
///
/// It RECORDS, it does not judge. Each step writes a PASS/FAIL line to notes.txt (check/note), a
/// miss also keeps the element tree as <shot>-tree.txt beside the shots, and the walk goes on; the
/// only hard failure is not being signed in at all (setUp). Screenshots are XCTAttachments named
/// x<NN>-… (exported to ui-attachments/named) and the same names as host PNGs in ui-shots.
/// AUDIT-WALK.md maps the checklist to the methods and shot names.
///
/// Launched with `-LKUITest` (capture fixture, thumbnails) as OwnerScreensTests is, and run in CI with
/// its reader stub. Data: `demo-seed.ts --ci` plus `app/scripts/audit-seed.ts` (two sure pairs with a
/// rival each, an approved and a pending credit note, three free bank rows "Audit Täyte 1–3").
/// The methods share one demo DB and run in name order: x04 links a receipt, x05 links and takes
/// back the sure pairs, x10 signs the CI browser session out, x11 signs this app out and in again.
final class ExploratoryWalkTests: WalkTestCase {
    /// As OwnerScreensTests.setUp (WalkTestCase.setUp is not called: it launches without
    /// `-LKUITest`, and calling it as well would launch the app twice).
    override func setUp() {
        continueAfterFailure = true
        addUIInterruptionMonitor(withDescription: "system alert") { alert in
            for label in ["Don’t Allow", "Don't Allow", "Älä salli", "Not Now", "Ei nyt"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        app = XCUIApplication()
        app.launchArguments.append("-LKUITest")
        let signingIn = launchSignedIn()
        // The passkey offer after a password sign-in.
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        if signingIn { probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) } }
        sleep(1); dismissSystemPrompts()
        XCTAssertTrue(app.tabBars.firstMatch.exists, "not signed in: is the demo API up on the API_BASE_URL the app was built with?")
    }

    // MARK: - Koti

    /// Koti: the month, the whole page, the month stepper, the task rows and what they open.
    /// Koti has no 3-dot menu (its toolbar is the month stepper, Avustaja and Asetukset).
    func test01_Koti() {
        let previous = app.buttons["Edellinen kuukausi"].firstMatch
        let onKoti = previous.waitForExistence(timeout: 20)
        if onKoti { usleep(700_000) }
        xwShot("x01-koti")
        xwCheck("x01 Koti root painted (month stepper shown)", onKoti, tree: "x01-koti")
        xwScrollShots("x01-koti", screens: 4)
        xwToTop()

        if xwTapButton("Edellinen kuukausi") {
            let next = app.buttons["Seuraava kuukausi"].firstMatch
            let stepped = xwUntil(10) { next.exists && next.isEnabled }
            if stepped { usleep(700_000) }
            xwShot("x01-koti-edellinen-kuukausi")
            xwCheck("x01 Edellinen kuukausi swapped Koti to the previous month (Seuraava kuukausi enabled)", stepped, tree: "x01-koti-edellinen-kuukausi")
            if stepped, xwTapButton("Seuraava kuukausi") {
                let back = xwUntil(10) { next.exists && !next.isEnabled }
                if back { usleep(700_000) }
                xwShot("x01-koti-tama-kuukausi")
                xwCheck("x01 Seuraava kuukausi returned to this month (button disabled again)", back, tree: "x01-koti-tama-kuukausi")
            }
        } else {
            xwCheck("x01 Edellinen kuukausi button on Koti", false, tree: "x01-koti-kuukausi")
        }

        // "Tarvitaan sinulta" opens five tasks and grows by five.
        xwGrowAndFold("x01-koti-tarvitaan-sinulta", expected: false)
        xwToTop()

        // A task row: the overdue invoice opens the invoice.
        if xwTapVisible("label CONTAINS %@", "· myöhässä") {
            xwAfterPush(xwBarPrefix("Lasku "), "x01 Koti overdue task row → Lasku", shot: "x01-koti-myohassa-lasku")
            xwPop(to: app.buttons["Edellinen kuukausi"].firstMatch, "x01 back to Koti from the invoice", shot: "x01-koti-takaisin")
        } else {
            xwCheck("x01 Koti lists the overdue invoice task (· myöhässä)", false, tree: "x01-koti-tehtavat")
        }
        xwToTop()

        // The pill of the overdue task: the reminder sheet (Peruuta; Lähetä would send it).
        if xwTapVisible("label BEGINSWITH %@", "Muistuta: ") {
            let bar = xwBar("Lähetä maksumuistutus")
            if xwSheetUp(bar, "x01 Muistuta → Lähetä maksumuistutus sheet", shot: "x01-koti-muistuta") {
                xwCloseSheet(bar, "Lähetä maksumuistutus", with: ["Peruuta"], shot: "x01-koti-muistuta")
            }
        } else {
            note("INFO x01 no Muistuta pill on Koti (the pill reads Avaa while a reminder term runs)")
        }
        xwToTop()

        // A missing-receipt task's pill: the capture screen for that bank row (Peruuta).
        if xwTapVisible("label BEGINSWITH %@", "Kuvaa kuitti") {
            let bar = xwBar("Uusi kuitti")
            if xwSheetUp(bar, "x01 Kuvaa kuitti pill → Uusi kuitti for the bank row", shot: "x01-koti-kuvaa-kuitti") {
                xwCloseSheet(bar, "Uusi kuitti (bank row)", with: ["Peruuta", "Sulje"], shot: "x01-koti-kuvaa-kuitti")
            }
        } else {
            note("INFO x01 no Kuvaa kuitti pill on Koti")
        }
        xwToTop()

        // Rahatilanne heading → Pankki; Hoidettu automaattisesti → where the automation worked.
        if xwTapVisible("label BEGINSWITH %@", "Rahatilanne") {
            xwAfterPush(xwBar("Pankki"), "x01 Rahatilanne → Pankki", shot: "x01-koti-rahatilanne-pankki")
            xwPop(to: app.buttons["Edellinen kuukausi"].firstMatch, "x01 back to Koti from Pankki")
        } else {
            xwCheck("x01 Koti shows the Rahatilanne card", false, tree: "x01-koti-rahatilanne")
        }
        xwToTop()
        if xwTapVisible("label BEGINSWITH %@", "Hoidettu automaattisesti") {
            xwAfterPushAny("x01 Hoidettu automaattisesti opened a screen", shot: "x01-koti-hoidettu-automaattisesti")
            xwPop(to: app.buttons["Edellinen kuukausi"].firstMatch, "x01 back to Koti from Hoidettu automaattisesti")
        } else {
            note("INFO x01 no Hoidettu automaattisesti card (shown for 7 days after a reference payment)")
        }
        if xwTapVisible("label BEGINSWITH %@", "Tuonnit ja virheet", wait: 3) {
            xwAfterPush(xwBar("Tuonnit ja virheet"), "x01 Tuonnit ja virheet", shot: "x01-koti-tuonnit-ja-virheet")
            xwBack()
        } else {
            note("INFO x01 no Tuonnit ja virheet row on Koti (no failed import in the demo DB)")
        }
    }

    // MARK: - Myynti

    /// Myynti: root, chips, Erittely, the list's Näytä enemmän, an overdue and a draft invoice with
    /// their 3-dot menus and sheets, Uusi lasku, Asiakkaat, Toistuvat laskut, Maksut pankista.
    func test02_Myynti() {
        guard xwTab("Myynti", ready: app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset")).firstMatch, shot: "x02-myynti") else { return }
        xwScrollShots("x02-myynti", screens: 2)
        xwToTop()

        if xwTapVisible("label BEGINSWITH %@", "Luonnokset", wait: 5) {
            usleep(700_000)
            xwShot("x02-myynti-luonnokset")
            check("x02 chip Luonnokset tapped", true)
            if xwTapVisible("label MATCHES %@", "Kaikki(,? [0-9]+)?", wait: 5) { usleep(700_000); xwShot("x02-myynti-kaikki") } else { xwMiss("x02 chip Kaikki after Luonnokset", tree: "x02-myynti-kaikki") }
        } else {
            xwMiss("x02 chip Luonnokset on Myynti", tree: "x02-myynti-luonnokset")
        }
        if xwTapButton("Näytä erittely päivien mukaan", timeout: 5) {
            usleep(700_000)
            xwShot("x02-myynti-erittely")
            check("x02 Erittely opened the late buckets", app.buttons["Piilota erittely"].firstMatch.exists)
            xwTapButton("Piilota erittely", timeout: 3)
        } else {
            note("INFO x02 no Erittely button (only with late money)")
        }
        xwGrowAndFold("x02-myynti-laskut", expected: false)
        xwToTop()

        // The overdue invoice: tabs, quick actions, the 3-dot menu and every sheet it opens.
        if xwTapVisible("label CONTAINS %@", "· myöhässä") {
            let bar = xwBarPrefix("Lasku ")
            if xwAfterPush(bar, "x02 overdue invoice opened", shot: "x02-lasku-myohassa") {
                for chip in ["Rivit", "Maksut", "Historia", "Muistutus"] {
                    let button = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", chip)).firstMatch
                    if button.exists && button.isHittable {
                        button.tap(); taps += 1
                        usleep(700_000)
                        xwShot("x02-lasku-myohassa-\(chip.lowercased())")
                    } else {
                        note("INFO x02 invoice tab \(chip) not shown")
                    }
                }
                xwMenu("Toiminnot", item: "Avaa PDF", shot: "x02-lasku-3dot-menu")
                if xwTapButton("PDF", timeout: 5) {
                    let pdf = xwBarPrefix("Lasku-")
                    if xwSheetUp(pdf, "x02 PDF quick action → invoice PDF", shot: "x02-lasku-pdf") {
                        xwCloseSheet(pdf, "the invoice PDF", with: [], shot: "x02-lasku-pdf")
                    }
                } else {
                    xwMiss("x02 overdue invoice quick action PDF", tree: "x02-lasku-pdf")
                }
                if xwTapButton("Maksu", timeout: 5) {
                    let pay = xwBar("Kirjaa maksu")
                    if xwSheetUp(pay, "x02 Maksu → Kirjaa maksu", shot: "x02-lasku-kirjaa-maksu") {
                        xwCloseSheet(pay, "Kirjaa maksu", with: ["Peruuta"], shot: "x02-lasku-kirjaa-maksu")
                    }
                } else {
                    xwMiss("x02 overdue invoice quick action Maksu", tree: "x02-lasku-kirjaa-maksu")
                }
                if xwTapButton("Lähetä", timeout: 5) {
                    let send = xwBar("Lähetä lasku")
                    if xwSheetUp(send, "x02 Lähetä → Lähetä lasku", shot: "x02-lasku-laheta") {
                        xwCloseSheet(send, "Lähetä lasku", with: ["Peruuta"], shot: "x02-lasku-laheta")
                    }
                } else {
                    xwMiss("x02 overdue invoice quick action Lähetä", tree: "x02-lasku-laheta")
                }
                for (item, title, slug) in [("Hyvitä", "Hyvitä laskua", "hyvita"), ("Sulje perustelulla", "Sulje perustelulla", "sulje-perustelulla")] {
                    if xwMenuPick("Toiminnot", item) {
                        let sheet = xwBar(title)
                        if xwSheetUp(sheet, "x02 Toiminnot → \(item) → \(title)", shot: "x02-lasku-\(slug)") {
                            xwCloseSheet(sheet, title, with: ["Peruuta"], shot: "x02-lasku-\(slug)")
                        }
                    }
                }
                xwPop(to: xwBar("Myynti"), "x02 back to Myynti from the invoice")
            }
        } else {
            xwCheck("x02 Myynti lists the overdue invoice (· myöhässä)", false, tree: "x02-myynti-rivit")
        }
        xwToTop()

        // The draft: its own menu items and the edit form.
        if xwTapVisible("label BEGINSWITH %@", "Luonnokset", wait: 5) {
            usleep(700_000)
            if xwOpen("label CONTAINS %@", "Lasku ", xwBarPrefix("Lasku "), "x02 draft invoice opened", shot: "x02-lasku-luonnos") {
                xwMenu("Toiminnot", item: "Poista luonnos", shot: "x02-luonnos-3dot-menu")
                if xwTapButton("Muokkaa", timeout: 5) {
                    let edit = xwBar("Muokkaa laskua")
                    if xwSheetUp(edit, "x02 Muokkaa → Muokkaa laskua", shot: "x02-luonnos-muokkaa") {
                        xwCloseSheet(edit, "Muokkaa laskua", with: ["Peruuta"], shot: "x02-luonnos-muokkaa")
                    }
                } else {
                    xwMiss("x02 draft quick action Muokkaa", tree: "x02-luonnos-muokkaa")
                }
                xwPop(to: xwBar("Myynti"), "x02 back to Myynti from the draft")
            }
            _ = xwTapVisible("label MATCHES %@", "Kaikki(,? [0-9]+)?", wait: 5)
        }

        // Uusi lasku with its customer picker and a line's 3-dot menu.
        if xwTapButton("Uusi lasku") {
            let form = xwBar("Uusi lasku")
            if xwSheetUp(form, "x02 Uusi lasku form", shot: "x02-uusi-lasku") {
                xwInvoiceFormParts("x02-uusi-lasku")
                xwCloseSheet(form, "Uusi lasku", with: ["Peruuta"], shot: "x02-uusi-lasku")
            }
        } else {
            xwMiss("x02 Myynti toolbar button Uusi lasku", tree: "x02-uusi-lasku")
        }

        // Asiakkaat: its + menu and sheets, Kauneus Oy and its 3-dot menu and sheets.
        xwToTop()
        if xwOpen("label == %@", "Asiakkaat", xwBar("Asiakkaat"), "x02 Asiakkaat opened", shot: "x02-asiakkaat") {
            xwMenu("Lisää asiakkaita", item: "Tuo CSV", shot: "x02-asiakkaat-plus-menu")
            for (item, title, slug) in [("Uusi asiakas", "Uusi asiakas", "uusi-asiakas"), ("Tuo CSV", "Tuo asiakkaita", "tuo-csv")] {
                if xwMenuPick("Lisää asiakkaita", item) {
                    let sheet = xwBar(title)
                    if xwSheetUp(sheet, "x02 Lisää asiakkaita → \(item)", shot: "x02-asiakkaat-\(slug)") {
                        xwCloseSheet(sheet, title, with: ["Peruuta"], shot: "x02-asiakkaat-\(slug)")
                    }
                }
            }
            xwGrowAndFold("x02-asiakkaat", expected: false)
            if xwOpen("label CONTAINS %@", "Kauneus Oy", xwBar("Kauneus Oy"), "x02 customer Kauneus Oy opened", shot: "x02-asiakas") {
                xwMenu("Toiminnot", item: "Muokkaa", shot: "x02-asiakas-3dot-menu")
                for (item, title, slug) in [("Muokkaa", "Muokkaa asiakasta", "muokkaa"), ("Yhdistä kaksoiskappale", "Yhdistä kaksoiskappale", "yhdista")] {
                    if xwMenuPick("Toiminnot", item) {
                        let sheet = xwBar(title)
                        if xwSheetUp(sheet, "x02 asiakas Toiminnot → \(item)", shot: "x02-asiakas-\(slug)") {
                            xwCloseSheet(sheet, title, with: ["Peruuta"], shot: "x02-asiakas-\(slug)")
                        }
                    }
                }
                xwPop(to: xwBar("Asiakkaat"), "x02 back to Asiakkaat")
            }
            xwPop(to: xwBar("Myynti"), "x02 back to Myynti from Asiakkaat")
        }

        // Toistuvat laskut: + sheet, the seeded schedule, the list's Näytä enemmän.
        xwToTop()
        if xwOpen("label == %@", "Toistuvat laskut", xwBar("Toistuvat laskut"), "x02 Toistuvat laskut opened", shot: "x02-toistuvat") {
            if xwTapButton("Uusi toistuva lasku", timeout: 5) {
                let sheet = xwBar("Uusi toistuva lasku")
                if xwSheetUp(sheet, "x02 + → Uusi toistuva lasku", shot: "x02-toistuvat-uusi") {
                    xwCloseSheet(sheet, "Uusi toistuva lasku", with: ["Peruuta"], shot: "x02-toistuvat-uusi")
                }
            } else {
                xwMiss("x02 Toistuvat laskut toolbar + (Uusi toistuva lasku)", tree: "x02-toistuvat-uusi")
            }
            xwGrowAndFold("x02-toistuvat", expected: false)
            xwToTop(2)
            if xwOpen("label CONTAINS %@", "Kuukausiylläpito", xwBar("Kuukausiylläpito"), "x02 recurring invoice Kuukausiylläpito opened", shot: "x02-toistuva-kuukausiyllapito") {
                xwPop(to: xwBar("Toistuvat laskut"), "x02 back to Toistuvat laskut")
            }
            xwPop(to: xwBar("Myynti"), "x02 back to Myynti from Toistuvat laskut")
        }

        // Maksut pankista (a dry run; "Kirjaa maksut" would book them).
        if xwTapVisible("label BEGINSWITH %@", "Hae asiakkaiden maksut pankista") {
            let sheet = xwBar("Maksut pankista")
            if xwSheetUp(sheet, "x02 Hae asiakkaiden maksut pankista → Maksut pankista", shot: "x02-maksut-pankista") {
                xwCloseSheet(sheet, "Maksut pankista", with: ["Sulje", "Peruuta"], shot: "x02-maksut-pankista")
            }
        } else {
            xwCheck("x02 Myynti offers Hae asiakkaiden maksut pankista", false, tree: "x02-myynti-muut")
        }
    }

    // MARK: - Kuitit

    /// Kuitit: every chip, the filter menu and Summarajaus, select mode and its bar, Näytä enemmän,
    /// a row's swipe, a receipt's 3-dot menu, delete question, Muokkaa, Näytä kuitti and the bank picker.
    func test03_Kuitit() {
        guard xwOpenKuitit(tab: "all") else { return }
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ABC Prisma Kotka")).firstMatch
        let listed = rows.waitForExistence(timeout: 20)
        if listed { usleep(700_000) }
        xwShot("x03-kuitit")
        xwCheck("x03 Kuitit lists the seed receipts", listed, tree: "x03-kuitit")
        if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Odottaa hyväksyntää")).firstMatch.exists {
            note("INFO x03 the review queue (Odottaa hyväksyntää) is above the chips")
        }
        for (id, title) in [("all", "Kaikki"), ("tulo", "Tulot"), ("meno", "Menot"), ("linked", "Kohdistettu"), ("unlinked", "Ei kohdistettu"), ("laskut", "Laskut")] {
            let chip = app.buttons["receipt-tab-\(id)"].firstMatch
            let tapped = xwChip(id)
            usleep(800_000)
            xwShot("x03-kuitit-chip-\(id)")
            xwCheck("x03 chip \(title) (\(chip.exists ? chip.label : "missing"))", tapped, tree: "x03-kuitit-chip-\(id)")
            if id == "unlinked" {
                let sure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat (")).firstMatch
                note("INFO x03 Ei kohdistettu bar: \(sure.waitForExistence(timeout: 15) ? sure.label : "none")")
            }
        }
        _ = xwChip("all")

        // The filter menu, and the amount alert it opens.
        xwMenu("Suodata kuitteja", item: "Summa…", shot: "x03-kuitit-suodatin-menu")
        if xwMenuPick("Suodata kuitteja", "Summa…") {
            let alert = app.alerts["Summarajaus"].firstMatch
            let up = alert.waitForExistence(timeout: 8)
            if up { usleep(600_000) }
            xwShot("x03-kuitit-summarajaus")
            xwCheck("x03 Summa… opened the Summarajaus alert", up, tree: "x03-kuitit-summarajaus")
            let cancel = alert.buttons["Peru"].firstMatch
            if up && cancel.exists { cancel.tap(); taps += 1 }
            let gone = xwGone(alert)
            xwShot("x03-kuitit-summarajaus-peruttu")
            xwCheck("x03 Peru closed the Summarajaus alert", gone, tree: "x03-kuitit-summarajaus-peruttu")
        }

        // Select mode: one row picked, the bar, Peruuta.
        if xwTapButton("Valitse kuitteja", timeout: 5) {
            let all = app.buttons["Valitse kaikki"].firstMatch
            let selecting = all.waitForExistence(timeout: 5)
            xwShot("x03-kuitit-valinta")
            xwCheck("x03 Valitse kuitteja turned select mode on", selecting, tree: "x03-kuitit-valinta")
            if selecting, xwReveal(rows) {
                rows.tap(); taps += 1
                let bar = app.staticTexts["1 valittu"].firstMatch
                let shown = bar.waitForExistence(timeout: 5)
                if shown { usleep(600_000) }
                xwShot("x03-kuitit-valinta-palkki")
                xwCheck("x03 a picked row shows the bulk bar (1 valittu)", shown, tree: "x03-kuitit-valinta-palkki")
            }
            let cancel = app.buttons["Peruuta"].firstMatch
            if cancel.exists && cancel.isHittable { cancel.tap() } else { xwTapButton("Valmis", timeout: 3) }
            taps += 1
            let off = xwGone(all, timeout: 5)
            xwShot("x03-kuitit-valinta-pois")
            xwCheck("x03 select mode left", off, tree: "x03-kuitit-valinta-pois")
        } else {
            xwMiss("x03 Kuitit toolbar button Valitse kuitteja", tree: "x03-kuitit-valinta")
        }
        xwToTop()

        xwGrowAndFold("x03-kuitit", expected: true)
        xwToTop()

        // A row's swipe shows Poista; swiped back without deleting.
        if xwReveal(rows) {
            rows.swipeLeft()
            let delete = app.buttons["Poista"].firstMatch
            let shown = delete.waitForExistence(timeout: 4)
            xwShot("x03-kuitit-rivi-pyyhkaisy")
            xwCheck("x03 a row's swipe offers Poista", shown, tree: "x03-kuitit-rivi-pyyhkaisy")
            if rows.exists { rows.swipeRight() }
            let closed = xwGone(delete, timeout: 4)
            xwShot("x03-kuitit-rivi-pyyhkaisy-kiinni")
            xwCheck("x03 swiping back hid Poista", closed, tree: "x03-kuitit-rivi-pyyhkaisy-kiinni")
        } else {
            xwMiss("x03 row ABC Prisma Kotka on screen for its swipe", tree: "x03-kuitit-rivi-pyyhkaisy")
        }
        xwToTop()

        // The receipt: menu, delete question, edit form, the file, the bank picker.
        guard xwReveal(rows) else { xwCheck("x03 row ABC Prisma Kotka on screen", false, tree: "x03-kuitit-abc"); return }
        rows.tap(); taps += 1
        let actions = app.navigationBars.buttons["Toiminnot"].firstMatch
        guard xwAfterPush(actions, "x03 receipt ABC Prisma Kotka opened (Toiminnot shown)", shot: "x03-kuitti") else { return }
        xwScrollShots("x03-kuitti", screens: 1)
        xwToTop(2)
        xwMenu("Toiminnot", item: "Poista kuitti", shot: "x03-kuitti-3dot-menu")
        if xwMenuPick("Toiminnot", "Poista kuitti") {
            xwConfirmCancel("x03 Poista kuitti", titlePrefix: "Poistetaanko kuitti · ", shot: "x03-kuitti-poista")
        }
        if xwMenuPick("Toiminnot", "Muokkaa") {
            let edit = xwBar("Muokkaa kuittia")
            if xwSheetUp(edit, "x03 Toiminnot → Muokkaa → Muokkaa kuittia", shot: "x03-kuitti-muokkaa") {
                xwCloseSheet(edit, "Muokkaa kuittia", with: ["Peruuta"], shot: "x03-kuitti-muokkaa")
            }
        }
        xwToTop(2)
        if xwTapVisible("label == %@", "Näytä kuitti") {
            let file = xwBar("abc.pdf")
            if xwSheetUp(file, "x03 Näytä kuitti → the receipt's file", shot: "x03-kuitti-nayta") {
                xwCloseSheet(file, "the receipt's file", with: [], shot: "x03-kuitti-nayta")
            }
        } else {
            xwMiss("x03 the receipt offers Näytä kuitti", tree: "x03-kuitti-nayta")
        }
        xwToTop(2)
        if xwTapVisible("label == %@", "Valitse muu pankkitapahtuma") {
            let picker = xwBar("Valitse pankkitapahtuma")
            if xwSheetUp(picker, "x03 Valitse muu pankkitapahtuma → bank picker", shot: "x03-pankkivalitsin") {
                xwGrowAndFold("x03-pankkivalitsin", expected: true, inSheet: true)
                xwCloseSheet(picker, "Valitse pankkitapahtuma", with: ["Sulje"], shot: "x03-pankkivalitsin")
            }
        } else {
            xwCheck("x03 the receipt offers Valitse muu pankkitapahtuma", false, tree: "x03-kuitti-pankki")
        }
        xwPop(to: xwBar("Kuitit"), "x03 back to Kuitit", shot: "x03-kuitit-takaisin")
    }

    // MARK: - Upload → review → link

    /// Kuitit's camera button → "Testikuitti" → the reading → the form → Tallenna kuitti; the queue's
    /// 3-dot and "Lisää tiedostoja" menus; the saved receipt in Kuitit (reviewed: Hyväksy if it
    /// waits); linked by hand to the free bank row "Audit Täyte 2" through the bank picker.
    func test04_UploadReviewLink() {
        guard xwOpenKuitit(tab: "all") else { return }
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        (camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch).tap(); taps += 1
        let fixture = app.buttons["capture-fixture"].firstMatch
        let picking = fixture.waitForExistence(timeout: 10)
        xwShot("x04-uusi-kuitti")
        guard xwCheck("x04 Kuvaa kuitti opened Uusi kuitti with the Testikuitti fixture", picking, tree: "x04-uusi-kuitti") else { return }
        if !fixture.isHittable { app.swipeUp() }
        fixture.tap(); taps += 1
        xwShot("x04-lahetetaan")

        // Uploaded and read (CI: the reader stub's bill without a date); the form opens by itself.
        let preview = app.descendants(matching: .any).matching(identifier: "captured-file-preview").firstMatch
        if !preview.waitForExistence(timeout: 90) {
            let use = app.buttons["Käytä lomakkeessa"].firstMatch
            if use.exists { use.tap(); _ = preview.waitForExistence(timeout: 10) }
        }
        if preview.exists { usleep(700_000) }
        xwShot("x04-lomake")
        let vendor = xwField("Myyjä")
        guard xwCheck("x04 the reading opened the form with the file's picture", preview.exists && vendor.waitForExistence(timeout: 5), tree: "x04-lomake") else { return }
        if xwBlank(vendor, "Myyjä") { type(vendor, "Testikauppa Oy") }
        let total = xwField("Summa €")
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && xwBlank(total, "Summa €") { type(total, "12") }
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let category = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if category.waitForExistence(timeout: 5), category.label.hasSuffix("Valitse") {
            if !category.isHittable { app.swipeUp() }
            category.tap()
            let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
            if choice.waitForExistence(timeout: 5) { choice.tap() }
        }
        xwShot("x04-lomake-taytetty")
        guard tap("Tallenna kuitti") else { xwCheck("x04 Tallenna kuitti on the form", false, tree: "x04-lomake-taytetty"); return }

        let toast = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tallennettu · ")).firstMatch
        let screen = app.navigationBars["Uusi kuitti"]
        var outcome = ""
        _ = xwUntil(30) {
            if toast.exists { outcome = "toast"; return true }
            if !screen.exists { outcome = "closed"; return true }
            return false
        }
        let toastText = outcome == "toast" && toast.exists ? toast.label : outcome
        xwShot("x04-tallennettu")
        xwCheck("x04 Tallenna kuitti saved (\(toastText.isEmpty ? "no toast, screen still up" : toastText))", !outcome.isEmpty, tree: "x04-tallennettu")

        if screen.exists {
            // The queue after the save: its 3-dot menu and "Lisää tiedostoja".
            xwMenu("Toiminnot", item: "Siirry kuitteihin", shot: "x04-jono-3dot-menu")
            let addMore = app.buttons["Lisää tiedostoja"].firstMatch
            if xwReveal(addMore) {
                addMore.tap(); taps += 1
                let entry = app.buttons["Valitse tiedosto"].firstMatch
                let opened = entry.waitForExistence(timeout: 5)
                if opened { usleep(600_000) }
                xwShot("x04-jono-lisaa-tiedostoja-auki")
                xwCheck("x04 Lisää tiedostoja lists Valitse tiedosto", opened, tree: "x04-jono-lisaa-tiedostoja-auki")
                if opened { xwCloseMenu() }
                xwShot("x04-jono-lisaa-tiedostoja-suljettu")
                xwCheck("x04 Lisää tiedostoja closed by a tap beside it", xwGone(entry, timeout: 5), tree: "x04-jono-lisaa-tiedostoja-suljettu")
            } else {
                xwMiss("x04 the queue offers Lisää tiedostoja", tree: "x04-jono-lisaa-tiedostoja")
            }
            let primary = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Valmis", "Näytä tarkistettavat")).firstMatch
            if xwReveal(primary) { primary.tap(); taps += 1 }
            let closed = xwGone(screen, timeout: 10)
            xwShot("x04-jono-suljettu")
            xwCheck("x04 the queue's primary button closed Uusi kuitti", closed, tree: "x04-jono-suljettu")
        }

        // Review: the saved receipt (a bill the stub reads is filed under Laskut).
        _ = app.navigationBars["Kuitit"].waitForExistence(timeout: 10)
        var receipt = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Testikauppa")).firstMatch
        var found = false
        for chip in ["all", "laskut"] where !found {
            _ = xwChip(chip)
            receipt = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Testikauppa")).firstMatch
            found = xwReveal(receipt, maxSwipes: 3)
        }
        xwShot("x04-kuitit-tallennettu-rivi")
        guard xwCheck("x04 the saved receipt is listed in Kuitit", found, tree: "x04-kuitit-tallennettu-rivi") else { _ = xwChip("all"); return }
        receipt.tap(); taps += 1
        guard xwAfterPush(app.navigationBars.buttons["Toiminnot"].firstMatch, "x04 the saved receipt opened", shot: "x04-tarkistus") else { return }
        if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tämä on ostolasku")).firstMatch.exists {
            note("INFO x04 the saved receipt is filed as an ostolasku")
        }
        if xwTapVisible("label == %@", "Hyväksy", wait: 3) {
            let approved = app.staticTexts["Hyväksytty"].firstMatch.waitForExistence(timeout: 15)
            xwShot("x04-tarkistus-hyvaksytty")
            xwCheck("x04 Hyväksy approved the receipt", approved, tree: "x04-tarkistus-hyvaksytty")
        } else {
            note("INFO x04 nothing to approve: the server accepted the reading (Tila: Hyväksytty)")
        }

        // Link by hand: the bank picker, searched by amount for "Audit Täyte 2" (23,45 €).
        xwToTop(2)
        guard xwTapVisible("label == %@", "Valitse muu pankkitapahtuma") else {
            xwCheck("x04 the saved receipt offers Valitse muu pankkitapahtuma", false, tree: "x04-linkitys"); return
        }
        let picker = xwBar("Valitse pankkitapahtuma")
        guard xwSheetUp(picker, "x04 bank picker for the saved receipt", shot: "x04-pankkivalitsin") else { return }
        let search = app.searchFields.matching(NSPredicate(format: "placeholderValue == %@", "Nimi, viesti tai summa")).firstMatch
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Audit Täyte 2")).firstMatch
        if search.waitForExistence(timeout: 5) {
            type(search, "23,45")
            _ = row.waitForExistence(timeout: 15)
            xwShot("x04-pankkivalitsin-haku")
        }
        guard xwReveal(row) else { xwCheck("x04 the picker lists Audit Täyte 2", false, tree: "x04-pankkivalitsin-haku"); return }
        row.tap(); taps += 1
        let sheet = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        let asked = sheet.waitForExistence(timeout: 8)
        if asked { usleep(700_000) }
        xwShot("x04-kohdistetaanko")
        let title = app.staticTexts["confirm-sheet-title"].firstMatch
        xwCheck("x04 picking the row asks Kohdistetaanko (\(asked && title.exists ? title.label : "no sheet"))", asked, tree: "x04-kohdistetaanko")
        guard asked else { return }
        app.buttons["confirm-sheet-confirm"].firstMatch.tap(); taps += 1
        let unlink = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Poista kohdistus")).firstMatch
        let linked = xwGone(picker, timeout: 15) && unlink.waitForExistence(timeout: 15)
        if linked { usleep(600_000) }
        xwShot("x04-kohdistettu")
        xwCheck("x04 Kohdista linked the receipt to Audit Täyte 2 (Poista kohdistus shown)", linked, tree: "x04-kohdistettu")
        if picker.exists { xwCloseSheet(picker, "Valitse pankkitapahtuma", with: ["Sulje"], shot: "x04-pankkivalitsin") }
        xwPop(to: xwBar("Kuitit"), "x04 back to Kuitit", shot: "x04-kuitit-lopuksi")
        _ = xwChip("all")
    }

    // MARK: - Kohdista varmat → Kumoa

    /// Ei kohdistettu → "Kohdista varmat (N)" (N from the server's own GET /api/matching/sure) →
    /// the toast's "Kumoa" inside its 5 s → "N kohdistusta kumottu." → the bar again. A second
    /// round shoots the "N kuittia kohdistettu." toast itself before taking it back.
    func test05_SureMatchesUndo() {
        let expected = xwDemoAPI("/api/matching/sure")?["count"] as? Int ?? -1
        note("INFO x05 server GET /api/matching/sure count: \(expected)")
        guard xwOpenKuitit(tab: "unlinked") else { return }
        let bar = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat (")).firstMatch
        let shown = bar.waitForExistence(timeout: 25)
        if shown { usleep(700_000) }
        let label = shown ? bar.label : ""
        xwShot("x05-kohdista-varmat")
        guard xwCheck("x05 Ei kohdistettu shows \(shown ? label : "no Kohdista varmat bar") (server: \(expected))", shown, tree: "x05-kohdista-varmat") else {
            _ = xwChip("all"); return
        }
        let count = xwLastNumber(label)
        if expected >= 0 { check("x05 the bar's count is the server's (\(label), server \(expected))", count == expected) }

        // Round 1: link, and take it back at once: the toast lives 5 s and a CI screenshot takes seconds.
        bar.tap(); taps += 1
        let undo = app.buttons["Kumoa"].firstMatch
        let offered = undo.waitForExistence(timeout: 20)
        if offered { undo.tap(); taps += 1 }
        xwCheck("x05 Kohdista varmat linked and the toast offered Kumoa", offered, tree: "x05-ei-kumoa")
        let restored = app.staticTexts[xwRestoredText(count)].firstMatch
        let undone = offered && restored.waitForExistence(timeout: 15)
        xwShot("x05-kumottu")
        xwCheck("x05 Kumoa answered \"\(xwRestoredText(count))\"", undone, tree: "x05-kumottu")
        let back = bar.waitForExistence(timeout: 25)
        if back { usleep(700_000) }
        let again = back ? bar.label : ""
        xwShot("x05-kohdista-varmat-taas")
        xwCheck("x05 after Kumoa the bar is back as before (\(again.isEmpty ? "no bar" : again))", again == label, tree: "x05-kohdista-varmat-taas")
        guard back else { _ = xwChip("all"); return }

        // Round 2: the confirmation toast on picture, taken in-process (no wait for the host), then Kumoa.
        bar.tap(); taps += 1
        if undo.waitForExistence(timeout: 20) {
            let picture = XCUIScreen.main.screenshot()
            let inTime = undo.exists && undo.isHittable
            if inTime { undo.tap(); taps += 1 }
            let attachment = XCTAttachment(screenshot: picture)
            attachment.name = "x05-kohdistettu-toast"
            attachment.lifetime = .keepAlways
            add(attachment)
            check("x05 second round: Kumoa still on screen after the toast's picture (\(xwLinkedText(count)))", inTime)
            if !inTime { note("FAIL x05 second round missed Kumoa: the \(count) pairs stay linked for the rest of the class") }
            let undoneAgain = app.staticTexts[xwRestoredText(count)].firstMatch.waitForExistence(timeout: 15)
            xwShot("x05-kumottu-toinen")
            xwCheck("x05 second Kumoa answered \"\(xwRestoredText(count))\"", undoneAgain, tree: "x05-kumottu-toinen")
            let settled = bar.waitForExistence(timeout: 25)
            xwShot("x05-lopuksi")
            xwCheck("x05 the bar is back after the second Kumoa", settled, tree: "x05-lopuksi")
        } else {
            xwCheck("x05 second round: the toast offered Kumoa", false, tree: "x05-toinen-kierros")
        }
        _ = xwChip("all")
    }

    // MARK: - Credit note

    /// A hyvityslasku receipt (audit seed): its row in Kaikki (a positive size, no minus), its detail
    /// ("Hyvityslasku · Meno", "−50,00 €"), its 3-dot menu; and the pending one in the review queue.
    func test06_CreditNote() {
        guard xwOpenKuitit(tab: "all") else { return }
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Audit Hyvitys Oy")).firstMatch
        let found = xwReveal(row)
        xwShot("x06-hyvitys-rivi")
        if xwCheck("x06 the credit note Audit Hyvitys Oy is listed in Kaikki", found, tree: "x06-hyvitys-rivi") {
            let text = row.label
            note("INFO x06 credit-note row label: \(text)")
            check("x06 the row shows the size 50,00", text.contains("50,00"))
            check("x06 the row shows no minus sign (\u{2212} or -)", !text.contains("\u{2212}") && !text.contains("-50"))
            row.tap(); taps += 1
            if xwAfterPush(app.navigationBars.buttons["Toiminnot"].firstMatch, "x06 credit-note receipt opened", shot: "x06-hyvitys-kuitti") {
                check("x06 detail caption Hyvityslasku · Meno", app.staticTexts["Hyvityslasku · Meno"].firstMatch.waitForExistence(timeout: 5))
                check("x06 detail amount −50,00 €", xwAny("label CONTAINS %@", "\u{2212}50,00").exists)
                xwScrollShots("x06-hyvitys-kuitti", screens: 1)
                xwToTop(2)
                xwMenu("Toiminnot", item: "Poista kuitti", shot: "x06-hyvitys-3dot-menu")
            }
            if !xwBar("Kuitit").exists { xwPop(to: xwBar("Kuitit"), "x06 back to Kuitit") }
        }
        xwToTop()

        // The pending one waits in "Odottaa hyväksyntää" above the chips.
        let queue = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Odottaa hyväksyntää")).firstMatch
        let queued = queue.waitForExistence(timeout: 10)
        xwShot("x06-tarkastettavat")
        xwCheck("x06 Kuitit shows the review queue (\(queued ? queue.label : "none"))", queued, tree: "x06-tarkastettavat")
        let pending = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Audit Hyvitys Odottaa Oy")).firstMatch
        if xwReveal(pending) {
            pending.tap(); taps += 1
            if xwAfterPush(app.navigationBars.buttons["Toiminnot"].firstMatch, "x06 pending credit note opened", shot: "x06-hyvitys-odottaa") {
                check("x06 pending credit note says Hyvityslasku · Meno", app.staticTexts["Hyvityslasku · Meno"].firstMatch.exists)
                check("x06 pending credit note offers Hyväksy and Hylkää", app.buttons["Hyväksy"].firstMatch.exists && app.buttons["Hylkää"].firstMatch.exists)
                xwScrollShots("x06-hyvitys-odottaa", screens: 1)
                xwPop(to: xwBar("Kuitit"), "x06 back to Kuitit from the pending credit note")
            }
        } else {
            xwCheck("x06 the pending credit note is in the review queue", false, tree: "x06-tarkastettavat-rivi")
        }
    }

    // MARK: - Raportit

    /// Raportit: the page, the year stepper, the Menot and Tulot drills, Luokittain, the zip and a
    /// CSV sheet. Raportit has no 3-dot menu.
    func test07_Raportit() {
        guard xwTab("Raportit", ready: app.buttons["Edellinen vuosi"].firstMatch, shot: "x07-raportit") else { return }
        xwScrollShots("x07-raportit", screens: 4)
        xwToTop(6)
        if xwTapButton("Edellinen vuosi") {
            usleep(800_000)
            xwShot("x07-raportit-edellinen-vuosi")
            let next = app.buttons["Seuraava vuosi"].firstMatch
            check("x07 Edellinen vuosi stepped back (Seuraava vuosi enabled)", next.exists && next.isEnabled)
            xwTapButton("Seuraava vuosi")
            usleep(800_000)
            xwShot("x07-raportit-tama-vuosi")
        } else {
            xwMiss("x07 Raportit year stepper Edellinen vuosi", tree: "x07-raportit-vuosi")
        }
        let root = xwBar("Raportit")
        if xwOpen("label BEGINSWITH %@", "Menot", xwBar("Kuitit"), "x07 Menot drill → Kuitit", shot: "x07-menot-kuitit") {
            check("x07 the Menot drill opens Kuitit on Menot", app.buttons["receipt-tab-meno"].firstMatch.exists)
            xwPop(to: root, "x07 back to Raportit from Menot")
        }
        xwToTop(4)
        if xwTapVisible("label BEGINSWITH %@", "Tulot") {
            xwAfterPushAny("x07 Tulot drill opened a list", shot: "x07-tulot")
            xwPop(to: root, "x07 back to Raportit from Tulot")
        } else {
            xwMiss("x07 Raportit row Tulot", tree: "x07-tulot")
        }
        let tulot = app.segmentedControls.buttons["Tulot"].firstMatch
        if xwReveal(tulot) {
            tulot.tap(); taps += 1
            usleep(700_000)
            xwShot("x07-luokittain-tulot")
            let menot = app.segmentedControls.buttons["Menot"].firstMatch
            if menot.exists { menot.tap(); taps += 1; usleep(700_000); xwShot("x07-luokittain-menot") }
        } else {
            note("INFO x07 no Luokittain picker (only when both Tulot and Menot have categories)")
        }
        xwGrowAndFold("x07-luokittain", expected: false)
        if xwTapVisible("label BEGINSWITH %@", "Lataa zip") {
            let zip = xwBarPrefix("kirjanpito-")
            if xwSheetUp(zip, "x07 Lataa zip → kirjanpitopaketti", shot: "x07-lataa-zip") {
                xwCloseSheet(zip, "the zip", with: [], shot: "x07-lataa-zip")
            }
        } else {
            xwMiss("x07 Kirjanpitopaketti button Lataa zip", tree: "x07-lataa-zip")
        }
        if xwTapVisible("label BEGINSWITH %@", "Tuloslaskelma") {
            let csv = xwBarPrefix("profit-loss-")
            if xwSheetUp(csv, "x07 Vienti (CSV) Tuloslaskelma → CSV", shot: "x07-csv-tuloslaskelma") {
                xwCloseSheet(csv, "the CSV", with: [], shot: "x07-csv-tuloslaskelma")
            }
        } else {
            xwMiss("x07 Vienti (CSV) button Tuloslaskelma", tree: "x07-csv-tuloslaskelma")
        }
    }

    // MARK: - Pankki

    /// The Kirjanpito hub, Pankki, Pankkitapahtumat (calendar and 3-dot menus, Vaatii toimia,
    /// Näytä enemmän, a bank row's sheet), Pankkiyhteys ja tilit (account sheet, Lisää tili käsin),
    /// Tiliotteet and a statement with its 3-dot menu and Näytä enemmän.
    func test08_Pankki() {
        guard xwTab("Kirjanpito", ready: app.staticTexts["Kohdista kuitit"].firstMatch, shot: "x08-kirjanpito") else { return }
        xwScrollShots("x08-kirjanpito", screens: 1)
        xwToTop(2)
        guard tap("Pankki"), xwAfterPush(xwBar("Pankki"), "x08 Pankki hub opened", shot: "x08-pankki") else {
            xwCheck("x08 Kirjanpito → Pankki", false, tree: "x08-pankki"); return
        }
        xwScrollShots("x08-pankki", screens: 2)
        xwToTop(3)

        let feed = xwBar("Pankkitapahtumat")
        if xwOpen("label BEGINSWITH %@", "Näytä kaikki", feed, "x08 Näytä kaikki → Pankkitapahtumat", shot: "x08-pankkitapahtumat") {
            xwMenu("Valitse kuukausi", item: "Kaikki kuukaudet", shot: "x08-pankkitapahtumat-kalenteri-menu")
            xwMenu("Toiminnot", item: "Etsi kuitteja uudelleen", shot: "x08-pankkitapahtumat-3dot-menu")
            let needsAction = app.segmentedControls.buttons["Vaatii toimia"].firstMatch
            if needsAction.waitForExistence(timeout: 5), needsAction.isHittable {
                needsAction.tap(); taps += 1
                usleep(800_000)
                xwShot("x08-pankkitapahtumat-vaatii-toimia")
                let all = app.segmentedControls.buttons["Kaikki"].firstMatch
                if all.exists { all.tap(); taps += 1; usleep(800_000) }
            } else {
                xwMiss("x08 Pankkitapahtumat segment Vaatii toimia", tree: "x08-pankkitapahtumat-vaatii-toimia")
            }
            xwGrowAndFold("x08-pankkitapahtumat", expected: true)
            xwToTop(6)
            if xwTapVisible("label CONTAINS %@", "K-Market 1") {
                // The sheet's title is the row's state ("Kuitti puuttuu" for this one).
                let sheet = xwBar("Kuitti puuttuu")
                if xwSheetUp(sheet, "x08 a bank row → its sheet (Kuitti puuttuu)", shot: "x08-pankkirivi") {
                    xwCloseSheet(sheet, "the bank row's sheet", with: ["Valmis"], shot: "x08-pankkirivi")
                } else if let done = xwHittable("Valmis", timeout: 2) {
                    done.tap(); taps += 1
                }
            } else {
                xwMiss("x08 Pankkitapahtumat lists the bank row K-Market 1", tree: "x08-pankkirivi")
            }
            xwPop(to: xwBar("Pankki"), "x08 back to Pankki from Pankkitapahtumat")
        }

        if xwOpen("label BEGINSWITH %@", "Pankkiyhteys ja tilit", xwBar("Pankkiyhteys ja tilit"), "x08 Pankkiyhteys ja tilit opened", shot: "x08-pankkiyhteys") {
            if xwTapVisible("label BEGINSWITH %@", "Käyttötili") {
                let account = xwBar("Käyttötili")
                if xwSheetUp(account, "x08 Käyttötili → the account's sheet", shot: "x08-tili") {
                    xwCloseSheet(account, "Käyttötili", with: ["Valmis"], shot: "x08-tili")
                }
            } else {
                xwMiss("x08 Pankkiyhteys ja tilit lists the account Käyttötili", tree: "x08-tili")
            }
            if xwTapVisible("label == %@", "Lisää tili käsin") {
                let form = xwBar("Uusi pankkitili")
                if xwSheetUp(form, "x08 Lisää tili käsin → Uusi pankkitili", shot: "x08-uusi-tili") {
                    xwCloseSheet(form, "Uusi pankkitili", with: ["Peruuta"], shot: "x08-uusi-tili")
                }
            } else {
                xwMiss("x08 Pankkiyhteys ja tilit offers Lisää tili käsin", tree: "x08-uusi-tili")
            }
            xwPop(to: xwBar("Pankki"), "x08 back to Pankki from Pankkiyhteys ja tilit")
        }

        if xwOpen("label BEGINSWITH %@", "Tiliotteet", xwBar("Tiliotteet"), "x08 Tiliotteet opened", shot: "x08-tiliotteet") {
            xwGrowAndFold("x08-tiliotteet", expected: false)
            xwToTop(3)
            // The seed's long statement (tiliote-pitka.csv, 26 rows: longer than one step of 10).
            if xwOpen("label CONTAINS %@", "26 tapahtumaa", xwBarPrefix("Tiliote · "), "x08 the 26-row statement opened", shot: "x08-tiliote") {
                xwMenu("Toiminnot", item: "Tunnista palkat uudelleen", shot: "x08-tiliote-3dot-menu")
                xwGrowAndFold("x08-tiliote", expected: true)
                xwPop(to: xwBar("Tiliotteet"), "x08 back to Tiliotteet")
            }
            xwPop(to: xwBar("Pankki"), "x08 back to Pankki from Tiliotteet")
        }
        xwPop(to: app.staticTexts["Kohdista kuitit"].firstMatch, "x08 back to the Kirjanpito hub", shot: "x08-kirjanpito-lopuksi")
    }

    // MARK: - Avustaja

    /// The assistant (the only chat: the top bar's "Avustaja" sheet), its attach menu, the
    /// Keskustelut sheet (Aktiiviset, Arkisto), closed with Valmis.
    func test09_Chat() {
        guard xwTapButton("Avustaja") else { xwCheck("x09 Avustaja button on Koti", false, tree: "x09-koti"); return }
        // The multi-line composer is a text view or a text field depending on the system (P4Tests).
        let up = xwUntil(15) { self.app.textViews.firstMatch.exists || self.app.textFields.firstMatch.exists }
        let conversations = app.buttons["Keskustelut"].firstMatch
        if up { usleep(700_000) }
        xwShot("x09-avustaja")
        xwCheck("x09 Avustaja opened with a composer", up, tree: "x09-avustaja")
        let attach = app.buttons["Lähetä kuitti"].firstMatch
        if attach.exists && attach.isEnabled {
            xwMenu("Lähetä kuitti", item: "Valitse kuva", shot: "x09-avustaja-liite-menu")
        } else {
            note("INFO x09 the attach menu (Lähetä kuitti) is \(attach.exists ? "disabled" : "absent")")
        }
        if xwTapButton("Keskustelut", timeout: 5) {
            let list = xwBar("Keskustelut")
            if xwSheetUp(list, "x09 Keskustelut sheet", shot: "x09-keskustelut") {
                if xwTapButton("Arkisto", timeout: 5) {
                    usleep(700_000); xwShot("x09-keskustelut-arkisto")
                    xwTapButton("Aktiiviset", timeout: 5)
                } else {
                    xwMiss("x09 Keskustelut segment Arkisto", tree: "x09-keskustelut-arkisto")
                }
                xwGrowAndFold("x09-keskustelut", expected: false, inSheet: true)
                xwCloseSheet(list, "Keskustelut", with: ["Valmis"], shot: "x09-keskustelut")
            }
        } else {
            xwMiss("x09 Avustaja toolbar button Keskustelut", tree: "x09-keskustelut")
        }
        let done = app.buttons.matching(NSPredicate(format: "label == %@", "Valmis")).allElementsBoundByIndex.first { $0.isHittable }
        if let done { done.tap(); taps += 1 } else { swipeSheetDown("Avustaja") }
        let closed = xwGone(conversations, timeout: 8)
        if closed { usleep(500_000) }
        xwShot("x09-avustaja-suljettu")
        xwCheck("x09 Valmis closed Avustaja", closed, tree: "x09-avustaja-suljettu")
    }

    // MARK: - Asetukset → Laitteet

    /// Asetukset (the sheet from the top bar) → Laitteet: the list, a device's swipe and its
    /// question (Peruuta), "Kirjaa ulos kaikki muut laitteet" (Peruuta), then the CI browser session
    /// ("Selain") really signed out, as an owner would; closed with Valmis.
    func test10_Asetukset_Laitteet() {
        guard xwOpenSettings(shot: "x10-asetukset") else { return }
        guard tap("Laitteet"), xwAfterPush(xwBar("Laitteet"), "x10 Laitteet opened", shot: "x10-laitteet") else {
            xwCheck("x10 Asetukset → Laitteet", false, tree: "x10-laitteet"); return
        }
        let browser = app.staticTexts["Selain"].firstMatch
        let listed = browser.waitForExistence(timeout: 15)
        let browsers = app.staticTexts.matching(NSPredicate(format: "label == %@", "Selain")).count
        if listed { usleep(500_000); xwShot("x10-laitteet-lista") }
        check("x10 Laitteet lists this device", xwAny("label CONTAINS %@", "(tämä laite)").exists)
        xwCheck("x10 Laitteet lists the CI browser session Selain (\(browsers))", listed, tree: "x10-laitteet")

        if xwTapVisible("label == %@", "Kirjaa ulos kaikki muut laitteet") {
            xwConfirmCancel("x10 Kirjaa ulos kaikki muut laitteet", titlePrefix: "Kirjataanko kaikki muut laitteet ulos?", shot: "x10-kaikki-muut")
        } else {
            xwMiss("x10 Laitteet offers Kirjaa ulos kaikki muut laitteet", tree: "x10-kaikki-muut")
        }
        guard listed else { xwCloseSettingsFromPushed(shot: "x10-asetukset-lopuksi"); return }
        browser.swipeLeft()
        let one = app.buttons.matching(NSPredicate(format: "label == %@", "Kirjaa ulos")).firstMatch
        let offered = one.waitForExistence(timeout: 5)
        xwShot("x10-laite-pyyhkaisy")
        xwCheck("x10 a device's swipe offers Kirjaa ulos", offered, tree: "x10-laite-pyyhkaisy")
        if offered {
            one.tap(); taps += 1
            xwConfirmCancel("x10 Kirjaa ulos (one device)", titlePrefix: "Kirjataanko laite ulos?", shot: "x10-laite-kirjaa-ulos")
            if browser.exists { browser.swipeRight() }
            // Then for real: the browser session is the CI's own throwaway sign-in.
            if browser.exists {
                browser.swipeLeft()
                if one.waitForExistence(timeout: 5) {
                    one.tap(); taps += 1
                    let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
                    if confirm.waitForExistence(timeout: 8) {
                        usleep(500_000)
                        xwShot("x10-laite-vahvistus")
                        confirm.tap(); taps += 1
                        let fewer = xwUntil(15) { self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Selain")).count < browsers }
                        usleep(500_000)
                        xwShot("x10-laite-kirjattu-ulos")
                        xwCheck("x10 Kirjaa ulos signed one Selain session out (\(browsers) before)", fewer, tree: "x10-laite-kirjattu-ulos")
                    }
                }
            }
        }
        xwCloseSettingsFromPushed(shot: "x10-asetukset-lopuksi")
    }

    // MARK: - Sign out → sign in

    /// Asetukset → Kirjaudu ulos (asked: Peruuta first, then for real) → the sign-in screen → one
    /// wrong password → the demo password → the tabs again.
    func test11_SignOutIn() {
        guard xwOpenSettings(shot: "x11-asetukset") else { return }
        guard xwTapVisible("label == %@", "Kirjaudu ulos") else { xwCheck("x11 Asetukset shows Kirjaudu ulos", false, tree: "x11-asetukset"); return }
        xwConfirmCancel("x11 Kirjaudu ulos", titlePrefix: "Kirjaudutaanko ulos?", shot: "x11-kirjaudu-ulos")
        guard xwTapVisible("label == %@", "Kirjaudu ulos") else { return }
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        guard confirm.waitForExistence(timeout: 8) else { xwCheck("x11 the sign-out question came back", false, tree: "x11-kirjaudu-ulos-2"); return }
        confirm.tap(); taps += 1
        let password = app.secureTextFields.firstMatch
        let signedOut = password.waitForExistence(timeout: 20)
        if signedOut { usleep(700_000) }
        xwShot("x11-kirjautuminen")
        xwCheck("x11 Kirjaudu ulos reached the sign-in screen", signedOut, tree: "x11-kirjautuminen")
        check("x11 sign-in screen says Kirjaudu sisään", app.staticTexts["Kirjaudu sisään"].firstMatch.exists)
        let signIn = app.buttons["Kirjaudu sisään"].firstMatch
        check("x11 sign-in button waits for the password", signIn.exists && !signIn.isEnabled)
        guard signedOut else { return }

        // One wrong password (the account allows five per 15 min), then the right one. The address
        // may be kept from the session: it is typed only when the field holds something else.
        let email = app.textFields.firstMatch
        let kept = email.exists ? (email.value as? String ?? "") : ""
        if email.exists && kept != "demo@lashkirja.fi" {
            type(email, String(repeating: XCUIKeyboardKey.delete.rawValue, count: kept.count) + "demo@lashkirja.fi")
        }
        type(password, "vaara1234")
        app.buttons["Kirjaudu sisään"].firstMatch.tap(); taps += 1
        let refused = xwAny("label CONTAINS %@", "salasana on väärin").waitForExistence(timeout: 20)
        xwShot("x11-vaara-salasana")
        xwCheck("x11 a wrong password says Sähköposti tai salasana on väärin", refused, tree: "x11-vaara-salasana")
        type(password, String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "demo123")
        app.buttons["Kirjaudu sisään"].firstMatch.tap(); taps += 1
        let back = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) }
        dismissSystemPrompts()
        xwShot("x11-kirjautunut-taas")
        xwCheck("x11 signed in again: the tab bar is back", back, tree: "x11-kirjautunut-taas")
    }

    // MARK: - Offline

    /// Offline (scripts/sim/api-proxy.py drops every connection) on Myynti, Kirjanpito → Ostolaskut
    /// (never loaded in this launch) and Asetukset → Laitteet; then online, and each recovers.
    func test12_Offline() {
        let banner = app.descendants(matching: .any)["offline-banner"]
        xwTab("Myynti", ready: app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset")).firstMatch, shot: "x12-myynti-verkossa")
        goOffline()
        note("INFO x12 offline (offline.flag)")
        // Two failed loads raise the banner: a refresh and a tab switch each make one.
        xwPullToRefresh()
        _ = selectTab("Kirjanpito")
        _ = selectTab("Myynti")
        if !banner.waitForExistence(timeout: 15) { xwPullToRefresh() }
        let raised = banner.waitForExistence(timeout: 20)
        let bannerText = raised && banner.exists ? banner.label : ""
        if raised { usleep(600_000) }
        xwShot("x12-myynti-offline")
        xwCheck("x12 Myynti offline: banner \(bannerText.isEmpty ? "missing" : bannerText)", bannerText == "Palvelimeen ei saada yhteyttä", tree: "x12-myynti-offline")

        // A screen this launch never loaded: Kirjanpito → Ostolaskut fails to its panel.
        if selectTab("Kirjanpito"), xwOpen("label BEGINSWITH %@", "Ostolaskut", xwBar("Ostolaskut"), "x12 Ostolaskut opened offline", shot: "x12-ostolaskut-offline-avattu") {
            let panel = app.buttons["Yritä uudelleen"].firstMatch
            let failed = panel.waitForExistence(timeout: 20)
            if failed { usleep(500_000) }
            xwShot("x12-ostolaskut-offline")
            xwCheck("x12 Ostolaskut offline shows a failure with Yritä uudelleen", failed, tree: "x12-ostolaskut-offline")
            check("x12 Ostolaskut offline: banner still up", banner.exists)
        }

        // Asetukset → Laitteet offline: the banner is under the sheet; the screen says it itself.
        if xwOpenSettings(shot: "x12-asetukset-offline"), tap("Laitteet") {
            let failed = app.buttons["Yritä uudelleen"].firstMatch.waitForExistence(timeout: 20)
            if failed { usleep(500_000) }
            xwShot("x12-laitteet-offline")
            xwCheck("x12 Laitteet offline shows a failure with Yritä uudelleen", failed, tree: "x12-laitteet-offline")
            goOnline()
            note("INFO x12 online again")
            // Back online the screen reloads by itself once the probe sees the server.
            let recovered = app.staticTexts["Selain"].firstMatch.waitForExistence(timeout: 30) || xwAny("label CONTAINS %@", "(tämä laite)").waitForExistence(timeout: 5)
            xwShot("x12-laitteet-takaisin-verkossa")
            xwCheck("x12 Laitteet reloaded by itself when back online", recovered, tree: "x12-laitteet-takaisin-verkossa")
            xwCloseSettingsFromPushed(shot: "x12-asetukset-lopuksi")
        } else {
            goOnline()
            note("INFO x12 online again")
        }

        // Ostolaskut (still pushed on Kirjanpito) and the banner recover without a tap.
        _ = selectTab("Kirjanpito")
        let gone = xwGone(banner, timeout: 30)
        let rows = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Ripsitukku")).firstMatch.waitForExistence(timeout: 20)
        xwShot("x12-ostolaskut-takaisin-verkossa")
        xwCheck("x12 back online: banner gone", gone, tree: "x12-banneri-pois")
        xwCheck("x12 back online: Ostolaskut reloaded by itself (Ripsitukku Oy listed)", rows, tree: "x12-ostolaskut-takaisin-verkossa")
        _ = selectTab("Myynti")
        let reloaded = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset")).firstMatch.waitForExistence(timeout: 20)
        xwShot("x12-myynti-takaisin-verkossa")
        xwCheck("x12 back online: Myynti answers again", reloaded, tree: "x12-myynti-takaisin-verkossa")
    }

    // MARK: - Lisää

    /// The + tab's sheet: Uusi myyntilasku (its customer picker, a line's 3-dot menu), Lisää tiedosto
    /// (the capture screen), Yhdistä sähköposti (pushed in the sheet), and Tuo tiliote (the system
    /// file picker, cancelled); the sheet closed by a swipe down.
    func test13_LisaaSheet() {
        let sheet = xwBar("Lisää")
        xwOpenAdd()
        guard xwSheetUp(sheet, "x13 + → Lisää sheet", shot: "x13-lisaa") else { return }

        if xwTapVisible("label == %@", "Uusi myyntilasku") {
            let form = xwBar("Uusi lasku")
            if xwSheetUp(form, "x13 Uusi myyntilasku → Uusi lasku", shot: "x13-uusi-lasku") {
                xwInvoiceFormParts("x13-uusi-lasku")
                xwCloseSheet(form, "Uusi lasku", with: ["Peruuta"], shot: "x13-uusi-lasku")
            }
        } else {
            xwMiss("x13 Lisää sheet row Uusi myyntilasku", tree: "x13-uusi-lasku")
        }
        if !sheet.exists { xwOpenAdd(); _ = sheet.waitForExistence(timeout: 10) }

        if xwTapVisible("label == %@", "Lisää tiedosto") {
            let capture = xwBar("Uusi kuitti")
            if xwSheetUp(capture, "x13 Lisää tiedosto → Uusi kuitti", shot: "x13-lisaa-tiedosto") {
                check("x13 the capture page offers Valitse kuvista", app.buttons["Valitse kuvista"].firstMatch.exists || app.staticTexts["Valitse kuvista"].firstMatch.exists)
                xwCloseSheet(capture, "Uusi kuitti", with: ["Peruuta", "Sulje"], shot: "x13-lisaa-tiedosto")
                note("INFO x13 closing the capture screen closes the Lisää sheet too: \(!sheet.exists)")
            }
        } else {
            xwMiss("x13 Lisää sheet row Lisää tiedosto", tree: "x13-lisaa-tiedosto")
        }
        if !sheet.exists { xwOpenAdd(); _ = sheet.waitForExistence(timeout: 10) }

        let mailbox = app.buttons.matching(NSPredicate(format: "label == %@", "Yhdistä sähköposti")).firstMatch
        if mailbox.waitForExistence(timeout: 10), mailbox.isHittable {
            mailbox.tap(); taps += 1
            if xwAfterPush(xwBar("Sähköpostien tuonti"), "x13 Yhdistä sähköposti → Sähköpostien tuonti (in the sheet)", shot: "x13-yhdista-sahkoposti") {
                xwPop(to: sheet, "x13 back to the Lisää sheet", shot: "x13-lisaa-takaisin")
            }
        } else {
            note("INFO x13 the mailbox row reads \(app.buttons["Hae sähköpostista"].firstMatch.exists ? "Hae sähköpostista" : "neither label")")
        }

        // The system document picker: only its own Cancel can be driven.
        if xwTapVisible("label == %@", "Tuo tiliote") {
            let cancel = app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancel", "Kumoa", "Peruuta"])).firstMatch
            let up = cancel.waitForExistence(timeout: 10)
            if up { usleep(700_000) }
            xwShot("x13-tuo-tiliote")
            xwCheck("x13 Tuo tiliote opened the system file picker", up, tree: "x13-tuo-tiliote")
            if up && cancel.isHittable { cancel.tap() } else { xwSwipeDown(app.navigationBars.firstMatch) }
            taps += 1
            let back = sheet.waitForExistence(timeout: 10)
            xwShot("x13-tuo-tiliote-peruttu")
            xwCheck("x13 the picker's Cancel returned to the Lisää sheet", back, tree: "x13-tuo-tiliote-peruttu")
        } else {
            xwMiss("x13 Lisää sheet row Tuo tiliote", tree: "x13-tuo-tiliote")
        }
        if sheet.exists { xwCloseSheet(sheet, "Lisää", with: [], shot: "x13-lisaa") }
    }

    // MARK: - Asetukset, every row

    /// Every other row of Asetukset opened and left (Laitteet is x10, Kirjaudu ulos x11), with the
    /// two sheets inside them (Uusi malli, Yhdistä sähköpostitili) shot open and closed.
    func test14_AsetuksetRows() {
        guard xwOpenSettings(shot: "x14-asetukset") else { return }
        let root = xwBar("Asetukset")
        let rows: [(row: String, title: String, slug: String)] = [
            ("Liisa Demo", "Profiili", "profiili"),
            ("Yritysmuoto ja ALV", "Yritysmuoto ja ALV", "yritysmuoto"),
            ("Laskuttajan tiedot", "Laskuttajan tiedot", "laskuttaja"),
            ("Sähköpostimallit", "Sähköpostimallit", "sahkopostimallit"),
            ("Maksut", "Maksut", "maksut"),
            ("Sähköpostien tuonti", "Sähköpostien tuonti", "sahkopostien-tuonti"),
            ("Vaihda salasana", "Vaihda salasana", "vaihda-salasana"),
            ("Vaihda sähköposti", "Sähköposti", "vaihda-sahkoposti"),
            ("Pääsyavaimet", "Pääsyavaimet", "paasyavaimet"),
            ("Sovelluslukitus", "Sovelluslukitus", "sovelluslukitus"),
            ("Ilmoitukset", "Ilmoitukset", "ilmoitukset"),
            ("Tietosuoja", "Tietosuoja", "tietosuoja"),
            ("Ohje", "Ohje ja tuki", "ohje"),
            ("Ilmoita ongelmasta", "Ilmoita ongelmasta", "ilmoita-ongelmasta"),
        ]
        for entry in rows {
            let name = "x14-\(entry.slug)"
            guard tap(entry.row) else { xwCheck("x14 Asetukset row \(entry.row)", false, tree: name); continue }
            guard xwAfterPush(xwBar(entry.title), "x14 \(entry.row) → \(entry.title)", shot: name) else {
                if !root.exists { xwBack() }
                continue
            }
            switch entry.slug {
            case "sahkopostimallit":
                if xwTapButton("Uusi malli", timeout: 5) {
                    let editor = xwBar("Uusi malli")
                    if xwSheetUp(editor, "x14 Uusi malli editor", shot: "\(name)-uusi-malli") {
                        xwCloseSheet(editor, "Uusi malli", with: ["Peruuta"], shot: "\(name)-uusi-malli")
                    }
                } else {
                    xwMiss("x14 Sähköpostimallit offers Uusi malli", tree: "\(name)-uusi-malli")
                }
            case "sahkopostien-tuonti":
                if xwTapVisible("label BEGINSWITH %@", "Yhdistä sähköpostitili") {
                    let connect = xwBar("Yhdistä sähköposti")
                    if xwSheetUp(connect, "x14 Yhdistä sähköpostitili sheet", shot: "\(name)-yhdista") {
                        xwCloseSheet(connect, "Yhdistä sähköposti", with: ["Peruuta"], shot: "\(name)-yhdista")
                    }
                } else {
                    xwMiss("x14 Sähköpostien tuonti offers Yhdistä sähköpostitili", tree: "\(name)-yhdista")
                }
            case "laskuttaja", "tietosuoja", "ohje", "ilmoitukset":
                xwScrollShots(name, screens: 2)
            default:
                break
            }
            xwPop(to: root, "x14 back to Asetukset from \(entry.title)")
        }
        let autoLink = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat automaattisesti")).firstMatch
        note("INFO x14 Kohdista varmat automaattisesti: \(autoLink.exists ? String(describing: autoLink.value ?? "?") : "not found") (left as it is)")
        xwScrollShots("x14-asetukset", screens: 3)
        xwCloseSettings(shot: "x14-asetukset")
    }

    // MARK: - Kirjanpito, the other screens

    /// The Kirjanpito hub's other rows: Ostolaskut (+ sheet, Ripsitukku Oy with its 3-dot menu and
    /// sheets), Sähköposti, Kohdista kuitit, Kohdista ostolaskujen maksut, Kuukauden sulku, and
    /// Kirjanpito (each part).
    func test15_KirjanpitoMuut() {
        let hubReady = app.staticTexts["Kohdista kuitit"].firstMatch
        guard xwTab("Kirjanpito", ready: hubReady, shot: "x15-kirjanpito") else { return }

        if xwOpen("label BEGINSWITH %@", "Ostolaskut", xwBar("Ostolaskut"), "x15 Ostolaskut opened", shot: "x15-ostolaskut") {
            if xwTapButton("Uusi ostolasku", timeout: 5) {
                let form = xwBar("Uusi ostolasku")
                if xwSheetUp(form, "x15 + → Uusi ostolasku", shot: "x15-uusi-ostolasku") {
                    xwCloseSheet(form, "Uusi ostolasku", with: ["Peruuta"], shot: "x15-uusi-ostolasku")
                }
            } else {
                xwMiss("x15 Ostolaskut toolbar + (Uusi ostolasku)", tree: "x15-uusi-ostolasku")
            }
            xwGrowAndFold("x15-ostolaskut", expected: false)
            xwToTop(3)
            if xwOpen("label CONTAINS %@", "Ripsitukku Oy", xwBar("Ripsitukku Oy"), "x15 ostolasku Ripsitukku Oy opened", shot: "x15-ostolasku") {
                xwMenu("Toiminnot", item: "Tee toistuvaksi", shot: "x15-ostolasku-3dot-menu")
                for (item, title, slug, close) in [("Kirjaa maksu", "Kirjaa maksu", "kirjaa-maksu", "Peruuta"),
                                                   ("Kohdista pankkitapahtumaan", "Kohdista pankkitapahtumaan", "kohdista", "Sulje"),
                                                   ("Hyvitä", "Hyvitä ostolasku", "hyvita", "Peruuta")] {
                    if xwMenuPick("Toiminnot", item) {
                        let sheet = xwBar(title)
                        if xwSheetUp(sheet, "x15 ostolasku Toiminnot → \(item)", shot: "x15-ostolasku-\(slug)") {
                            xwCloseSheet(sheet, title, with: [close], shot: "x15-ostolasku-\(slug)")
                        }
                    }
                }
                xwPop(to: xwBar("Ostolaskut"), "x15 back to Ostolaskut")
            }
            xwPop(to: hubReady, "x15 back to the hub from Ostolaskut")
        }

        for (row, title, slug) in [("Sähköposti", "Sähköposti", "sahkoposti"),
                                   ("Kohdista kuitit", "Pankkitapahtumat", "kohdista-kuitit"),
                                   ("Kohdista ostolaskujen maksut", "Kohdista ostolaskujen maksut", "kohdista-ostolaskut"),
                                   ("Kuukauden sulku", "Kuukauden sulku", "kuukauden-sulku")] {
            if xwOpen("label BEGINSWITH %@", row, xwBar(title), "x15 \(row) opened", shot: "x15-\(slug)") {
                if slug == "kuukauden-sulku" { xwScrollShots("x15-\(slug)", screens: 2) }
                if slug == "sahkoposti" { xwGrowAndFold("x15-\(slug)", expected: false) }
                xwPop(to: hubReady, "x15 back to the hub from \(row)")
            }
        }

        // The ledger has the hub's own title: a part button tells them apart.
        if xwOpen("label BEGINSWITH %@", "Kirjanpito, Tuloslaskelma", app.buttons["Tase"].firstMatch, "x15 Kirjanpito (ledger) opened", shot: "x15-kirjanpito-tulos") {
            for part in ["Tase", "Saldot", "Päiväkirja", "Tulos"] where xwTapButton(part, timeout: 5) {
                usleep(800_000)
                xwShot("x15-kirjanpito-\(part.lowercased())")
            }
            check("x15 Tase täsmää (no 'Tase ei täsmää' text)", !app.staticTexts["Tase ei täsmää. Ilmoita tästä tukeen."].exists)
            xwPop(to: hubReady, "x15 back to the hub from the ledger", shot: "x15-kirjanpito-lopuksi")
        }
    }

    /// ALV-ilmoitus: shots only. Reading its accessibility tree outlasts XCTest's snapshot timeout
    /// in a Debug build (StabilityTests.test04), so nothing on it is queried and its "Valitse kausi"
    /// menu is left out; three shots in a row stand in for a wait.
    func test16_Alv() {
        guard xwTab("Kirjanpito", ready: app.staticTexts["Kohdista kuitit"].firstMatch, shot: "x16-kirjanpito") else { return }
        guard tap("ALV-ilmoitus") else { dump(app, "x16-alv-tree"); return }
        for i in 1...3 { xwShot("x16-alv-\(i)") }
        check("x16 the app still runs on ALV-ilmoitus", app.state == .runningForeground)
        edgeSwipeBack()
        let hub = app.staticTexts["Pankki"].firstMatch
        var back = hub.waitForExistence(timeout: 10)
        if !back {
            // StabilityTests.test04: the swipe has left ALV up before; its own back button then.
            xwShot("x16-alv-pyyhkaisy-jai")
            probe { if let button = app.navigationBars["ALV-ilmoitus"].buttons.allElementsBoundByIndex.first(where: { $0.isHittable }) { button.tap() } }
            back = hub.waitForExistence(timeout: 10)
        }
        xwShot("x16-alv-takaisin")
        xwCheck("x16 back from ALV-ilmoitus to the Kirjanpito hub", back, tree: "x16-alv-takaisin")
    }

    // MARK: - Walk helpers (prefix xw: nothing here may meet a name in WalkTestCase, Helpers or another class)

    /// Shot names used in this run (all tests of the class share ui-shots): shot() returns at once
    /// for a name whose PNG already exists, so a repeated name would keep an older picture.
    private static var xwNames = Set<String>()

    /// A screenshot kept in the result bundle (exported to ui-attachments/named) and, where the host
    /// watcher runs (CI, scripts/sim/run-ui.sh), as ui-shots/<name>.png.
    private func xwShot(_ name: String) {
        var unique = name
        var n = 2
        while Self.xwNames.contains(unique) { unique = "\(name)-\(n)"; n += 1 }
        Self.xwNames.insert(unique)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = unique
        attachment.lifetime = .keepAlways
        add(attachment)
        shot(unique)
    }

    /// One recorded step: PASS/FAIL in notes.txt; a FAIL also keeps the element tree as <tree>-tree.txt.
    @discardableResult
    private func xwCheck(_ what: String, _ ok: Bool, tree: String) -> Bool {
        check(what, ok)
        if !ok { dump(app, tree + "-tree") }
        return ok
    }

    private var xwWindow: XCUIElement { app.windows.firstMatch }

    private func xwAny(_ format: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: format, arg)).firstMatch
    }

    private func xwBar(_ title: String) -> XCUIElement { app.navigationBars[title].firstMatch }

    private func xwBarPrefix(_ prefix: String) -> XCUIElement {
        app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    /// The on-screen one of same-labelled buttons (every tab's toolbar is in the tree), or nil.
    private func xwHittable(_ label: String, timeout: TimeInterval = 10) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label == %@ OR identifier == %@", label, label))
        _ = query.firstMatch.waitForExistence(timeout: timeout)
        return query.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
    }

    @discardableResult
    private func xwTapButton(_ label: String, timeout: TimeInterval = 10) -> Bool {
        guard let button = xwHittable(label, timeout: timeout) else { return false }
        button.tap(); taps += 1
        return true
    }

    /// Polls `condition`, asking `exists` directly (OwnerScreensTests.waitGone says why).
    private func xwUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(300_000)
        }
        return condition()
    }

    private func xwGone(_ element: XCUIElement, timeout: TimeInterval = 8) -> Bool { xwUntil(timeout) { !element.exists } }

    /// Taps the first element matching `format`/`arg` once it sits clear of the bars, scrolling down
    /// for it; no MISS note (the caller records the step).
    private func xwTapVisible(_ format: String, _ arg: String, wait: TimeInterval = 10, maxSwipes: Int = 5) -> Bool {
        let element = xwAny(format, arg)
        guard xwReveal(element, wait: wait, maxSwipes: maxSwipes) else { return false }
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); taps += 1
        return true
    }

    /// Scrolls down (and opens "Näytä enemmän" once the row is not among those shown) until
    /// `element` sits clear of the navigation and tab bars.
    @discardableResult
    private func xwReveal(_ element: XCUIElement, wait: TimeInterval = 8, maxSwipes: Int = 8) -> Bool {
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Näytä enemmän")).firstMatch
        _ = element.waitForExistence(timeout: wait)
        for attempt in 0...maxSwipes {
            let bottom = xwWindow.frame.maxY - 100
            if element.exists && element.frame.minY > 130 && element.frame.maxY < bottom { return true }
            if attempt == maxSwipes { break }
            if !element.exists && more.exists && more.isHittable && more.frame.maxY < bottom {
                more.tap(); taps += 1
                continue
            }
            xwWindow.swipeUp(velocity: .slow); scrolls += 1
        }
        return element.exists && element.isHittable
    }

    private func xwToTop(_ swipes: Int = 4) {
        for _ in 0..<swipes { xwWindow.swipeDown(velocity: .fast) }
    }

    /// A long screen shot a screenful at a time below its first shot.
    private func xwScrollShots(_ name: String, screens: Int) {
        for i in 1...max(1, screens) {
            xwWindow.swipeUp(velocity: .slow); scrolls += 1
            xwShot("\(name)-vieritys\(i)")
        }
    }

    private func xwPullToRefresh() {
        xwWindow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            .press(forDuration: 0.05, thenDragTo: xwWindow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
    }

    private func xwSwipeDown(_ bar: XCUIElement) {
        let start = bar.exists ? bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                               : xwWindow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        start.press(forDuration: 0.1, thenDragTo: xwWindow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
    }

    /// The pushed screen's back button (PerfWalkTests.back), else an edge swipe.
    private func xwBack() {
        let buttons = app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex
        if let button = buttons.first(where: { $0.exists && $0.isHittable }) { button.tap() } else { edgeSwipeBack() }
        taps += 1
    }

    @discardableResult
    private func xwTab(_ name: String, ready: XCUIElement, shot shotName: String) -> Bool {
        let selected = selectTab(name)
        let painted = selected && ready.waitForExistence(timeout: 20)
        if painted { usleep(700_000) }
        xwShot(shotName)
        return xwCheck("\(shotName): tab \(name) selected and its root painted", painted, tree: shotName)
    }

    /// After a tap that pushes a screen: waits for `marker`, shoots, records.
    @discardableResult
    private func xwAfterPush(_ marker: XCUIElement, _ what: String, shot name: String) -> Bool {
        let shown = marker.waitForExistence(timeout: 15)
        if shown { usleep(700_000) }
        xwShot(name)
        return xwCheck(what, shown, tree: name)
    }

    /// As xwAfterPush for a screen whose title varies: a back button shows it was pushed.
    @discardableResult
    private func xwAfterPushAny(_ what: String, shot name: String) -> Bool {
        let shown = xwUntil(15) {
            self.app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex.contains { $0.exists && $0.isHittable }
        }
        if shown { usleep(700_000) }
        xwShot(name)
        return xwCheck(what, shown, tree: name)
    }

    @discardableResult
    private func xwPop(to marker: XCUIElement, _ what: String, shot name: String? = nil) -> Bool {
        xwBack()
        let back = marker.waitForExistence(timeout: 10)
        if let name {
            if back { usleep(500_000) }
            xwShot(name)
        }
        return xwCheck(what, back, tree: name ?? "x-takaisin")
    }

    @discardableResult
    private func xwSheetUp(_ bar: XCUIElement, _ what: String, shot name: String, timeout: TimeInterval = 15) -> Bool {
        let up = bar.waitForExistence(timeout: timeout)
        if up { usleep(700_000) }
        xwShot(name)
        return xwCheck(what, up, tree: name)
    }

    /// Closes the sheet whose bar is `bar` with the first of `buttons` it shows (else a swipe down by
    /// its bar), answers "Hylkää muutokset" if a form asks, and shoots what is left behind.
    @discardableResult
    private func xwCloseSheet(_ bar: XCUIElement, _ what: String, with buttons: [String], shot name: String) -> Bool {
        var used = "a swipe down"
        var closer: XCUIElement?
        if bar.exists {
            for label in buttons {
                let button = bar.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
                if button.exists && button.isHittable { closer = button; used = label; break }
            }
        }
        if let closer { closer.tap() } else { xwSwipeDown(bar) }
        taps += 1
        let discard = app.buttons["Hylkää muutokset"].firstMatch
        var asked = false
        let closed = xwUntil(10) {
            if !asked && discard.exists && discard.isHittable { discard.tap(); asked = true }
            return !bar.exists
        }
        if asked { note("INFO \(name): \(what) asked Hylätäänkö muutokset? and was discarded") }
        if closed { usleep(600_000) }
        xwShot(name + "-suljettu")
        return xwCheck("\(name): \(what) closed with \(used)", closed, tree: name + "-suljettu")
    }

    /// The app's bottom confirm sheet (ConfirmSheet): shot, its title recorded, answered Peruuta, shot.
    @discardableResult
    private func xwConfirmCancel(_ what: String, titlePrefix: String, shot name: String) -> Bool {
        let sheet = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        let up = sheet.waitForExistence(timeout: 8)
        if up { usleep(700_000) }
        xwShot(name)
        let title = app.staticTexts["confirm-sheet-title"].firstMatch
        let text = up && title.exists ? title.label : ""
        xwCheck("\(what) asks first (\(text.isEmpty ? "no confirm sheet" : text))", up && text.hasPrefix(titlePrefix), tree: name)
        guard up else { return false }
        let cancel = app.buttons["confirm-sheet-cancel"].firstMatch
        if cancel.exists { cancel.tap(); taps += 1 }
        let gone = xwGone(sheet)
        if gone { usleep(500_000) }
        xwShot(name + "-peruttu")
        return xwCheck("\(what): Peruuta closed the question", gone, tree: name + "-peruttu")
    }

    /// A 3-dot (or other) menu: opened and shot, closed by a tap beside it, shot again so a menu
    /// left over shows. `item` is one entry the menu should list.
    @discardableResult
    private func xwMenu(_ label: String, item: String, shot name: String) -> Bool {
        guard xwHittable(label) != nil else {
            xwShot(name + "-ei-painiketta")
            return xwCheck("\(name): menu button \(label) on screen", false, tree: name)
        }
        let entry = xwOpenMenu(label, item: item)
        // The menu grows out of its button: shot once it stands.
        if entry != nil { usleep(600_000) }
        xwShot(name + "-auki")
        xwCheck("\(name): \(label) opened and lists \(item)", entry != nil, tree: name + "-auki")
        // Closed even when the entry was not seen: a menu without it would cover the next steps.
        xwCloseMenu()
        guard let entry else { return false }
        let closed = xwGone(entry, timeout: 6)
        if closed { usleep(400_000) }
        xwShot(name + "-suljettu")
        xwCheck("\(name): \(label) closed by a tap beside it", closed, tree: name + "-suljettu")
        return true
    }

    /// Taps a menu button and returns the entry `item` its menu added. Not the first button of that
    /// name: a screen can hold one too (Kuitti's "Muokkaa" row), so the entry is the match the tap added.
    private func xwOpenMenu(_ label: String, item: String) -> XCUIElement? {
        guard let button = xwHittable(label, timeout: 5) else { return nil }
        let entries = app.buttons.matching(NSPredicate(format: "label == %@", item))
        let before = entries.count
        button.tap(); taps += 1
        guard xwUntil(6, { entries.count > before }) else { return nil }
        let now = entries.count
        return now > before ? entries.element(boundBy: now - 1) : nil
    }

    /// A tap beside an open menu: the middle of the navigation bar, under the status bar, where no
    /// menu reaches (they open below their toolbar button or above the composer).
    private func xwCloseMenu() {
        xwWindow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.07)).tap()
    }

    /// Opens `menu` and taps its entry `item` (the way to what only the menu offers).
    private func xwMenuPick(_ menu: String, _ item: String) -> Bool {
        let tree = "x-menu-" + (menu + "-" + item).lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        guard xwHittable(menu, timeout: 5) != nil else {
            note("MISS menu \(menu) (for \(item))")
            dump(app, tree + "-tree")
            return false
        }
        guard let entry = xwOpenMenu(menu, item: item) else {
            note("MISS \(menu) has no \(item)")
            dump(app, tree + "-tree")
            xwCloseMenu()
            return false
        }
        entry.tap(); taps += 1
        return true
    }

    /// The list's "Näytä enemmän (N)" / "Näytä vähemmän" row, scrolled into view (StabilityTests.toggleRow).
    /// In a sheet it only scrolls down: a downward swipe at the top of a sheet's list closes the sheet.
    private func xwToggleRow(up: Bool = false, inSheet: Bool = false, maxSwipes: Int = 8) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label == %@", "Näytä enemmän", "Näytä vähemmän"))
        _ = query.firstMatch.waitForExistence(timeout: 3)
        for down in inSheet ? [true] : [!up, up] {
            for _ in 0...maxSwipes {
                let row = query.firstMatch
                if row.exists && row.frame.minY > 30 && row.frame.maxY < xwWindow.frame.maxY - 60 { return row }
                if down { xwWindow.swipeUp(velocity: .slow) } else { xwWindow.swipeDown(velocity: .slow) }
                scrolls += 1
            }
        }
        return nil
    }

    /// "Näytä enemmän" until the list is fully open, then "Näytä vähemmän"; shot at the start, open
    /// and folded. `expected`: the seed makes this list longer than one step (absence is a FAIL).
    private func xwGrowAndFold(_ name: String, expected: Bool, inSheet: Bool = false, maxTaps: Int = 8) {
        guard let first = xwToggleRow(inSheet: inSheet), first.exists, first.label.hasPrefix("Näytä enemmän") else {
            if expected {
                xwShot(name + "-ei-naytaenemman")
                xwCheck("\(name): Näytä enemmän on a list the seed makes long", false, tree: name + "-ei-naytaenemman")
            } else {
                note("INFO \(name): no Näytä enemmän (the demo data fits on one step)")
            }
            return
        }
        let hiddenAtStart = Int(first.label.filter(\.isNumber)) ?? 0
        xwShot(name + "-naytaenemman")
        var row: XCUIElement? = first
        var opened = 0
        while let current = row, current.exists, current.label.hasPrefix("Näytä enemmän"), opened < maxTaps {
            current.tap(); taps += 1
            opened += 1
            row = xwToggleRow(inSheet: inSheet)
        }
        let open = row?.exists == true && row?.label == "Näytä vähemmän"
        if open { usleep(400_000) }
        xwShot(name + "-auki")
        xwCheck("\(name): Näytä enemmän opened the list in \(opened) taps (\(hiddenAtStart) hidden at first)", open, tree: name + "-auki")
        guard open, let fold = row else { return }
        fold.tap(); taps += 1
        let again = xwToggleRow(up: true, inSheet: inSheet)
        let folded = again?.exists == true && again?.label.hasPrefix("Näytä enemmän") == true
        if folded { usleep(400_000) }
        xwShot(name + "-taitettu")
        xwCheck("\(name): Näytä vähemmän folded it back to the first rows", folded, tree: name + "-taitettu")
    }

    /// Kirjanpito → Kuitit on the given chip (Kuitit remembers its chip between launches, so every
    /// visit sets it).
    private func xwOpenKuitit(tab chip: String) -> Bool {
        let bar = xwBar("Kuitit")
        if selectTab("Kirjanpito") {
            for _ in 0..<2 where !bar.exists {
                tapLabel("label BEGINSWITH %@", "Kuitit")
                _ = bar.waitForExistence(timeout: 10)
            }
        }
        guard xwCheck("Kirjanpito → Kuitit opened (for chip \(chip))", bar.exists, tree: "x-kuitit-\(chip)") else { return false }
        _ = xwChip(chip)
        return true
    }

    /// Taps a Kuitit chip by its id; the chip row scrolls sideways.
    private func xwChip(_ id: String) -> Bool {
        let chip = app.buttons["receipt-tab-\(id)"].firstMatch
        guard chip.waitForExistence(timeout: 15) else { return false }
        if !chip.isHittable {
            let anchor = app.buttons[["linked", "unlinked", "laskut"].contains(id) ? "receipt-tab-all" : "receipt-tab-laskut"].firstMatch
            if anchor.exists {
                if ["linked", "unlinked", "laskut"].contains(id) { anchor.swipeLeft() } else { anchor.swipeRight() }
            }
        }
        guard chip.isHittable else { return false }
        chip.tap(); taps += 1
        return true
    }

    @discardableResult
    private func xwOpenSettings(shot name: String) -> Bool {
        if !xwTapButton("Asetukset") { note("MISS Asetukset button") }
        let opened = app.staticTexts["Sähköpostimallit"].firstMatch.waitForExistence(timeout: 15)
        if opened { usleep(700_000) }
        xwShot(name)
        return xwCheck("\(name): Asetukset sheet opened (rows loaded)", opened, tree: name)
    }

    private func xwCloseSettings(shot name: String) {
        let bar = xwBar("Asetukset")
        xwCloseSheet(bar, "Asetukset", with: ["Valmis"], shot: name)
    }

    /// From a screen pushed inside Asetukset: back to its root, then Valmis.
    private func xwCloseSettingsFromPushed(shot name: String) {
        let root = xwBar("Asetukset")
        for _ in 0..<2 where !root.exists {
            xwBack()
            _ = root.waitForExistence(timeout: 5)
        }
        xwCloseSettings(shot: name)
    }

    /// A step whose button or row was not there: FAIL line plus the element tree, and the walk goes on.
    private func xwMiss(_ what: String, tree name: String) {
        xwCheck(what, false, tree: name)
    }

    /// Taps the row found by `format`/`arg` and waits for the screen it pushes (`marker`); a row
    /// that is not there is recorded like a screen that did not come.
    @discardableResult
    private func xwOpen(_ format: String, _ arg: String, _ marker: XCUIElement, _ what: String, shot name: String) -> Bool {
        guard xwTapVisible(format, arg) else {
            xwShot(name + "-ei-rivia")
            xwMiss("\(what) (no \(arg) on screen)", tree: name)
            return false
        }
        return xwAfterPush(marker, what, shot: name)
    }

    private func xwOpenAdd() {
        app.tabBars.buttons["Lisää"].firstMatch.tap(); taps += 1
    }

    /// The invoice form's sub-sheets: Valitse asiakas (Sulje) and the first line's 3-dot menu.
    private func xwInvoiceFormParts(_ name: String) {
        if xwTapVisible("label == %@", "Valitse asiakas", wait: 5) {
            let picker = xwBar("Valitse asiakas")
            if xwSheetUp(picker, "\(name): Valitse asiakas", shot: "\(name)-valitse-asiakas") {
                xwCloseSheet(picker, "Valitse asiakas", with: ["Sulje"], shot: "\(name)-valitse-asiakas")
            }
        }
        let lineMenu = app.buttons["Rivin 1 toiminnot"].firstMatch
        if xwReveal(lineMenu, wait: 5, maxSwipes: 3) {
            xwMenu("Rivin 1 toiminnot", item: "Kopioi rivi", shot: "\(name)-rivi-3dot-menu")
        } else {
            xwCheck("\(name): the first line's 3-dot menu (Rivin 1 toiminnot) on screen", false, tree: "\(name)-rivi")
        }
    }

    /// The count at the end of a label ("Kohdista varmat (2)"); -1 when there is none.
    private func xwLastNumber(_ label: String) -> Int {
        guard let digits = label.split(whereSeparator: { !$0.isNumber }).last else { return -1 }
        return Int(digits) ?? -1
    }

    private func xwField(_ name: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", name, name)).firstMatch
    }

    private func xwBlank(_ field: XCUIElement, _ placeholder: String) -> Bool {
        let value = (field.value as? String) ?? ""
        return value.isEmpty || value == placeholder
    }

    /// LashKirjaCore SureMatchText.linked / .restored, for the toasts.
    private func xwLinkedText(_ count: Int) -> String { count == 1 ? "1 kuitti kohdistettu." : "\(count) kuittia kohdistettu." }

    private func xwRestoredText(_ count: Int) -> String {
        switch count {
        case 0: return "Kohdistukset oli jo muutettu, mitään ei kumottu."
        case 1: return "1 kohdistus kumottu."
        default: return "\(count) kohdistusta kumottu."
        }
    }

    /// The demo API's own answer, straight to :3999 past the walk's proxy (MotionAuditTests.demoInvoiceId),
    /// with the demo-seed login. Test values only, against the throwaway demo API.
    private func xwDemoAPI(_ path: String) -> [String: Any]? {
        func call(_ path: String, _ body: [String: String]?, _ token: String?) -> [String: Any]? {
            guard let url = URL(string: "http://127.0.0.1:3999\(path)") else { return nil }
            var request = URLRequest(url: url)
            request.timeoutInterval = 20
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
            _ = done.wait(timeout: .now() + 25)
            return result
        }
        guard let token = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String else {
            note("MISS x demo API token (127.0.0.1:3999)")
            return nil
        }
        return call(path, nil, token)
    }
}
