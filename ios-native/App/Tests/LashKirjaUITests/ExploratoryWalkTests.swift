import XCTest

/// Phase 2 exploratory walk (the owner's checklist; branch audit/phase2-walk, never merged): every
/// tab, every sheet and every 3-dot menu is opened, shot, closed the way an owner closes it and shot
/// again so a leftover shows; every list's "Näytä enemmän"; upload → review → link; "Kohdista
/// varmat" → "Kumoa"; a credit note; Asetukset → Laitteet; sign out → sign in; offline and back.
///
/// It RECORDS, it does not judge. Each step writes a PASS/FAIL line to notes.txt (check/note), a
/// miss also keeps the element tree as <shot>-tree.txt beside the shots, and the walk goes on; the
/// only hard failure is not being signed in at all (setUp). A check reads what is drawn and settled:
/// a sheet's bar its title, whole; a chip its selection and the count of the list under it; a file
/// sheet its file, not its spinner (H8). Screenshots are XCTAttachments named x<NN>-… (exported to
/// ui-attachments/named) and the same names as host PNGs in ui-shots. AUDIT-WALK.md maps the
/// checklist to the methods and shot names.
///
/// Launched with `-LKUITest` (capture fixture, thumbnails) as OwnerScreensTests is, and run in CI with
/// its reader stub. Data: `demo-seed.ts --ci` plus `app/scripts/audit-seed.ts` (two sure pairs with a
/// rival each, an approved and a pending credit note, three free bank rows "Audit Täyte 1–3").
/// The methods share one demo DB and run in name order: x04 links a receipt, x05 links and takes
/// back the sure pairs, x10 signs the CI browser session out, x11 signs this app out (with a photo
/// waiting, which goes with the session) and in again. It builds over native's WalkTestCase
/// (queuePhotoOffline, waitStill): the round's end is merged in before the confirming run.
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
            let bar = xwBar("Maksumuistutus")
            if xwSheetUp(bar, "x01 Muistuta → Maksumuistutus sheet", shot: "x01-koti-muistuta") {
                xwCloseSheet(bar, "Maksumuistutus", with: ["Peruuta"], shot: "x01-koti-muistuta")
            }
        } else {
            note("INFO x01 no Muistuta pill on Koti (the pill reads Avaa while a reminder term runs)")
        }
        xwToTop()

        // A missing-receipt task's pill: the capture screen (Peruuta). Only its title is read: the
        // simulator's picker page looks the same for a bank row and for a new receipt (X012).
        if xwTapVisible("label BEGINSWITH %@", "Kuvaa kuitti") {
            let bar = xwBar("Uusi kuitti")
            if xwSheetUp(bar, "x01 Kuvaa kuitti pill opened Uusi kuitti", shot: "x01-koti-kuvaa-kuitti") {
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

    /// Myynti: root and its 3-dot menu, chips, Erittely, the list's Näytä enemmän, an overdue and a
    /// draft invoice with their 3-dot menus and sheets, Uusi lasku, Asiakkaat, Toistuvat laskut,
    /// Maksut pankista (Toiminnot).
    func test02_Myynti() {
        guard xwTab("Myynti", ready: app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset")).firstMatch, shot: "x02-myynti") else { return }
        xwScrollShots("x02-myynti", screens: 2)
        xwToTop()
        xwMenu("Toiminnot", item: "Hae asiakkaiden maksut pankista", shot: "x02-myynti-3dot-menu")

        // A chip is read as drawn: selected, and the list under it as long as the chip says.
        let drafts = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset"))
        if xwTapVisible("label BEGINSWITH %@", "Luonnokset", wait: 5) {
            let shown = xwChipShows(drafts, header: "[0-9]+ laskua")
            xwShot("x02-myynti-luonnokset")
            xwCheck("x02 chip Luonnokset selected, its list as long as its count (\(shown.said))", shown.ok, tree: "x02-myynti-luonnokset")
            let all = app.buttons.matching(NSPredicate(format: "label MATCHES %@", "Kaikki(,? [0-9]+)?"))
            if xwTapVisible("label MATCHES %@", "Kaikki(,? [0-9]+)?", wait: 5) {
                let back = xwChipShows(all, header: "[0-9]+ laskua")
                xwShot("x02-myynti-kaikki")
                xwCheck("x02 chip Kaikki selected again, its list as long as its count (\(back.said))", back.ok, tree: "x02-myynti-kaikki")
            } else {
                xwMiss("x02 chip Kaikki after Luonnokset", tree: "x02-myynti-kaikki")
            }
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

        // The overdue invoice: tabs, the 3-dot menu and every sheet it opens. Its row says late once,
        // in the badge, and its line names the due date (N6: no "myöhässä, " beside the badge).
        if xwTapVisible("label CONTAINS 'Myöhässä' AND label CONTAINS %@", "· eräpäivä") {
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
                // The PDF, the payment and the e-mail were tiles under the primary; they are in
                // Toiminnot only (N6). The PDF's bar has its name before the file comes (X030).
                if xwMenuPick("Toiminnot", "Avaa PDF") {
                    let pdf = xwBarPrefix("Lasku-")
                    if xwSheetUp(pdf, "x02 Toiminnot → Avaa PDF → invoice PDF", shot: "x02-lasku-pdf") {
                        xwFileShown(pdf, "x02 the invoice PDF", shot: "x02-lasku-pdf")
                        xwCloseSheet(pdf, "the invoice PDF", with: [], shot: "x02-lasku-pdf")
                    }
                }
                for (item, title, slug) in [("Kirjaa maksu", "Kirjaa maksu", "kirjaa-maksu"), ("Lähetä sähköpostilla", "Lähetä lasku", "laheta"),
                                            ("Hyvitä", "Hyvitä laskua", "hyvita"), ("Sulje perustelulla", "Sulje perustelulla", "sulje-perustelulla")] {
                    // Kirjaa maksu is the screen's primary instead while no reminder can go yet.
                    if (item == "Kirjaa maksu" && xwTapButton(item, timeout: 1)) || xwMenuPick("Toiminnot", item) {
                        let sheet = xwBar(title)
                        if xwSheetUp(sheet, "x02 Toiminnot → \(item) → \(title)", shot: "x02-lasku-\(slug)") {
                            xwCloseSheet(sheet, title, with: ["Peruuta"], shot: "x02-lasku-\(slug)")
                        }
                    }
                }
                xwPop(to: xwBar("Myynti"), "x02 back to Myynti from the invoice")
            }
        } else {
            xwCheck("x02 Myynti lists the overdue invoice (Myöhässä · eräpäivä)", false, tree: "x02-myynti-rivit")
        }
        xwToTop()

        // The draft: its own menu items and the edit form (Toiminnot; its primary is Lähetä lasku).
        if xwTapVisible("label BEGINSWITH %@", "Luonnokset", wait: 5) {
            _ = xwChipShows(drafts, header: "[0-9]+ laskua")
            if xwOpen("label CONTAINS %@", "Lasku ", xwBarPrefix("Lasku "), "x02 draft invoice opened", shot: "x02-lasku-luonnos") {
                xwMenu("Toiminnot", item: "Poista luonnos", shot: "x02-luonnos-3dot-menu")
                if xwMenuPick("Toiminnot", "Muokkaa") {
                    let edit = xwBar("Muokkaa laskua")
                    if xwSheetUp(edit, "x02 Toiminnot → Muokkaa → Muokkaa laskua", shot: "x02-luonnos-muokkaa") {
                        xwCloseSheet(edit, "Muokkaa laskua", with: ["Peruuta"], shot: "x02-luonnos-muokkaa")
                    }
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

        // Asiakkaat: its + (Uusi asiakas, one tap) and its 3-dot menu (Tuo CSV), Kauneus Oy and its
        // 3-dot menu and sheets.
        xwToTop()
        if xwOpen("label == %@", "Asiakkaat", xwBar("Asiakkaat"), "x02 Asiakkaat opened", shot: "x02-asiakkaat") {
            xwMenu("Toiminnot", item: "Tuo CSV", shot: "x02-asiakkaat-3dot-menu")
            if xwTapButton("Uusi asiakas", timeout: 5) {
                let sheet = xwBar("Uusi asiakas")
                if xwSheetUp(sheet, "x02 Asiakkaat + → Uusi asiakas", shot: "x02-asiakkaat-uusi-asiakas") {
                    xwCloseSheet(sheet, "Uusi asiakas", with: ["Peruuta"], shot: "x02-asiakkaat-uusi-asiakas")
                }
            } else {
                xwMiss("x02 Asiakkaat toolbar + (Uusi asiakas)", tree: "x02-asiakkaat-uusi-asiakas")
            }
            if xwMenuPick("Toiminnot", "Tuo CSV") {
                let sheet = xwBar("Tuo asiakkaita")
                if xwSheetUp(sheet, "x02 Asiakkaat Toiminnot → Tuo CSV", shot: "x02-asiakkaat-tuo-csv") {
                    xwCloseSheet(sheet, "Tuo asiakkaita", with: ["Peruuta"], shot: "x02-asiakkaat-tuo-csv")
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

        // Maksut pankista, from Toiminnot (a dry run; "Kirjaa maksut" would book them).
        if xwMenuPick("Toiminnot", "Hae asiakkaiden maksut pankista") {
            let sheet = xwBar("Maksut pankista")
            if xwSheetUp(sheet, "x02 Toiminnot → Hae asiakkaiden maksut pankista → Maksut pankista", shot: "x02-maksut-pankista") {
                xwCloseSheet(sheet, "Maksut pankista", with: ["Sulje", "Peruuta"], shot: "x02-maksut-pankista")
            }
        } else {
            xwCheck("x02 Myynti offers Hae asiakkaiden maksut pankista", false, tree: "x02-myynti-muut")
        }
    }

    // MARK: - Kuitit

    /// Kuitit: every chip, the 3-dot menu with its Suodata submenu and Summarajaus, select mode and its
    /// bar, Näytä enemmän, a row's swipe, a receipt's 3-dot menu, delete question, Muokkaa, Näytä kuitti
    /// and the bank picker.
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
            let tapped = xwChip(id)
            // Drawn as chosen, and the list under it as long as the chip's count says.
            let shown = tapped ? xwChipShows(app.buttons.matching(identifier: "receipt-tab-\(id)"), header: "[0-9]+ (kuittia|laskua|lasku)")
                               : (ok: false, said: "not tapped")
            xwShot("x03-kuitit-chip-\(id)")
            xwCheck("x03 chip \(title) selected, its list as long as its count (\(shown.said))", shown.ok, tree: "x03-kuitit-chip-\(id)")
            if id == "unlinked" {
                let sure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat (")).firstMatch
                note("INFO x03 Ei kohdistettu bar: \(sure.waitForExistence(timeout: 15) ? sure.label : "none")")
            }
        }
        _ = xwChip("all")

        // Toiminnot: Suodata (a submenu) and Valitse kuitteja, beside the camera (N3); the amount
        // alert Suodata › Summa… opens.
        xwMenu("Toiminnot", item: "Valitse kuitteja", shot: "x03-kuitit-3dot-menu")
        xwMenu("Toiminnot", via: "Suodata", item: "Summa…", shot: "x03-kuitit-suodatin-menu")
        if xwMenuPick("Toiminnot", "Summa…", via: "Suodata") {
            let alert = app.alerts["Summarajaus"].firstMatch
            let up = alert.waitForExistence(timeout: 8)
            if up { usleep(600_000) }
            xwShot("x03-kuitit-summarajaus")
            xwCheck("x03 Summa… opened the Summarajaus alert", up, tree: "x03-kuitit-summarajaus")
            let cancel = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Peruuta", "Peru"])).firstMatch
            if up && cancel.exists { cancel.tap(); taps += 1 }
            let gone = xwGone(alert)
            xwShot("x03-kuitit-summarajaus-peruttu")
            xwCheck("x03 Peruuta closed the Summarajaus alert", gone, tree: "x03-kuitit-summarajaus-peruttu")
        }

        // Select mode (Toiminnot): one row picked, the bar, Valmis.
        if xwMenuPick("Toiminnot", "Valitse kuitteja") {
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
            xwMiss("x03 Kuitit Toiminnot → Valitse kuitteja", tree: "x03-kuitit-valinta")
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
        // The file, from Toiminnot (N3: it was a row of the body).
        if xwMenuPick("Toiminnot", "Näytä kuitti") {
            let file = xwBar("abc.pdf")
            if xwSheetUp(file, "x03 Toiminnot → Näytä kuitti → the receipt's file", shot: "x03-kuitti-nayta") {
                xwFileShown(file, "x03 the receipt's file", shot: "x03-kuitti-nayta")
                xwCloseSheet(file, "the receipt's file", with: [], shot: "x03-kuitti-nayta")
            }
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
    /// 3-dot menu (Siirry kuitteihin, and adding files: Valitse tiedosto); the saved receipt in Kuitit
    /// (reviewed: Hyväksy if it waits); linked by hand to the free bank row "Audit Täyte 2" through
    /// the bank picker.
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
        // Pinned under the form (N4): it gives way to the keyboard while a field is typed into, and
        // the rows below the form's first screen sit under it, still hittable.
        let save = app.buttons["Tallenna kuitti"].firstMatch
        if xwBlank(vendor, "Myyjä") { type(vendor, "Testikauppa Oy") }
        // "Summa" beside the field, "0,00" in it while empty; the field is named "Summa euroina" (N4).
        let total = app.textFields.matching(NSPredicate(format: "label BEGINSWITH %@ OR placeholderValue == %@", "Summa", "0,00")).firstMatch
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && xwBlank(total, "0,00") {
            xwCheck("x04 the amount can be brought above Tallenna kuitti", xwClearOfSave(total, save), tree: "x04-lomake-summa")
            type(total, "12")
        }
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        // Read before the bar is back and in place, a row would seem clear of it.
        guard save.waitForExistence(timeout: 5) else { xwCheck("x04 Tallenna kuitti on the form", false, tree: "x04-lomake-taytetty"); return }
        waitStill(save)
        let category = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if category.waitForExistence(timeout: 5), category.label.hasSuffix("Valitse") {
            // A tap on Kategoria where the bar stands saved the form without one (F010: "Valitse
            // kategoria.", the screen still up, and the queue's steps after it walked the form).
            xwCheck("x04 Kategoria can be brought above Tallenna kuitti", xwClearOfSave(category, save), tree: "x04-lomake-kategoria")
            category.tap()
            let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
            if choice.waitForExistence(timeout: 5) { choice.tap() }
        }
        xwShot("x04-lomake-taytetty")
        // Tapped where it is, as `tap` scrolls for anything near the bottom edge.
        save.tap(); taps += 1

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
            // The queue after the save: one primary under the rows; adding files ("Lisää tiedostoja",
            // a second foreground action before N4) is in its 3-dot menu with the rest.
            xwMenu("Toiminnot", item: "Siirry kuitteihin", shot: "x04-jono-3dot-menu")
            xwMenu("Toiminnot", item: "Valitse tiedosto", shot: "x04-jono-lisaa-tiedostoja")
            let primary = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Valmis", "Näytä tarkistettavat")).firstMatch
            if xwReveal(primary) { primary.tap(); taps += 1 }
            let closed = xwGone(screen, timeout: 10)
            xwShot("x04-jono-suljettu")
            xwCheck("x04 the queue's primary button closed Uusi kuitti", closed, tree: "x04-jono-suljettu")
        }

        // Review: the saved receipt (a bill the stub reads is filed under Laskut). After Kaikki's
        // swipes the chip row had left the tree, so Laskut was never tapped (X050): xwChip goes back up.
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
        // A waiting receipt's one primary, in the bottom bar (N3).
        if let approve = xwHittable("Hyväksy", timeout: 3) {
            approve.tap(); taps += 1
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
    /// the chips change and the linked screen is shot → the toast's "Kumoa" inside its 5 s →
    /// "N kohdistusta kumottu." → the bar and the chips as before. A second round shoots the
    /// "N kuittia kohdistettu." toast itself before taking it back.
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

        // Round 1: link; inside the toast's 5 s the chips' counts change (the pairs leave Ei
        // kohdistettu), and that screen is shot in-process, without waiting for the host, before
        // Kumoa takes it back. The toast's word and the bar alone passed on a list that never
        // changed (X066).
        let chips = xwSureChips()
        bar.tap(); taps += 1
        let undo = app.buttons["Kumoa"].firstMatch
        let offered = undo.waitForExistence(timeout: 20)
        // The picture and the tap need about a second of the toast's five.
        let changed = offered && xwUntil(3.5) { self.xwSureChips() != chips }
        let linkedChips = xwSureChips()
        xwShotNow("x05-kohdistettu")
        if offered && undo.exists && undo.isHittable { undo.tap(); taps += 1 }
        xwCheck("x05 Kohdista varmat linked and the toast offered Kumoa", offered, tree: "x05-ei-kumoa")
        xwCheck("x05 while linked the chips changed (\(chips) → \(linkedChips))", changed, tree: "x05-kohdistettu")
        let restored = app.staticTexts[xwRestoredText(count)].firstMatch
        let undone = offered && restored.waitForExistence(timeout: 15)
        xwShot("x05-kumottu")
        xwCheck("x05 Kumoa answered \"\(xwRestoredText(count))\"", undone, tree: "x05-kumottu")
        let back = bar.waitForExistence(timeout: 25)
        let chipsBack = back && xwUntil(15) { self.xwSureChips() == chips }
        if back { usleep(700_000) }
        let again = back ? bar.label : ""
        xwShot("x05-kohdista-varmat-taas")
        xwCheck("x05 after Kumoa the bar is back as before (\(again.isEmpty ? "no bar" : again))", again == label, tree: "x05-kohdista-varmat-taas")
        xwCheck("x05 after Kumoa the chips are as before (\(chips), now \(xwSureChips()))", chipsBack, tree: "x05-kohdista-varmat-taas")
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
    /// ("Hyvityslasku · Meno", 50,00 € as the row says it), its 3-dot menu; and the pending one in the
    /// review queue with its actions.
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
                // One sign on every screen (C2): the refund is money back, plain, as on its row.
                check("x06 detail amount 50,00 € without a minus, as its row",
                      xwAny("label CONTAINS %@", "50,00").exists && !xwAny("label CONTAINS %@", "\u{2212}50,00").exists
                          && !xwAny("label CONTAINS %@", "-50,00").exists)
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
                // Its actions, looked for where they are drawn: Hyväksy is the screen's one primary, in
                // the bottom bar from the first frame, and Hylkää is in Toiminnot (N3). Read at once
                // after the push, they were rows of a lazy section two screens down (X071).
                let approve = xwHittable("Hyväksy", timeout: 10)
                if let approve { waitStill(approve) }
                xwShot("x06-hyvitys-odottaa-toiminnot")
                let reject = xwMenu("Toiminnot", item: "Hylkää", shot: "x06-hyvitys-odottaa-3dot-menu")
                xwCheck("x06 pending credit note offers Hyväksy (its primary) and Hylkää (Toiminnot)", approve != nil && reject,
                        tree: "x06-hyvitys-odottaa-toiminnot")
                xwScrollShots("x06-hyvitys-odottaa", screens: 1)
                xwPop(to: xwBar("Kuitit"), "x06 back to Kuitit from the pending credit note")
            }
        } else {
            xwCheck("x06 the pending credit note is in the review queue", false, tree: "x06-tarkastettavat-rivi")
        }
    }

    // MARK: - Raportit

    /// Raportit: the page, the year stepper, the Menot and Tulot drills, Luokittain, the zip (the one
    /// primary) and, from its 3-dot menu's Vienti (CSV), a CSV sheet.
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
        // The figures' links, not the chart's bars or the legend, which carry the same words.
        if let menot = xwFigure("Menot") {
            menot.tap(); taps += 1
            if xwAfterPush(xwBar("Kuitit"), "x07 Menot drill → Kuitit", shot: "x07-menot-kuitit") {
                // The chip is drawn on every tab; only its selection says which list opened (X087).
                let chip = app.buttons["receipt-tab-meno"].firstMatch
                xwCheck("x07 the Menot drill opens Kuitit on Menot (its chip selected)", xwUntil(10) { chip.exists && chip.isSelected },
                        tree: "x07-menot-kuitit-valinta")
                xwPop(to: root, "x07 back to Raportit from Menot")
            }
        } else {
            xwMiss("x07 Raportit figure Menot", tree: "x07-menot-kuitit")
        }
        xwToTop(4)
        // Tulot opens one list, or names its two (invoices and receipts) in rows under it.
        if let tulot = xwFigure("Tulot", "Avaa laskut") {
            let named = tulot.label
            tulot.tap(); taps += 1
            xwAfterPushAny("x07 Tulot drill (\(named)) opened a list", shot: "x07-tulot")
            xwPop(to: root, "x07 back to Raportit from Tulot")
        } else {
            xwMiss("x07 Raportit figure Tulot", tree: "x07-tulot")
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
                xwFileShown(zip, "x07 the zip", shot: "x07-lataa-zip")
                xwCloseSheet(zip, "the zip", with: [], shot: "x07-lataa-zip")
            }
        } else {
            xwMiss("x07 Kirjanpitopaketti button Lataa zip", tree: "x07-lataa-zip")
        }
        // The six CSV exports, behind Toiminnot › Vienti (CSV) (B8: Lataa zip is the page's one action).
        xwMenu("Toiminnot", via: "Vienti (CSV)", item: "Tuloslaskelma", shot: "x07-raportit-vienti-menu")
        if xwMenuPick("Toiminnot", "Tuloslaskelma", via: "Vienti (CSV)") {
            // Titled in words and by year (X084, P5): not by the API's type key, 'profit-loss-2026.csv'.
            let csv = xwBar("Tuloslaskelma \(StabilityTests.helsinkiMonth().year)")
            if xwSheetUp(csv, "x07 Toiminnot › Vienti (CSV) › Tuloslaskelma → CSV", shot: "x07-csv-tuloslaskelma") {
                xwFileShown(csv, "x07 the CSV", shot: "x07-csv-tuloslaskelma")
                xwCloseSheet(csv, "the CSV", with: [], shot: "x07-csv-tuloslaskelma")
            }
        }
    }

    // MARK: - Pankki

    /// The Kirjanpito hub, Pankki: its rows (N2: the hub between them went), its 3-dot menu and the
    /// month submenu in it, Vaatii toimia, Näytä enemmän, a bank row's sheet; Pankkiyhteys ja tilit
    /// from its first row (account sheet, Lisää tili käsin); Tiliotteet from its 3-dot menu, and a
    /// statement with its 3-dot menu and Näytä enemmän.
    func test08_Pankki() {
        guard xwTab("Kirjanpito", ready: app.staticTexts["Kohdista kuitit"].firstMatch, shot: "x08-kirjanpito") else { return }
        xwScrollShots("x08-kirjanpito", screens: 1)
        xwToTop(2)
        let pankki = xwBar("Pankki")
        guard tap("Pankki"), xwAfterPush(pankki, "x08 Pankki opened on its rows", shot: "x08-pankki") else {
            xwCheck("x08 Kirjanpito → Pankki", false, tree: "x08-pankki"); return
        }
        xwScrollShots("x08-pankki", screens: 2)
        xwToTop(3)

        xwMenu("Toiminnot", item: "Etsi kuitteja uudelleen", shot: "x08-pankki-3dot-menu")
        // One month control (X096): the chips, and Toiminnot's Kuukausi, which names the month shown.
        xwMenu("Toiminnot", via: "Kuukausi", item: nil, shot: "x08-pankki-kuukausi-menu")
        let needsAction = app.segmentedControls.buttons["Vaatii toimia"].firstMatch
        if needsAction.waitForExistence(timeout: 5), needsAction.isHittable {
            needsAction.tap(); taps += 1
            usleep(800_000)
            xwShot("x08-pankki-vaatii-toimia")
            let all = app.segmentedControls.buttons["Kaikki"].firstMatch
            if all.exists { all.tap(); taps += 1; usleep(800_000) }
        } else {
            xwMiss("x08 Pankki segment Vaatii toimia", tree: "x08-pankki-vaatii-toimia")
        }
        xwGrowAndFold("x08-pankki", expected: true)
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
            xwMiss("x08 Pankki lists the bank row K-Market 1", tree: "x08-pankkirivi")
        }
        xwToTop(6)

        // The balance and consent are Pankki's first row, which opens the accounts (O2).
        if xwOpen("label BEGINSWITH %@", "Saldo yhteensä", xwBar("Pankkiyhteys ja tilit"), "x08 Saldo yhteensä → Pankkiyhteys ja tilit", shot: "x08-pankkiyhteys") {
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
            xwPop(to: pankki, "x08 back to Pankki from Pankkiyhteys ja tilit")
        }

        if xwMenuPick("Toiminnot", "Tiliotteet"), xwAfterPush(xwBar("Tiliotteet"), "x08 Toiminnot → Tiliotteet opened", shot: "x08-tiliotteet") {
            xwGrowAndFold("x08-tiliotteet", expected: false)
            xwToTop(3)
            // The seed's long statement (tiliote-pitka.csv, 26 rows: longer than one step of 10).
            if xwOpen("label CONTAINS %@", "26 tapahtumaa", xwBarPrefix("Tiliote · "), "x08 the 26-row statement opened", shot: "x08-tiliote") {
                xwMenu("Toiminnot", item: "Tunnista palkat uudelleen", shot: "x08-tiliote-3dot-menu")
                xwGrowAndFold("x08-tiliote", expected: true)
                xwPop(to: xwBar("Tiliotteet"), "x08 back to Tiliotteet")
            }
            xwPop(to: pankki, "x08 back to Pankki from Tiliotteet")
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
        // The row's cell, as a thumb swipes it: on the 46 pt "Selain" label the swipe missed the
        // row, and the four steps below never ran (X113).
        let row = app.cells.containing(NSPredicate(format: "label == %@", "Selain")).firstMatch
        row.swipeLeft()
        let one = app.buttons.matching(NSPredicate(format: "label == %@", "Kirjaa ulos")).firstMatch
        let offered = one.waitForExistence(timeout: 5)
        xwShot("x10-laite-pyyhkaisy")
        xwCheck("x10 a device's swipe offers Kirjaa ulos", offered, tree: "x10-laite-pyyhkaisy")
        if offered {
            one.tap(); taps += 1
            xwConfirmCancel("x10 Kirjaa ulos (one device)", titlePrefix: "Kirjataanko laite ulos?", shot: "x10-laite-kirjaa-ulos")
            // The tap on the action closes the row, so Peruuta leaves it closed: a swipe right on a
            // closed row is the edge swipe that pops Laitteet (F010: no Selain row was left to sign out).
            let stillOpen = one.exists
            note("INFO x10 after Peruuta the row is \(stillOpen ? "still open, closed by a swipe" : "closed")")
            if stillOpen && row.exists { row.swipeRight() }
            // Then for real: the browser session is the CI's own throwaway sign-in. A step that cannot
            // run says so, as the map in AUDIT-WALK.md counts on these shots.
            if row.exists {
                row.swipeLeft()
                if one.waitForExistence(timeout: 5) {
                    one.tap(); taps += 1
                    let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
                    if confirm.waitForExistence(timeout: 8) {
                        waitStill(confirm)
                        xwShot("x10-laite-vahvistus")
                        confirm.tap(); taps += 1
                        let fewer = xwUntil(15) { self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Selain")).count < browsers }
                        usleep(500_000)
                        xwShot("x10-laite-kirjattu-ulos")
                        xwCheck("x10 Kirjaa ulos signed one Selain session out (\(browsers) before)", fewer, tree: "x10-laite-kirjattu-ulos")
                    } else {
                        xwMiss("x10 the real Kirjaa ulos asked nothing (no confirm sheet)", tree: "x10-laite-vahvistus")
                    }
                } else {
                    xwMiss("x10 the second swipe offered no Kirjaa ulos", tree: "x10-laite-pyyhkaisy-2")
                }
            } else {
                xwMiss("x10 no Selain row left to sign out for real", tree: "x10-laite-pyyhkaisy-2")
            }
        }
        xwCloseSettingsFromPushed(shot: "x10-asetukset-lopuksi")
    }

    // MARK: - Sign out → sign in

    /// A receipt photo kept on the phone offline → Asetukset → Kirjaudu ulos (asked, saying the photo
    /// goes: Peruuta first, then for real, offline, which deletes it) → the sign-in screen, online →
    /// one wrong password (said under the field, nothing moved) → the demo password → the tabs
    /// again, on Koti.
    func test11_SignOutIn() {
        // WalkTestCase.queuePhotoOffline: the proxy stays offline until the sign-in screen, so the
        // photo still waits when the question is asked and is gone with the session after it.
        let queued = queuePhotoOffline()
        xwShot("x11-jonossa")
        xwCheck("x11 a receipt photo waits on the phone (Testikuitti jonoon, offline)", queued, tree: "x11-jonossa")
        _ = selectTab("Koti")
        guard xwOpenSettings(shot: "x11-asetukset") else { return }
        guard xwTapVisible("label == %@", "Kirjaudu ulos") else { xwCheck("x11 Asetukset shows Kirjaudu ulos", false, tree: "x11-asetukset"); return }
        // S1 (X122): the question says what a sign-out deletes before it is answered.
        let message = app.staticTexts["confirm-sheet-message"].firstMatch
        let said = message.waitForExistence(timeout: 8) ? message.label : ""
        xwCheck("x11 the sign-out question says the waiting photo goes (\(said.isEmpty ? "no message" : said))",
                said.contains("1 kuitti odottaa lähetystä") && said.contains("poistetaan tästä laitteesta"), tree: "x11-kirjaudu-ulos-viesti")
        xwConfirmCancel("x11 Kirjaudu ulos", titlePrefix: "Kirjaudutaanko ulos?", shot: "x11-kirjaudu-ulos")
        guard xwTapVisible("label == %@", "Kirjaudu ulos") else { return }
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        guard confirm.waitForExistence(timeout: 8) else { xwCheck("x11 the sign-out question came back", false, tree: "x11-kirjaudu-ulos-2"); return }
        confirm.tap(); taps += 1
        let password = app.secureTextFields.firstMatch
        let signedOut = password.waitForExistence(timeout: 20)
        // Signed in again only through the server; the photo left with the session, so none is sent.
        goOnline()
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
        // Where the field the owner retypes stands before the refusal: a card above the form pushed
        // it down about 81 pt (X123 X124, B14).
        waitStill(password)
        let before = password.frame.minY
        app.buttons["Kirjaudu sisään"].firstMatch.tap(); taps += 1
        let refusal = xwAny("label CONTAINS %@", "salasana on väärin")
        let refused = refusal.waitForExistence(timeout: 20)
        if refused { waitStill(refusal) }
        let after = password.frame.minY
        xwShot("x11-vaara-salasana")
        xwCheck("x11 a wrong password says Sähköposti tai salasana on väärin", refused, tree: "x11-vaara-salasana")
        xwCheck("x11 the refusal left the password field in place (minY \(before) → \(after))", refused && abs(after - before) <= 1,
                tree: "x11-vaara-salasana-paikka")
        type(password, String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "demo123")
        app.buttons["Kirjaudu sisään"].firstMatch.tap(); taps += 1
        let back = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) }
        dismissSystemPrompts()
        let koti = app.tabBars.buttons["Koti"].firstMatch
        xwShot("x11-kirjautunut-taas")
        xwCheck("x11 signed in again: the tab bar is back", back, tree: "x11-kirjautunut-taas")
        xwCheck("x11 signed in again on Koti (its tab selected)", back && koti.exists && koti.isSelected, tree: "x11-kirjautunut-taas-koti")
    }

    // MARK: - Offline

    /// Offline (scripts/sim/api-proxy.py drops every connection) on Myynti, Kirjanpito → Ostolaskut
    /// and Asetukset → Laitteet; then online: the banner leaves, Laitteet reloads by itself, and
    /// Ostolaskut and Myynti answer without a failure.
    func test12_Offline() {
        let banner = app.descendants(matching: .any)["offline-banner"]
        // A failed load over rows still shown (RefreshFailureBanner) and a failed first load
        // (LoadFailureView) both offer it; the banner reads as one element with its words.
        let failure = "Yritä uudelleen"
        let hub = app.staticTexts["Kohdista kuitit"].firstMatch
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
        let myyntiFailed = xwShown("label CONTAINS %@", failure)
        xwShot("x12-myynti-offline")
        xwCheck("x12 Myynti offline: banner \(bannerText.isEmpty ? "missing" : bannerText)", bannerText == "Palvelimeen ei saada yhteyttä", tree: "x12-myynti-offline")
        note("INFO x12 Myynti offline shows its own failure: \(myyntiFailed)")

        // Ostolaskut paints from the cache (TabPrebuild and the Kirjanpito hub warm it), so opened
        // offline it shows its rows: a pull to refresh from its first row asks the server, and fails.
        if selectTab("Kirjanpito"), xwOpen("label BEGINSWITH %@", "Ostolaskut", xwBar("Ostolaskut"), "x12 Ostolaskut opened offline", shot: "x12-ostolaskut-offline-avattu") {
            xwPullToRefresh()
            let failed = xwUntil(20) { xwShown("label CONTAINS %@", failure) }
            if failed { usleep(500_000) }
            xwShot("x12-ostolaskut-offline")
            xwCheck("x12 Ostolaskut offline: a pull to refresh shows a failure with Yritä uudelleen", failed, tree: "x12-ostolaskut-offline")
            check("x12 Ostolaskut offline: banner still up", banner.exists)
            // Asetukset is on the tab roots only: from Ostolaskut the walk looked for it in vain (X130).
            xwPop(to: hub, "x12 back to the Kirjanpito root for Asetukset")
        }

        // Asetukset → Laitteet offline: the banner is under the sheet; the screen says it itself.
        if xwOpenSettings(shot: "x12-asetukset-offline"), tap("Laitteet") {
            let failed = xwUntil(20) { xwShown("label CONTAINS %@", failure) }
            if failed { usleep(500_000) }
            xwShot("x12-laitteet-offline")
            xwCheck("x12 Laitteet offline shows a failure with Yritä uudelleen", failed, tree: "x12-laitteet-offline")
            goOnline()
            note("INFO x12 online again")
            // Back online the screen reloads by itself once the probe sees the server: its failure
            // goes without a tap, and the devices are listed. A list that was there all along, or a
            // failure left standing, is not a reload (X131).
            let cleared = xwUntil(30) { !xwShown("label CONTAINS %@", failure) }
            let listed = cleared && xwAny("label CONTAINS %@", "(tämä laite)").waitForExistence(timeout: 10)
            xwShot("x12-laitteet-takaisin-verkossa")
            xwCheck("x12 back online: Laitteet reloaded by itself (no Yritä uudelleen, this device listed)", failed && listed,
                    tree: "x12-laitteet-takaisin-verkossa")
            xwCloseSettingsFromPushed(shot: "x12-asetukset-lopuksi")
        } else {
            goOnline()
            note("INFO x12 online again")
        }

        _ = selectTab("Kirjanpito")
        let gone = xwGone(banner, timeout: 30)
        xwShot("x12-kirjanpito-takaisin-verkossa")
        xwCheck("x12 back online: banner gone", gone, tree: "x12-banneri-pois")
        // Ostolaskut again, popped for Asetukset: its rows, and no failure.
        if xwOpen("label BEGINSWITH %@", "Ostolaskut", xwBar("Ostolaskut"), "x12 Ostolaskut opened online", shot: "x12-ostolaskut-takaisin-verkossa") {
            let rows = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Ripsitukku")).firstMatch.waitForExistence(timeout: 20)
            xwCheck("x12 back online: Ostolaskut lists Ripsitukku Oy without Yritä uudelleen", rows && !xwShown("label CONTAINS %@", failure),
                    tree: "x12-ostolaskut-takaisin-verkossa")
            xwPop(to: hub, "x12 back to the Kirjanpito root")
        }
        _ = selectTab("Myynti")
        let reloaded = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Luonnokset")).firstMatch.waitForExistence(timeout: 20)
        let answered = reloaded && xwUntil(20) { !xwShown("label CONTAINS %@", failure) }
        xwShot("x12-myynti-takaisin-verkossa")
        xwCheck("x12 back online: Myynti answers again\(myyntiFailed ? ", its failure gone" : "") (no Yritä uudelleen)", answered,
                tree: "x12-myynti-takaisin-verkossa")
    }

    // MARK: - Lisää

    /// The + tab's sheet: its rows Uusi myyntilasku (its customer picker, a line's 3-dot menu), Lisää
    /// tiedosto (the capture page, titled by its row) and Kuvaa kuitti (the camera: the simulator's
    /// picker page); its 3-dot menu with the imports: Yhdistä sähköposti (pushed in the sheet) and
    /// Tuo tiliote (the system file picker, cancelled) (N7). The form and the capture close the
    /// sheet with them (one movement, X139), so it is opened again after each; it closes by a swipe.
    func test13_LisaaSheet() {
        let sheet = xwBar("Lisää")
        xwOpenAdd()
        guard xwSheetUp(sheet, "x13 + → Lisää sheet", shot: "x13-lisaa") else { return }
        xwMenu("Toiminnot", item: "Tuo tiliote", shot: "x13-lisaa-3dot-menu")

        if xwTapVisible("label == %@", "Uusi myyntilasku") {
            let form = xwBar("Uusi lasku")
            if xwSheetUp(form, "x13 Uusi myyntilasku → Uusi lasku", shot: "x13-uusi-lasku") {
                xwInvoiceFormParts("x13-uusi-lasku")
                xwCloseSheet(form, "Uusi lasku", with: ["Peruuta"], shot: "x13-uusi-lasku")
                note("INFO x13 closing the form closes the Lisää sheet too: \(xwGone(sheet, timeout: 3))")
            }
        } else {
            xwMiss("x13 Lisää sheet row Uusi myyntilasku", tree: "x13-uusi-lasku")
        }
        xwReopenAdd(sheet)

        // The sheet's own row: a Koti task's "Kuvaa kuitti" pill under the sheet has the same words.
        for (row, title, slug) in [("Lisää tiedosto", "Lisää tiedosto", "lisaa-tiedosto"), ("Kuvaa kuitti", "Uusi kuitti", "kuvaa-kuitti")] {
            if xwTapButton(row) {
                let capture = xwBar(title)
                if xwSheetUp(capture, "x13 \(row) → \(title)", shot: "x13-\(slug)") {
                    if slug == "lisaa-tiedosto" {
                        check("x13 the capture page offers Valitse kuvista", app.buttons["Valitse kuvista"].firstMatch.exists || app.staticTexts["Valitse kuvista"].firstMatch.exists)
                    } else {
                        // The simulator has no camera, so the page opens on its picker; UITestHooks' marker
                        // says the camera was asked for (P1Tests.test16).
                        check("x13 Kuvaa kuitti asked for the camera (capture-camera-asked)",
                              app.descendants(matching: .any).matching(identifier: "capture-camera-asked").firstMatch.exists)
                    }
                    xwCloseSheet(capture, title, with: ["Peruuta", "Sulje"], shot: "x13-\(slug)")
                    note("INFO x13 closing the capture screen closes the Lisää sheet too: \(xwGone(sheet, timeout: 3))")
                }
            } else {
                xwMiss("x13 Lisää sheet row \(row)", tree: "x13-\(slug)")
            }
            xwReopenAdd(sheet)
        }

        // The mailbox item reads Yhdistä sähköposti only while none is connected; Hae sähköpostista
        // would fetch mail, so it is only named.
        let menuButton = xwHittable("Toiminnot", timeout: 5)
        if let connect = xwOpenMenu("Toiminnot", item: "Yhdistä sähköposti") {
            connect.tap(); taps += 1
            if xwAfterPush(xwBar("Sähköpostien tuonti"), "x13 Toiminnot → Yhdistä sähköposti → Sähköpostien tuonti (in the sheet)", shot: "x13-yhdista-sahkoposti") {
                xwPop(to: sheet, "x13 back to the Lisää sheet", shot: "x13-lisaa-takaisin")
            }
        } else {
            note("INFO x13 the menu's mailbox item reads \(app.buttons["Hae sähköpostista"].firstMatch.exists ? "Hae sähköpostista" : "neither label")")
            xwCloseMenu(app.buttons["Hae sähköpostista"].firstMatch.exists ? app.buttons["Hae sähköpostista"].firstMatch : nil, anchor: menuButton)
        }

        // The system document picker: only its own Cancel can be driven.
        if xwMenuPick("Toiminnot", "Tuo tiliote") {
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
        }
        if sheet.exists { xwCloseSheet(sheet, "Lisää", with: [], shot: "x13-lisaa") }
    }

    // MARK: - Asetukset, every row

    /// Asetukset from its top a screenful at a time, with the "Kohdista varmat automaattisesti"
    /// switch read where it is drawn; then every other row opened and left (Laitteet is x10,
    /// Kirjaudu ulos x11), with the two sheets inside them (Uusi malli, Yhdistä sähköpostitili) shot
    /// open and closed.
    func test14_AsetuksetRows() {
        guard xwOpenSettings(shot: "x14-asetukset") else { return }
        // Read as the sheet opens, at its top: after the rows below, the list stayed at its end, where
        // the switch's cell is not built, and it read "not found" (X156).
        let autoLink = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Kohdista varmat automaattisesti")).firstMatch
        let found = xwReveal(autoLink, wait: 10, maxSwipes: 2)
        let state = found ? "\((autoLink.value as? String) == "1" ? "ON" : "OFF"), \(autoLink.isEnabled ? "enabled" : "disabled")" : "not found"
        note("INFO x14 Kohdista varmat automaattisesti: \(state) (left as it is)")
        xwCheck("x14 Asetukset shows the switch Kohdista varmat automaattisesti", found, tree: "x14-asetukset-kohdista-varmat")
        // From the top, before any row's tap scrolls the list to that row: shot at the end, the root
        // was at its bottom already and every screenful was the same (X157).
        xwScrollShots("x14-asetukset", screens: 3, inSheet: true)
        // Opened again for the rows, at its top: a swipe down at the top of a sheet's list closes it.
        xwCloseSettings(shot: "x14-asetukset")
        guard xwOpenSettings(shot: "x14-asetukset-rivit") else { return }
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
                xwScrollShots(name, screens: 2, inSheet: true)
            default:
                break
            }
            xwPop(to: root, "x14 back to Asetukset from \(entry.title)")
        }
        xwCloseSettings(shot: "x14-asetukset-rivit")
    }

    // MARK: - Kirjanpito, the other screens

    /// The Kirjanpito hub's other rows: Ostolaskut (+ sheet, Ripsitukku Oy scrolled, with its 3-dot
    /// menu and sheets), Sähköposti, Kohdista kuitit, Kohdista ostolaskujen maksut, Kuukauden sulku,
    /// and Tulos ja tase (each part).
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
                // Below its first screen: the Kuitti and Maksut sections were never seen (X169).
                xwScrollShots("x15-ostolasku", screens: 2)
                xwToTop(3)
                xwMenu("Toiminnot", item: "Tee toistuvaksi", shot: "x15-ostolasku-3dot-menu")
                // Each sheet's bar is read for its title, whole (xwSheetUp): 'Kirjaa maksu' was not
                // drawn and 'Hyvitä ostolasku' was cut, and both passed on the bar's identifier.
                for (item, title, slug, close) in [("Kirjaa maksu", "Kirjaa maksu", "kirjaa-maksu", "Peruuta"),
                                                   ("Kohdista pankkiin", "Kohdista pankkiin", "kohdista", "Sulje"),
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

        // Kohdista kuitit opens Pankki on Vaatii toimia (N2: Pankki is the bank rows' screen).
        for (row, title, slug) in [("Sähköposti", "Sähköposti", "sahkoposti"),
                                   ("Kohdista kuitit", "Pankki", "kohdista-kuitit"),
                                   ("Kohdista ostolaskujen maksut", "Kohdista ostolaskujen maksut", "kohdista-ostolaskut"),
                                   ("Kuukauden sulku", "Kuukauden sulku", "kuukauden-sulku")] {
            if xwOpen("label BEGINSWITH %@", row, xwBar(title), "x15 \(row) opened", shot: "x15-\(slug)") {
                if slug == "kuukauden-sulku" { xwScrollShots("x15-\(slug)", screens: 2) }
                if slug == "sahkoposti" { xwGrowAndFold("x15-\(slug)", expected: false) }
                xwPop(to: hubReady, "x15 back to the hub from \(row)")
            }
        }

        // The ledger, "Tulos ja tase" (P4: it had the tab's own name, Kirjanpito); a part button shows it opened.
        if xwOpen("label BEGINSWITH %@", "Tulos ja tase", app.buttons["Tase"].firstMatch, "x15 Tulos ja tase (the ledger) opened", shot: "x15-kirjanpito-tulos") {
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

    /// Shot names used in this run (all tests of the class share ui-shots): a repeated name would
    /// leave one picture for two steps.
    private static var xwNames = Set<String>()

    /// `name`, or `name-2`, `name-3`… when the run has used it already.
    private func xwUniqueName(_ name: String) -> String {
        var unique = name
        var n = 2
        while Self.xwNames.contains(unique) { unique = "\(name)-\(n)"; n += 1 }
        Self.xwNames.insert(unique)
        return unique
    }

    /// A screenshot kept in the result bundle (exported to ui-attachments/named) and, where the host
    /// watcher runs (CI, scripts/sim/run-ui.sh), as ui-shots/<name>.png.
    private func xwShot(_ name: String) {
        let unique = xwUniqueName(name)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = unique
        attachment.lifetime = .keepAlways
        add(attachment)
        shot(unique)
    }

    /// A picture taken in the test process at once, without waiting for the host: kept as the
    /// attachment and written as ui-shots/<name>.png itself, for a state that lasts seconds (the
    /// linked chips under the sure-pairs toast, X066). The host's picture came seconds later.
    private func xwShotNow(_ name: String) {
        let unique = xwUniqueName(name)
        let picture = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: picture)
        attachment.name = unique
        attachment.lifetime = .keepAlways
        add(attachment)
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        do {
            try picture.pngRepresentation.write(to: URL(fileURLWithPath: "\(shotDir)/\(unique).png"))
        } catch {
            note("MISS shot \(unique): \(error.localizedDescription)")
        }
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

    /// Scrolls a form row above the pinned save, as the owner would before tapping it: a row under
    /// the bar still counts as hittable, and a tap on it lands on the save (OwnerScreensTests.
    /// clearOfSave; the walk's category tap pressed Tallenna kuitti, F010). The frame is judged
    /// before `isHittable`, which fails the test for a row wholly below the screen.
    private func xwClearOfSave(_ element: XCUIElement, _ save: XCUIElement) -> Bool {
        for attempt in 0...4 {
            guard element.exists else { return false }
            let bar = save.exists ? save.frame.minY : xwWindow.frame.maxY
            if element.frame.minY > 100, element.frame.maxY <= bar - 4, element.isHittable { return true }
            guard attempt < 4 else { break }
            xwWindow.swipeUp(velocity: .slow); scrolls += 1
            waitStill(element)
        }
        return false
    }

    private func xwToTop(_ swipes: Int = 4) {
        for _ in 0..<swipes { xwWindow.swipeDown(velocity: .fast) }
    }

    /// A long screen a screenful at a time from its top: each slow swipe is shot once the page has
    /// stopped, until a swipe leaves the first row on screen where it was (the end), which is noted
    /// as END instead of shooting the same page again: the swipes went on past the end, and the
    /// shots repeated one page (X101, X157). In a sheet the page is shot from where it is: a
    /// downward swipe at the top of a sheet's list closes the sheet.
    private func xwScrollShots(_ name: String, screens: Int, inSheet: Bool = false) {
        if !inSheet { xwToTop() }
        var last = xwSettledFirstVisible()
        for i in 1...max(1, screens) {
            xwWindow.swipeUp(velocity: .slow); scrolls += 1
            let now = xwSettledFirstVisible()
            if let now, now == last {
                note("END \(name) after \(i - 1)")
                return
            }
            last = now
            xwShot("\(name)-vieritys\(i)")
        }
    }

    /// The scrolling list on screen: the largest hittable collection view (a List), else the
    /// largest hittable scroll view (Koti). Other tabs' lists can be in the tree; not hittable.
    private func xwScroller() -> XCUIElement? {
        for query in [app.collectionViews, app.scrollViews] {
            var largest: (element: XCUIElement, area: CGFloat)?
            for element in query.allElementsBoundByIndex where element.isHittable {
                let frame = element.frame
                if frame.width * frame.height > (largest?.area ?? 0) { largest = (element, frame.width * frame.height) }
            }
            if let largest { return largest.element }
        }
        return nil
    }

    /// The first cell (in a scroll view without cells, the first text) under the bars, as its label
    /// and frame: what a scroll moves, and what the end of a page leaves as it was. Read off one
    /// snapshot of the list, not element by element.
    private func xwFirstVisible() -> String? {
        guard let list = xwScroller(), let tree = try? list.snapshot() else { return nil }
        let window = xwWindow.frame
        func first(_ node: XCUIElementSnapshot) -> XCUIElementSnapshot? {
            for child in node.children {
                let frame = child.frame
                if child.elementType == .cell || child.elementType == .staticText,
                   frame.height > 0, frame.maxY > window.minY + 100, frame.minY < window.maxY - 100 {
                    return child
                }
                if let found = first(child) { return found }
            }
            return nil
        }
        return first(tree).map { "\($0.label) \($0.frame)" }
    }

    /// `xwFirstVisible` once two reads 300 ms apart agree: a swipe's scroll runs on after the finger.
    private func xwSettledFirstVisible() -> String? {
        var last = xwFirstVisible()
        for _ in 0..<10 {
            usleep(300_000)
            let now = xwFirstVisible()
            if now == last { return now }
            last = now
        }
        return last
    }

    /// Pull to refresh from the first list cell, where a thumb starts it (as H2's MotionAuditTests.
    /// pullToRefresh): from 25 % of the window the drag began on Myynti's search field and pulled
    /// nothing (M030, M083). A screen without a cell in its upper half is pulled from there still.
    private func xwPullToRefresh() {
        let window = xwWindow.frame
        var top = CGPoint(x: window.midX, y: window.height * 0.25)
        let cells = app.cells
        for index in 0..<min(cells.count, 8) {
            let cell = cells.element(boundBy: index)
            let frame = cell.frame
            if frame.midY > window.minY + 100, frame.midY < window.height * 0.5, cell.isHittable {
                top = CGPoint(x: frame.midX, y: frame.midY)
                break
            }
        }
        let origin = xwWindow.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: top.x, dy: top.y))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: top.x, dy: top.y + window.height * 0.5)))
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

    /// A sheet's bar came up, and it draws its title, whole. The bar is found by its identifier,
    /// which it keeps when the title is crowded out of it or cut short ('Kirjaa maksu' not drawn,
    /// 'Hyvitä ostolasku' drawn as 'Hyvitä os…' both passed, X169). Those two are recorded on their
    /// own lines; the walk goes on with the sheet as long as it is up.
    @discardableResult
    private func xwSheetUp(_ bar: XCUIElement, _ what: String, shot name: String, timeout: TimeInterval = 15) -> Bool {
        let up = bar.waitForExistence(timeout: timeout)
        if up { usleep(700_000) }
        xwShot(name)
        guard xwCheck(what, up, tree: name) else { return false }
        let title = bar.identifier
        // A title view of its own reads as one element, its words first ("Uusi lasku, Seuraava laskunumero: …").
        let named = NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, title + ",")
        let drawn = bar.staticTexts.matching(named).firstMatch.exists || bar.otherElements.matching(named).firstMatch.exists
        xwCheck("\(name): the bar draws its title '\(title)'", drawn, tree: name + "-otsikko")
        if let clipped = xwClipped(in: bar.frame) {
            xwCheck("\(name): nothing in the bar is cut\(clipped.isEmpty ? "" : " (\(clipped.joined(separator: "; ")))")", clipped.isEmpty,
                    tree: name + "-otsikko")
        } else {
            xwCheck("\(name): the textClipped audit ran on the bar", false, tree: name + "-otsikko")
        }
        return true
    }

    /// What the textClipped audit finds cut inside `area` (as OwnerScreensTests.clippedTexts, within a
    /// frame as P2Tests reads it): its label and what the audit said. Its guesses at larger text
    /// sizes are left out, as there: they belong to B5. Nil when the audit did not run.
    private func xwClipped(in area: CGRect) -> [String]? {
        final class Found { var texts: [String] = [] }
        let found = Found()
        do {
            try app.performAccessibilityAudit(for: .textClipped) { issue in
                guard let frame = issue.element?.frame else { return true }
                let shared = frame.intersection(area)
                guard !shared.isNull, shared.width > 0.5, shared.height > 0.5 else { return true }
                let label = issue.element?.label ?? ""
                if !"\(issue.compactDescription) \(issue.detailedDescription)".localizedCaseInsensitiveContains("larger") {
                    found.texts.append("\(label.isEmpty ? issue.compactDescription : label): \(issue.detailedDescription)")
                }
                return true
            }
        } catch {
            note("MISS textClipped audit: \(error)")
            return nil
        }
        return found.texts
    }

    /// A file sheet (DocumentPreviewSheet) shows its file: no "Avataan…", no "Tiedostoa ei voitu
    /// avata", a zip's size read, and a button in the bar. The bar has the file's name from the
    /// first frame, so the bar alone passed on a blank sheet still opening (X030, X087). Since M047
    /// its Valmis is there from the first frame too, and a zip's summary stands from the first
    /// frame with its size "Ladataan…": neither a button in the bar nor the lack of "Avataan…"
    /// says the file came.
    @discardableResult
    private func xwFileShown(_ bar: XCUIElement, _ what: String, shot name: String) -> Bool {
        let opening = xwAny("label == %@", "Avataan…")
        let failed = xwAny("label == %@", "Tiedostoa ei voitu avata")
        let sizing = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "document-zip-size", "Ladataan…")).firstMatch
        let shown = xwUntil(30) { bar.buttons.count > 0 && !opening.exists && !failed.exists && !sizing.exists }
        if shown { waitStill(bar.buttons.firstMatch) }
        xwShot(name + "-sisalto")
        return xwCheck("\(what) shows the file (a button in the bar, no Avataan…, no failure, a zip's size read)", shown, tree: name + "-sisalto")
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
    /// left over shows. `item` is one entry the menu should list; with `submenu` (Toiminnot › Suodata)
    /// that entry is opened first and `item` is in it, nil taking the choice the entry names.
    @discardableResult
    private func xwMenu(_ label: String, via submenu: String? = nil, item: String?, shot name: String) -> Bool {
        guard let button = xwHittable(label) else {
            xwShot(name + "-ei-painiketta")
            return xwCheck("\(name): menu button \(label) on screen", false, tree: name)
        }
        let entry: XCUIElement?
        if let submenu {
            entry = xwOpenSubmenu(label, submenu, item: item)
        } else if let item {
            entry = xwOpenMenu(label, item: item)
        } else {
            entry = nil
        }
        let path = label + (submenu.map { " › \($0)" } ?? "")
        // The menu grows out of its button: shot once it stands.
        if entry != nil { usleep(600_000) }
        xwShot(name + "-auki")
        xwCheck("\(name): \(path) opened and lists \(item ?? entry?.label ?? "the choice it names")", entry != nil, tree: name + "-auki")
        // Closed even when the entry was not seen: a menu without it would cover the next steps.
        xwCloseMenu(entry, anchor: button)
        guard let entry else { return false }
        let closed = xwGone(entry, timeout: 6)
        if closed { usleep(400_000) }
        xwShot(name + "-suljettu")
        xwCheck("\(name): \(label) closed by a tap beside it", closed, tree: name + "-suljettu")
        return true
    }

    /// Taps a menu button and returns the entry `item` its menu added. Not the first button of that
    /// name: a screen can hold one too (Kuitti's "Muokkaa" row; an open ostolasku's primary says
    /// "Kohdista pankkiin" as its menu does, X165), so the entry is the match the tap added, told
    /// by its frame and not by its place in the tree: the tap on the primary under the open menu
    /// only closed it and the sheet never came (F010, test15).
    private func xwOpenMenu(_ label: String, item: String) -> XCUIElement? {
        guard let button = xwHittable(label, timeout: 5) else { return nil }
        let entries = app.buttons.matching(NSPredicate(format: "label == %@", item))
        let before = entries.allElementsBoundByIndex.map(\.frame)
        button.tap(); taps += 1
        guard xwUntil(6, { entries.count > before.count }) else { return nil }
        return entries.allElementsBoundByIndex.last(where: { !before.contains($0.frame) })
    }

    /// Opens `label`'s menu, then its submenu entry `prefix` (Toiminnot › Suodata, › Vienti (CSV),
    /// › Kuukausi · Lokakuu 2026), and returns the entry `item` the submenu added; without `item`,
    /// the choice the submenu's entry names after its " · ".
    private func xwOpenSubmenu(_ label: String, _ prefix: String, item: String?) -> XCUIElement? {
        guard let button = xwHittable(label, timeout: 5) else { return nil }
        let submenus = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
        let before = submenus.count
        button.tap(); taps += 1
        guard xwUntil(6, { submenus.count > before }) else { return nil }
        let submenu = submenus.element(boundBy: submenus.count - 1)
        let wanted = item ?? submenu.label.components(separatedBy: " · ").last ?? ""
        let entries = app.buttons.matching(NSPredicate(format: "label == %@", wanted))
        let shown = entries.count
        submenu.tap(); taps += 1
        guard xwUntil(6, { entries.count > shown }) else { return nil }
        return entries.element(boundBy: entries.count - 1)
    }

    /// A tap beside an open menu: inside the window, below the bars, on the side away from the menu
    /// (`entry`, else its button `anchor`), so it neither picks an entry nor lands in the status-bar
    /// band over a sheet, where the Avustaja attach menu stayed open over Keskustelut (X107, X108).
    /// Waits for `entry` to go and tries a second point once; a menu still open is noted as MISS.
    @discardableResult
    private func xwCloseMenu(_ entry: XCUIElement?, anchor: XCUIElement?) -> Bool {
        let window = xwWindow.frame
        var side = window.maxX
        if let entry, entry.exists { side = entry.frame.midX } else if let anchor, anchor.exists { side = anchor.frame.midX }
        let dx: CGFloat = side > window.midX ? 0.08 : 0.92
        guard let entry else {
            // Nothing the menu shows is known. An open menu covers its button: a button still
            // hittable means none is open, and a tap there would land on the screen's own rows.
            if let anchor, anchor.exists, anchor.isHittable { return true }
            xwWindow.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: 0.5)).tap()
            return true
        }
        for dy: CGFloat in [0.5, 0.32] {
            xwWindow.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy)).tap()
            if xwGone(entry, timeout: 4) { return true }
        }
        note("MISS a menu is still open after two taps beside it (\(entry.label))")
        return false
    }

    /// Opens `menu` (and its `submenu`) and taps its entry `item` (the way to what only the menu offers).
    private func xwMenuPick(_ menu: String, _ item: String, via submenu: String? = nil) -> Bool {
        let tree = "x-menu-" + (menu + "-" + item).lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        guard let button = xwHittable(menu, timeout: 5) else {
            note("MISS menu \(menu) (for \(item))")
            dump(app, tree + "-tree")
            return false
        }
        let found: XCUIElement?
        if let submenu { found = xwOpenSubmenu(menu, submenu, item: item) } else { found = xwOpenMenu(menu, item: item) }
        guard let entry = found else {
            note("MISS \(menu)\(submenu.map { " › \($0)" } ?? "") has no \(item)")
            dump(app, tree + "-tree")
            xwCloseMenu(nil, anchor: button)
            return false
        }
        entry.tap(); taps += 1
        return true
    }

    /// The list's "Näytä enemmän (N)" / "Näytä vähemmän" row, scrolled into view (StabilityTests.toggleRow).
    /// In a sheet it only scrolls down: a downward swipe at the top of a sheet's list closes the sheet.
    /// Only the row in front counts: the screen under a sheet keeps its own in the tree, covered
    /// (Koti's 'Näytä enemmän (6)' under Keskustelut: the tap on it failed test09, F010).
    private func xwToggleRow(up: Bool = false, inSheet: Bool = false, maxSwipes: Int = 8) -> XCUIElement? {
        let query = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label == %@", "Näytä enemmän", "Näytä vähemmän"))
        _ = query.firstMatch.waitForExistence(timeout: 3)
        for down in inSheet ? [true] : [!up, up] {
            for _ in 0...maxSwipes {
                if let row = query.allElementsBoundByIndex.first(where: {
                    $0.exists && $0.frame.minY > 30 && $0.frame.maxY < xwWindow.frame.maxY - 60 && $0.isHittable
                }) { return row }
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

    /// Taps a Kuitit chip by its id. The chip row is a section of the list, built only near its top:
    /// three swipes down the list took it out of the tree, and Laskut was never found (X050). So the
    /// list goes back to its top when the row is not on screen (only then: a swipe down at the top
    /// pulls a refresh), and the row is waited for. The row scrolls sideways, edge to edge (B11), so
    /// a chip past the screen's edge is brought in by its frame: `isHittable` of a chip wholly past
    /// the edge fails the test instead of answering false, and a swipe on an off-screen chip does
    /// too (F010: Ei kohdistettu in test03 and test05, Laskut and Kaikki in test04).
    private func xwChip(_ id: String) -> Bool {
        let row = app.scrollViews.matching(identifier: "receipt-chips").firstMatch
        // A moment for a list still sliding in, before it counts as scrolled away.
        if !xwUntil(3, { row.exists && row.isHittable }) { xwToTop() }
        guard row.waitForExistence(timeout: 15) else { return false }
        let chip = app.buttons["receipt-tab-\(id)"].firstMatch
        guard chip.waitForExistence(timeout: 15) else { return false }
        guard revealChip(chip, inRow: "receipt-chips") else {
            note("MISS chip \(id) could not be brought onto the screen (frame \(chip.frame), window \(xwWindow.frame))")
            return false
        }
        chip.tap(); taps += 1
        return true
    }

    /// The on-screen chip of `chips` is selected and the list under it is as long as the chip says:
    /// the section header (`header`, "3 laskua", "12 kuittia") carries the chip's number, or is
    /// absent when the chip says 0. Waited for, as the list follows the tap. A tapped chip alone
    /// passed whatever the list showed (X030).
    private func xwChipShows(_ chips: XCUIElementQuery, header pattern: String) -> (ok: Bool, said: String) {
        let headers = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", pattern))
        var said = "no chip on screen"
        let ok = xwUntil(10) {
            // Its centre is looked at first: `isHittable` of a chip wholly past the screen's edge fails the test.
            guard let chip = chips.allElementsBoundByIndex.first(where: { candidate in
                let frame = candidate.frame
                return xwWindow.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) && candidate.isHittable
            }) else { return false }
            let count = xwLastNumber(chip.label)
            let header = headers.allElementsBoundByIndex.first { $0.isHittable }
            let listed = header.map { xwLastNumber($0.label) } ?? 0
            said = "\(chip.label)\(chip.isSelected ? ", selected" : ", not selected"); list \(header?.label ?? "without a count")"
            return chip.isSelected && count >= 0 && listed == count
        }
        return (ok, said)
    }

    /// An element of `format`/`arg` is drawn on the screen in front (the trees of other tabs and of
    /// the screen under a sheet hold their own).
    private func xwShown(_ format: String, _ arg: String) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: format, arg)).allElementsBoundByIndex.contains { $0.isHittable }
    }

    /// The Kuitit chips a sure-pairs link changes, as their labels read ("Kohdistettu 2 | Ei kohdistettu 33").
    private func xwSureChips() -> String {
        ["linked", "unlinked"].map { id -> String in
            let chip = app.buttons["receipt-tab-\(id)"].firstMatch
            return chip.exists ? chip.label : "no \(id)"
        }.joined(separator: " | ")
    }

    /// A Raportit figure's link by its name ("Menot"; for Tulot with two lists, "Avaa laskut"), the
    /// first name first: a button outside Luokittain's segments, which carry the same names, below
    /// the bars and scrolled to (StabilityTests.menotFigure). The chart's bars and its legend are no
    /// buttons; a tap on "Menot" over them picked a month instead (B8 put Kuukausittain first).
    private func xwFigure(_ names: String...) -> XCUIElement? {
        for attempt in 0...6 {
            let segments = app.segmentedControls.allElementsBoundByIndex.map(\.frame)
            let bottom = xwWindow.frame.maxY - 90
            for name in names {
                let figure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).allElementsBoundByIndex.first { button in
                    button.isHittable && button.frame.minY > 100 && button.frame.maxY < bottom && !segments.contains { $0.intersects(button.frame) }
                }
                if let figure { return figure }
            }
            if attempt < 6 { xwWindow.swipeUp(velocity: .slow); scrolls += 1 }
        }
        return nil
    }

    /// The Lisää sheet again, once what it opened has closed it with itself (the form and the
    /// capture, in one movement: X139).
    private func xwReopenAdd(_ sheet: XCUIElement) {
        guard xwGone(sheet, timeout: 3) else { return }
        xwOpenAdd()
        _ = sheet.waitForExistence(timeout: 10)
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
