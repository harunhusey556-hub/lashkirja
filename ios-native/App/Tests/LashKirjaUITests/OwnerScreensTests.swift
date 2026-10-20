import XCTest
import UIKit

/// The screens the owner complained about (2026-10-12), proven on a simulator against the demo API
/// (`demo-seed.ts --ci`, receipts given real picture files by the workflow): the delete confirmation
/// is a bottom sheet naming the item, the capture form shows the file above the fields, the queue
/// survives "Takaisin", and Kuitit lists rows with pictures and a non-zero "Ei kohdistettu".
/// Unlike the walks these ASSERT, and every step is kept as a screenshot in the result bundle.
/// Launched with `-LKUITest` (App `UITestHooks`, Debug only) for the capture fixture and thumbnails.
final class OwnerScreensTests: WalkTestCase {
    /// Replaces `WalkTestCase.setUp` (not called): that one launches without `-LKUITest`, and calling
    /// it as well would launch the app twice.
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
        // Not a fixed look for the password field: the first launch on a fresh simulator showed it
        // after 8 s, so the sign-in was skipped and testA met an untouched form (run 38856286498).
        let signingIn = launchSignedIn()
        // The passkey offer after a password sign-in.
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        // As WalkTestCase.setUp: the save offer can come seconds after the tab bar, over testA's taps.
        if signingIn { probe { _ = savePasswordPrompt.waitForExistence(timeout: 10) } }
        sleep(1); dismissSystemPrompts()
        XCTAssertTrue(app.tabBars.firstMatch.exists, "not signed in: is the demo API up on the API_BASE_URL the app was built with?")
    }

    /// A screenshot in the result bundle (kept even when the test passes) and, where a host watcher
    /// runs (CI, scripts/sim/run-ui.sh), a PNG in the shot directory.
    func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        shot("owner-" + name)
    }

    func keep(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        note("INFO \(name): \(text)")
    }

    /// The element tree at a failure: what was on screen, not only a picture of it.
    func tree(_ name: String) { keep(name + "-tree", app.debugDescription) }

    /// Asks `exists` itself rather than through an `XCTNSPredicateExpectation`. On a loaded CI host one
    /// `exists` took 1.6–4.3 s and the predicate waiter spent up to 3.4 s more capturing a debug
    /// description, so it sampled once in 5 s and gave up on a sheet the recording shows gone 2 s
    /// after Peruuta (runs 38676562693, 38695044302). As with `waitForExistence`, which answered
    /// "Toiminnot" after 13.9 s in the same run, the last answer counts: one is taken after the deadline.
    func waitGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            usleep(250_000)
        }
        return !element.exists
    }

    /// The count in a chip's label ("Ei kohdistettu, 27"); -1 while the counts have not arrived.
    static func lastNumber(_ label: String) -> Int {
        guard let digits = label.split(whereSeparator: { !$0.isNumber }).last else { return -1 }
        return Int(digits) ?? -1
    }

    func field(_ name: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", name, name)).firstMatch
    }

    /// Empty, or showing only its placeholder: the reading left it for the owner.
    func isBlank(_ field: XCUIElement, _ placeholder: String) -> Bool {
        let value = (field.value as? String) ?? ""
        return value.isEmpty || value == placeholder
    }

    // (a) Owner: "a random bubble in the middle". The delete question must be a full-width sheet at
    // the bottom of the screen whose title names the receipt.
    func testA_DeleteConfirmIsBottomSheet() {
        guard openKuitit() else { capture("a0-no-kuitit"); tree("a0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        guard tapLabel("label CONTAINS %@", "ABC Prisma Kotka") else {
            capture("a0-no-row"); XCTFail("seed receipt ABC Prisma Kotka is not listed"); return
        }
        let actions = app.buttons["Toiminnot"].firstMatch
        guard actions.waitForExistence(timeout: 20) else { capture("a0-no-detail"); XCTFail("the receipt did not load"); return }
        capture("a1-receipt-detail")
        // U098 (N3): the body holds the receipt, not a column of actions. Muokkaa was there twice
        // (body and Toiminnot), and "Merkitse ostolaskuksi" and "Käytä tälle myyjälle myöhemmin"
        // were accent rows beside the 3-dot menu. The whole body is looked through: a List keeps
        // the rows below the screen out of the tree.
        let moved = ["Muokkaa", "Merkitse ostolaskuksi", "Käytä tälle myyjälle myöhemmin"]
        var inBody: Set<String> = []
        for look in 0..<5 {
            for label in moved where app.buttons[label].exists { inBody.insert(label) }
            if look < 4 { app.windows.firstMatch.swipeUp(velocity: .slow) }
        }
        for _ in 0..<5 { app.windows.firstMatch.swipeDown(velocity: .slow) }
        keep("a-body-actions", inBody.sorted().joined(separator: ", "))
        XCTAssertTrue(inBody.isEmpty, "the receipt's body still has \(inBody.sorted())")
        actions.tap()
        let delete = app.buttons["Poista kuitti"].firstMatch
        guard delete.waitForExistence(timeout: 5) else { capture("a1-menu"); XCTFail("Toiminnot has no Poista kuitti"); return }
        for label in moved {
            XCTAssertTrue(app.buttons[label].firstMatch.waitForExistence(timeout: 5), "Toiminnot has no \(label)")
        }
        capture("a1-menu")
        delete.tap()

        let sheet = app.descendants(matching: .any).matching(identifier: "confirm-sheet").firstMatch
        guard sheet.waitForExistence(timeout: 5) else { capture("a2-no-sheet"); XCTFail("Poista kuitti did not open the confirm sheet"); return }
        // The sheet slides up: measure it where it stops.
        sleep(1)
        capture("a2-delete-confirm-sheet")

        let title = app.staticTexts["confirm-sheet-title"].firstMatch
        XCTAssertTrue(title.exists, "the sheet has no title")
        XCTAssertTrue(title.label.hasPrefix("Poistetaanko kuitti · "), "title: \(title.label)")
        XCTAssertTrue(title.label.contains("ABC Prisma Kotka"), "the title does not name the receipt: \(title.label)")
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        XCTAssertTrue(confirm.exists, "the sheet has no confirm button")
        XCTAssertEqual(confirm.label, "Poista")

        let window = app.windows.firstMatch.frame
        let frame = sheet.frame
        keep("a-geometry", "window \(window), sheet \(frame), confirm \(confirm.frame)")
        // Content ends above the home indicator; a centred bubble ends far above that.
        XCTAssertGreaterThanOrEqual(frame.maxY, window.maxY - 60, "the sheet ends at \(frame.maxY) of \(window.maxY): not anchored at the bottom")
        XCTAssertGreaterThan(frame.minY, window.height * 0.25, "the sheet starts at \(frame.minY): not a bottom sheet")
        // iOS 26 floats a partial-height system sheet 8 pt in from each edge (CI round 3: 386 of 402,
        // minX 8); a centred alert-style bubble is 270 pt. Full width means edge to edge less that inset.
        XCTAssertLessThanOrEqual(frame.minX, 12, "the sheet starts \(frame.minX) pt from the left edge: a floating bubble")
        XCTAssertGreaterThanOrEqual(frame.maxX, window.maxX - 12, "the sheet ends \(window.maxX - frame.maxX) pt from the right edge: a floating bubble")
        XCTAssertGreaterThanOrEqual(frame.width, window.width - 24, "the sheet is \(frame.width) of \(window.width) wide: a floating bubble")
        XCTAssertGreaterThan(confirm.frame.midY, window.height * 0.6, "Poista is at \(confirm.frame.midY): not where the thumb is")

        // U099: the title names the receipt; the line under it adds the amount and day, not the vendor again.
        let named = sheet.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ABC Prisma Kotka"))
        XCTAssertEqual(named.count, 1, "the sheet names the vendor \(named.count) times: \(sheet.staticTexts.allElementsBoundByIndex.map(\.label))")
        let message = app.staticTexts["confirm-sheet-message"].firstMatch
        if message.exists {
            keep("a-message", message.label)
            XCTAssertTrue(message.label.contains("9,43") && message.label.contains("€"), "the message has no amount: \(message.label)")
            // U008: no blank band between the words and the buttons (about 52 pt while the inset was counted twice).
            let gap = confirm.frame.minY - message.frame.maxY
            keep("a-gap", "\(gap) pt between the message and Poista")
            XCTAssertLessThanOrEqual(gap, 24, "\(gap) pt of empty sheet between the message and Poista")
        } else {
            XCTFail("the sheet has no line under its title")
        }

        app.buttons["confirm-sheet-cancel"].firstMatch.tap()
        XCTAssertTrue(waitGone(sheet, timeout: 5), "Peruuta did not close the sheet")
        XCTAssertTrue(actions.waitForExistence(timeout: 5), "Peruuta left the receipt screen")
        capture("a3-after-peruuta")
    }

    // (d) Kuitit: rows with the file's picture, and "Ei kohdistettu" with the server's non-zero count.
    func testB_KuititRowsThumbnailsAndUnlinkedChip() {
        guard openKuitit() else { capture("b0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "ABC Prisma Kotka")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the seed receipts are not listed")

        // "Pienoiskuva" once a row's picture is on screen, "Ei pienoiskuvaa" while it is the symbol
        // (ReceiptThumbnail under -LKUITest). Case matters: the second never matches the first.
        let pictures = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Pienoiskuva"))
        let thumbnails = app.descendants(matching: .any).matching(identifier: "receipt-thumbnail")
        for _ in 0..<30 where pictures.count < 3 { sleep(1) }
        keep("b-thumbnails", "pictures \(pictures.count), thumbnail views \(thumbnails.count)")
        XCTAssertGreaterThanOrEqual(pictures.count, 3, "the rows show no file pictures (thumbnail views: \(thumbnails.count))")

        let chip = app.buttons["receipt-tab-unlinked"].firstMatch
        guard chip.waitForExistence(timeout: 15) else { capture("b0-no-chip"); XCTFail("no Ei kohdistettu chip"); return }
        var count = Self.lastNumber(chip.label)
        for _ in 0..<20 where count < 0 { sleep(1); count = Self.lastNumber(chip.label) }
        keep("b-unlinked-chip", chip.label)
        XCTAssertTrue(chip.label.hasPrefix("Ei kohdistettu"), "chip label: \(chip.label)")
        XCTAssertGreaterThan(count, 0, "Ei kohdistettu shows \(count): \(chip.label)")
        capture("b1-kuitit-list")
        // U098 (N3): one primary in the bar, the camera; filtering and picking are in Toiminnot.
        let items = barItems(app.navigationBars["Kuitit"])
        keep("b-bar", items.joined(separator: ", "))
        XCTAssertEqual(items.sorted(), ["Kuvaa kuitti", "Toiminnot"], "the Kuitit bar beside Back")

        // The chips scroll sideways; the fifth may sit past the edge.
        revealChip(chip, inRow: "receipt-chips")
        chip.tap()
        sleep(3)
        capture("b2-ei-kohdistettu")
        XCTAssertGreaterThan(thumbnails.count + pictures.count, 0, "Ei kohdistettu (\(count)) lists no rows")
    }

    // (b) the capture form shows the picked file above the fields, (c) "Takaisin" keeps the queue's
    // row, (e) the ostolasku toast after saving a bill where the server can read one.
    func testC_CaptureFormPreviewQueueAndSave() throws {
        guard openKuitit() else { capture("c0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        (camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch).tap()
        let fixture = app.buttons["capture-fixture"].firstMatch
        guard fixture.waitForExistence(timeout: 10) else {
            capture("c0-no-fixture"); XCTFail("no Testikuitti button: is the app a Debug build launched with -LKUITest?"); return
        }
        // A reading kept from an earlier run opens the screen on the queue, with the button lower down.
        if !fixture.isHittable { app.swipeUp(); sleep(1) }
        fixture.tap()
        capture("c1-uploading")

        // Uploaded, read by the server (an empty reading, or CI's reader stub: a bill with no date),
        // then the form opens by itself.
        let preview = app.descendants(matching: .any).matching(identifier: "captured-file-preview").firstMatch
        if !preview.waitForExistence(timeout: 90) {
            let use = app.buttons["Käytä lomakkeessa"].firstMatch
            if use.exists { use.tap(); _ = preview.waitForExistence(timeout: 10) }
        }
        capture("c2-form-with-preview")
        guard preview.exists else { XCTFail("the capture form shows no picture of the file"); return }
        let vendor = field("Myyjä")
        XCTAssertTrue(vendor.waitForExistence(timeout: 5), "the form has no Myyjä field")
        if vendor.exists {
            keep("c-geometry", "preview \(preview.frame), Myyjä \(vendor.frame)")
            XCTAssertLessThan(preview.frame.minY, vendor.frame.minY, "the picture is not above the fields")
        }

        let back = app.buttons["Takaisin"].firstMatch
        guard back.exists else { XCTFail("the form has no Takaisin"); return }
        back.tap()
        sleep(1)
        let discard = app.buttons["Hylkää muutokset"]
        // A tap while the form is still settling (its picture grows in after c2) can be lost on a
        // loaded host: run 38868746775 shot the form still up, nothing asked. Tapped again only then.
        if !discard.exists && !waitGone(vendor, timeout: 4) && !discard.exists && back.exists { back.tap(); sleep(1) }
        // A reading the form changed asks first; nothing was typed, but the answer is the same.
        if discard.exists { discard.tap(); sleep(1) }
        let queued = app.staticTexts["testikuitti.jpg"].firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 5), "Takaisin lost the queue's row")
        let reopen = app.buttons["Käytä lomakkeessa"].firstMatch
        XCTAssertTrue(reopen.exists, "the read row offers no Käytä lomakkeessa after Takaisin")
        XCTAssertTrue(app.navigationBars["Uusi kuitti"].exists, "Takaisin closed the capture screen")
        capture("c3-queue-after-takaisin")
        guard reopen.exists else { return }

        reopen.tap()
        guard vendor.waitForExistence(timeout: 10) else { capture("c4-no-form"); XCTFail("Käytä lomakkeessa did not open the form"); return }
        if isBlank(vendor, "Myyjä") { type(vendor, "Testikauppa Oy") }
        let total = field("Summa €")
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && isBlank(total, "Summa €") { type(total, "12") }
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap(); sleep(1) }
        // Category is required and only the cloud AI suggests one: the owner picks it from the menu.
        let category = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if category.waitForExistence(timeout: 5), category.label.hasSuffix("Valitse") {
            if !category.isHittable { app.swipeUp(); sleep(1) }
            category.tap()
            let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
            if choice.waitForExistence(timeout: 5) { choice.tap() }
            XCTAssertTrue(category.label.hasSuffix("Tarvikkeet & ostot"), "category not chosen: \(category.label)")
        }
        capture("c4-form-filled")
        guard tap("Tallenna kuitti") else { XCTFail("no Tallenna kuitti"); return }

        let toast = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tallennettu · ")).firstMatch
        let screen = app.navigationBars["Uusi kuitti"]
        var outcome = ""
        // The toast lives 5 s (CaptureQueueModel.say): its words and place are read in the same
        // snapshot that finds it. Read again after the screenshot, it had gone on a loaded host
        // ("Failed to get matching snapshot", audit row U089, runs 39081858267 and 39156227591).
        var toastLabel = ""
        var toastFrame = CGRect.zero
        for _ in 0..<30 {
            if let seen = try? toast.snapshot() { outcome = "toast"; toastLabel = seen.label; toastFrame = seen.frame; break }
            if !screen.exists { outcome = "closed"; break }
            sleep(1)
        }
        capture("c5-after-save")
        if outcome.isEmpty { tree("c5-after-save") }
        keep("c-save-outcome", outcome.isEmpty ? "none" : (outcome == "toast" ? toastLabel : outcome))
        XCTAssertFalse(outcome.isEmpty, "Tallenna kuitti neither saved (screen still up, no toast)")
        if outcome == "toast" {
            let window = app.windows.firstMatch.frame
            XCTAssertTrue(toastLabel.contains("lasku"), "toast: \(toastLabel)")
            XCTAssertGreaterThan(toastFrame.minY, window.height * 0.6, "the toast is at \(toastFrame.minY): not at the bottom")
        } else if ProcessInfo.processInfo.environment["LK_READER_STUB"] == "1" {
            // The UI suite's OwnerScreensTests job reads uploads through scripts/sim/reader-stub.py,
            // which calls every file a "lasku": this save had to file an ostolasku and say so.
            XCTFail("the bill was saved but no ostolasku toast came (outcome: \(outcome))")
        } else if (testRun?.totalFailureCount ?? 0) == 0 {
            // The server files a bill as an ostolasku only when the reading says "lasku", and only the
            // cloud AI reads the document type; without it (or the CI stub) a plain receipt is saved.
            throw XCTSkip("(e) ostolasku toast: this demo API has no reader for a bill (CI runs scripts/sim/reader-stub.py); (b) and (c) passed, the save closed the screen")
        }
    }

    // M073: with no mailbox connected, Kirjanpito > Sähköposti's headline ended mid-word in an
    // ellipsis ('Sähköpostia ei ole yhdist…') at the default text size. Owner rule: no cut text.
    // The demo seed connects no mailbox.
    func testD_EmailEmptyStateNotClipped() {
        guard selectTab("Kirjanpito") else { capture("m0-no-tab"); XCTFail("Kirjanpito did not open"); return }
        let screen = app.navigationBars["Sähköposti"]
        for _ in 0..<2 where !screen.exists {
            tapLabel("label BEGINSWITH %@", "Sähköposti")
            _ = screen.waitForExistence(timeout: 10)
        }
        guard screen.exists else { capture("m0-no-email"); tree("m0-no-email"); XCTFail("Sähköposti did not open"); return }
        // A text of its own or the start of the empty state's combined label, by iOS version.
        let title = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Sähköpostia ei ole yhdistetty")).firstMatch
        guard title.waitForExistence(timeout: 15) else {
            capture("m1-no-empty-state"); tree("m1-no-empty-state"); XCTFail("no 'Sähköpostia ei ole yhdistetty': has the demo user a mailbox?"); return
        }
        waitStill(title)
        capture("m1-email-empty-state")
        keep("m-title", "\(title.frame)")
        // The node is the icon (~40 pt) and the title. Ending in "…" the title kept to one line
        // (~90 pt in all); wrapped whole it takes two (121 pt in run 39207976615). The .textClipped
        // audit cannot tell them apart: it flags every text of this view as "may be clipped at
        // larger Dynamic Type sizes", the wrapped title included.
        XCTAssertGreaterThanOrEqual(title.frame.height, 100, "the empty-state title is on one line: \(title.frame)")
    }

    // W39 (OPEN-ISSUES 16): a photo kept on the phone to be sent later showed only on Kuitit's card,
    // under the capture cover. Saved to the queue from inside "Lisää kuitti", it must show there,
    // whether it is still waiting, being sent, refused or already sent when the test looks.
    // Last in the class: the photo goes to the demo API's inbox.
    func testD_QueuedPhotoShowsInsideCapture() {
        guard openKuitit() else { capture("d0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        (camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch).tap()
        let fixture = app.buttons["capture-queue-fixture"].firstMatch
        guard fixture.waitForExistence(timeout: 10) else {
            capture("d0-no-fixture"); XCTFail("no Testikuitti jonoon button: is the app a Debug build launched with -LKUITest?"); return
        }
        if !fixture.isHittable { app.swipeUp(); sleep(1) }
        fixture.tap()

        let status = app.descendants(matching: .any).matching(identifier: "capture-queued-status").firstMatch
        let shown = status.waitForExistence(timeout: 10)
        capture("d1-queued-inside-capture")
        guard shown else { tree("d1-queued-inside-capture"); XCTFail("the queued photo is not shown inside the capture screen"); return }
        XCTAssertTrue(app.navigationBars["Uusi kuitti"].exists, "the capture screen is no longer up")
        let line = status.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ OR label CONTAINS %@", "Jonossa 1 kuitti", "lähetetty")).firstMatch
        keep("d-status", status.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " | "))
        XCTAssertTrue(line.exists, "the block inside the capture screen does not name the queued photo")
        if !app.windows.firstMatch.frame.contains(status.frame) { app.swipeUp(); sleep(1) }
        XCTAssertTrue(!status.frame.isEmpty && app.windows.firstMatch.frame.contains(status.frame),
                      "the block is not on screen: \(status.frame)")
    }

    // Row 6 (w34's note): "+" → "Uusi myyntilasku" flashed. The form appeared without its line and its
    // bottom bar, and they came in one frame later from its load. It must open finished: the app
    // records, in its first appearance, whether the line and the baseline were already there.
    func testE_NewInvoiceFromAddOpensFinished() {
        // As an owner would: a moment on Koti, while the warm after Koti fetches what the form opens on
        // (NextPrefetch.afterKoti: customers and catalog).
        sleep(6)
        app.tabBars.buttons["Lisää"].firstMatch.tap()
        let new = app.buttons["Uusi myyntilasku"].firstMatch
        guard new.waitForExistence(timeout: 10) else { capture("e0-no-add-sheet"); XCTFail("Lisää did not open"); return }
        new.tap()
        let opening = app.descendants(matching: .any).matching(identifier: "invoice-form-opening").firstMatch
        guard opening.waitForExistence(timeout: 15) else {
            capture("e1-no-form"); tree("e1-no-form"); XCTFail("Uusi myyntilasku did not open the form"); return
        }
        capture("e1-new-invoice")
        XCTAssertEqual(opening.label, "valmis", "the form's first frame had no line: it came in a frame later (the flash)")
        XCTAssertTrue(app.navigationBars["Uusi lasku"].exists, "the sheet is not the new invoice")
        XCTAssertTrue(app.buttons["Luo lasku"].firstMatch.isEnabled, "Luo lasku is still waiting for the form's load")
        app.buttons["Peruuta"].firstMatch.tap()
    }

    // U008: the sign-out question is as tall as its words. With nothing waiting it is the title alone,
    // with no blank band above the buttons. The question with a photo waiting is P3Tests.testC: this
    // class also runs straight against the demo API (ios-native.yml), with no proxy to go offline, so
    // a queued photo would be sent before the question opens.
    func testA1_SignOutConfirmFitsItsText() {
        guard let sheet = openSignOutQuestion() else { capture("f0-no-question"); tree("f0-no-question"); XCTFail("Asetukset > Kirjaudu ulos did not ask"); return }
        capture("f1-signout-nothing-waiting")
        let title = app.staticTexts["confirm-sheet-title"].firstMatch
        let message = app.staticTexts["confirm-sheet-message"].firstMatch
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        XCTAssertEqual(title.label, "Kirjaudutaanko ulos?")
        // A reading left unsaved, or a photo the inbox refused, would count here: named A1 so it runs
        // before testC's reading and testD's photo exist.
        XCTAssertFalse(message.exists, "nothing should wait, yet the question has a line (left by an earlier test?): \(message.exists ? message.label : "")")
        let gap = confirm.frame.minY - title.frame.maxY
        keep("f-gap", "\(gap) pt between the title and \(confirm.label); sheet \(sheet.frame)")
        XCTAssertLessThanOrEqual(gap, 24, "\(gap) pt of empty sheet between the title and the buttons")
        app.buttons["confirm-sheet-cancel"].firstMatch.tap()
        XCTAssertTrue(waitGone(sheet, timeout: 5), "Peruuta did not close the question")
        XCTAssertTrue(app.navigationBars["Asetukset"].exists, "Peruuta left Asetukset: the session ended")
    }

    // X166: an ostolasku's category was free text and its detail showed the stored code. Typing the
    // label an owner knows ("Tarvikkeet & ostot") booked the cost to Muut kulut, because the ledger
    // maps the code alone. The detail must show the label, and the form must pick the code.
    func testH_PurchaseCategoryPicker() {
        guard selectTab("Kirjanpito") else { capture("h0-no-tab"); XCTFail("Kirjanpito did not open"); return }
        let list = app.navigationBars["Ostolaskut"]
        for _ in 0..<2 where !list.exists {
            tapLabel("label BEGINSWITH %@", "Ostolaskut")
            _ = list.waitForExistence(timeout: 10)
        }
        guard list.exists else { capture("h0-no-ostolaskut"); tree("h0-no-ostolaskut"); XCTFail("Ostolaskut did not open"); return }

        // The seed's bill (demo-seed.ts) is stored with the code "tarvikkeet".
        guard tapLabel("label CONTAINS %@", "Ripsitukku Oy") else {
            capture("h0-no-row"); XCTFail("seed ostolasku Ripsitukku Oy is not listed"); return
        }
        guard app.navigationBars["Ripsitukku Oy"].waitForExistence(timeout: 20) else {
            capture("h1-no-detail"); tree("h1-no-detail"); XCTFail("the Ripsitukku Oy ostolasku did not load"); return
        }
        // A LabeledContent row reads as its two texts or as one "Kategoria, …" element, by iOS version.
        let rowPredicate = "label == %@ OR value == %@ OR label ENDSWITH %@"
        let label = app.descendants(matching: .any)
            .matching(NSPredicate(format: rowPredicate, "Tarvikkeet & ostot", "Tarvikkeet & ostot", ", Tarvikkeet & ostot")).firstMatch
        let code = app.descendants(matching: .any)
            .matching(NSPredicate(format: rowPredicate, "tarvikkeet", "tarvikkeet", ", tarvikkeet")).firstMatch
        if !label.waitForExistence(timeout: 10) && !code.exists { app.swipeUp(); _ = label.waitForExistence(timeout: 5) }
        capture("h1-detail")
        if !label.exists { tree("h1-detail") }
        XCTAssertTrue(label.exists, "the detail's Kategoria does not read Tarvikkeet & ostot")
        XCTAssertFalse(code.exists, "the detail shows the stored code: \(code.exists ? code.label : "")")

        edgeSwipeBack()
        if !list.waitForExistence(timeout: 5) { app.navigationBars["Ripsitukku Oy"].buttons.firstMatch.tap() }
        let new = app.buttons["Uusi ostolasku"].firstMatch
        guard list.waitForExistence(timeout: 5), new.waitForExistence(timeout: 10) else {
            capture("h2-no-list"); XCTFail("back on Ostolaskut, no Uusi ostolasku"); return
        }
        new.tap()
        let sheet = app.navigationBars["Uusi ostolasku"]
        guard sheet.waitForExistence(timeout: 10) else { capture("h2-no-form"); XCTFail("Uusi ostolasku did not open"); return }

        // Digits only: autocorrect may change a word, and the read-back below finds the bill by them.
        let token = String(Int.random(in: 100_000...999_999))
        // Under the section header "Toimittaja" the field exposes its prompt, "Tukku Oy", not a label
        // (PurchaseInvoiceForms.swift:36; run 39164754863 found no field labelled Toimittaja).
        let supplier = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Tukku Oy", "Toimittaja")).firstMatch
        guard supplier.waitForExistence(timeout: 5) else { capture("h2-no-supplier"); tree("h2-no-supplier"); XCTFail("the form has no Toimittaja field"); return }
        type(supplier, "Testitukku \(token)")
        let gross = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label BEGINSWITH %@", "124,00", "Summa")).firstMatch
        guard gross.waitForExistence(timeout: 5) else { capture("h2-no-gross"); tree("h2-no-gross"); XCTFail("the form has no Summa field"); return }
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        type(gross, "12")
        let keyboardDone = app.buttons["Valmis"].firstMatch
        if keyboardDone.exists { keyboardDone.tap() }

        // A menu picker is a button (a pop-up button on some iOS versions); the old row was a text field.
        let pickerTypes = [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.popUpButton.rawValue]
        let category = app.descendants(matching: .any)
            .matching(NSPredicate(format: "elementType IN %@ AND label BEGINSWITH %@", argumentArray: [pickerTypes, "Kategoria"])).firstMatch
        if !category.waitForExistence(timeout: 5) { app.swipeUp(); _ = category.waitForExistence(timeout: 5) }
        capture("h2-new-form")
        guard category.exists else { tree("h2-new-form"); XCTFail("Kategoria in Uusi ostolasku is not a menu picker"); return }
        if !category.isHittable { app.swipeUp(); _ = category.waitForExistence(timeout: 2) }
        category.tap()
        let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
        guard choice.waitForExistence(timeout: 5) else { capture("h3-no-menu"); tree("h3-no-menu"); XCTFail("the Kategoria menu has no Tarvikkeet & ostot"); return }
        choice.tap()
        func shown() -> String { "\(category.label) \((category.value as? String) ?? "")" }
        for _ in 0..<10 where !shown().contains("Tarvikkeet & ostot") { usleep(500_000) }
        capture("h3-category-picked")
        XCTAssertTrue(shown().contains("Tarvikkeet & ostot"), "the picker does not show the choice: \(shown())")

        let add = sheet.buttons["Lisää"]
        guard add.exists else { tree("h3-no-add"); XCTFail("the form has no Lisää"); return }
        add.tap()
        let closed = waitGone(sheet, timeout: 20)
        capture("h4-after-save")
        guard closed else { tree("h4-after-save"); XCTFail("Lisää did not save the ostolasku"); return }

        // Read back from the demo API the app uses (the runner shares the Mac's loopback). Test values
        // from app/scripts/demo-seed.ts; only ever against the throwaway demo API.
        func call(_ path: String, _ body: [String: String]?, _ bearer: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            if let body {
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
            var result: [String: Any]?
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, _, _ in
                result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 30)
            return result
        }
        guard let bearer = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String else {
            XCTFail("the demo API gave no token"); return
        }
        var saved: [String: Any]?
        for _ in 0..<10 where saved == nil {
            let invoices = call("/api/purchase-invoices", nil, bearer)?["invoices"] as? [[String: Any]] ?? []
            saved = invoices.first { ($0["supplierName"] as? String)?.contains(token) == true }
            if saved == nil { sleep(1) }
        }
        keep("h-saved", saved.map { "\(($0["supplierName"] as? String) ?? "") · \(($0["category"] as? String) ?? "nil")" } ?? "not found")
        guard let found = saved else { XCTFail("the demo API lists no ostolasku for Testitukku \(token)"); return }
        XCTAssertEqual(found["category"] as? String, "tarvikkeet", "the picked category was not stored as its code")
    }

    // X007 X109 X114 X125 X155: Koti's first task row cut the seed's long vendor name to 'Audit
    // Hyvitys Odottaa…' while the amount column left room. The name reads whole, on at most two
    // lines, and its amount and Hyväksy stay whole. Measured, not audited: the .textClipped audit
    // flags text that wraps whole too (B2, run 39207976615).
    func testI_KotiTaskNameNotClipped() {
        guard selectTab("Koti") else { capture("i0-no-tab"); XCTFail("Koti did not open"); return }
        let name = "Audit Hyvitys Odottaa Oy"
        let party = app.staticTexts[name].firstMatch
        guard party.waitForExistence(timeout: 20) else {
            capture("i0-no-row"); tree("i0-no-row"); XCTFail("Koti lists no task for \(name)"); return
        }
        waitStill(party)
        capture("i1-koti-tasks")
        // The row's body text, at the size the simulator is set to (the runner shares it).
        let font = UIFont.preferredFont(forTextStyle: .body)
        let whole = ceil((name as NSString).size(withAttributes: [.font: font]).width)
        let lines = Int((party.frame.height / font.lineHeight).rounded())
        keep("i-party", "\(party.frame), whole name \(whole) pt, one line \(font.lineHeight) pt")
        // As wide as the whole name on one line, or wrapped onto a second: either way nothing is cut.
        XCTAssertTrue(party.frame.width >= whole - 2 || lines == 2,
                      "the name is cut: \(party.frame.width) of \(whole) pt on \(lines) line(s)")
        XCTAssertLessThanOrEqual(lines, 2, "the name takes \(lines) lines")

        // Not at the cost of the amount and the pill beside it: given the row first, the name and its
        // long subtitle once left them about 32 pt, which cut both to an ellipsis.
        let figure = "18,90\u{00A0}€"
        let amounts = app.staticTexts.matching(NSPredicate(format: "label == %@", figure)).allElementsBoundByIndex
        let pill = app.buttons["Hyväksy: \(name)"].firstMatch
        guard let amount = amounts.first(where: { abs($0.frame.midY - party.frame.midY) < 40 }), pill.exists else {
            tree("i1-no-trailing"); XCTFail("the row shows no \(figure) or no Hyväksy"); return
        }
        // MoneyText's digits are monospaced; the pill's text has TaskRow.pillLabel's 12 pt on each side.
        let amountFont = UIFont.monospacedDigitSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .subheadline).pointSize,
                                                          weight: .semibold)
        let pillFont = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .bold)
        let amountWhole = ceil((figure as NSString).size(withAttributes: [.font: amountFont]).width)
        let pillWhole = ceil(("Hyväksy" as NSString).size(withAttributes: [.font: pillFont]).width) + 24
        keep("i-trailing", "amount \(amount.frame), whole \(amountWhole) pt; pill \(pill.frame), whole \(pillWhole) pt")
        XCTAssertGreaterThanOrEqual(amount.frame.width, amountWhole - 2, "the amount is cut: \(amount.frame.width) of \(amountWhole) pt")
        XCTAssertGreaterThanOrEqual(pill.frame.width, pillWhole - 2, "the Hyväksy pill is cut: \(pill.frame.width) of \(pillWhole) pt")
    }

    // X072: a credit note was asked 'Onko tämä lasku, joka maksetaan myöhemmin?' with 'Merkitse
    // ostolaskuksi'. The seed's approved credit note 'Audit Hyvitys Oy' (−50,00 €) is offered as an
    // ostolasku's credit instead.
    func testJ_CreditNoteIsNotABillPaidLater() {
        guard openKuitit() else { capture("j0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        // Kuitit shows ten rows before "Näytä enemmän". The credit note shares its day with the seed's
        // Lidl 3, and the server orders one day's rows by id, a random uuid: with nine rows newer than
        // that day it is the tenth row or the eleventh, behind the fold (run 39382398509). The owner
        // opens the fold, and so does the walk.
        var found = tapLabel("label CONTAINS %@", "Audit Hyvitys Oy,")
        for _ in 0..<2 where !found {
            guard tapLabel("label BEGINSWITH %@", "Näytä enemmän") else { break }
            found = tapLabel("label CONTAINS %@", "Audit Hyvitys Oy,")
        }
        guard found else { capture("j0-no-row"); XCTFail("Kuitit lists no Audit Hyvitys Oy"); return }
        let offer = app.staticTexts["Onko tämä ostolaskun hyvitys?"].firstMatch
        let bill = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "maksetaan myöhemmin")).firstMatch
        // The notice comes with its own request, after the receipt.
        let deadline = Date().addingTimeInterval(20)
        while !offer.exists && !bill.exists && Date() < deadline { usleep(250_000) }
        capture("j1-credit-note")
        if !offer.exists { tree("j1-credit-note") }
        XCTAssertFalse(bill.exists, "the credit note is asked whether it is a bill paid later")
        XCTAssertTrue(offer.exists, "the credit note is not offered as an ostolasku's credit")
        XCTAssertTrue(app.buttons["Merkitse ostolaskun hyvitykseksi"].exists, "no 'Merkitse ostolaskun hyvitykseksi'")
    }

    // X165 X164 X133 X134 X162 X168, on the seed's overdue Ripsitukku Oy bill: its list row says
    // "Myöhässä" once and carries the year; the open bill has one next step at the bottom, 'Kohdista
    // pankkiin', two taps from Ostolaskut, and everything else in Toiminnot; the bank picker does not
    // explain a row by its date alone; and Kohdista ostolaskujen maksut offers "Hyväksy kaikki
    // varmat" only when a sure pair waits.
    func testJ_PurchaseDetailOnePrimary() {
        // What the server holds decides the picker's footer and the bulk button. Each receipt save
        // (testC's) runs the matcher, which links the seed's Ripsitukku Oy bank row (−139,00 €) to its
        // kuitti: the bill then has only date-only rows and no sure pair. On a fresh seed that row is
        // still free, matches the bill, and both answers flip.
        guard let bearer = demoAPI("/api/auth/token", body: ["email": "demo@lashkirja.fi", "password": "demo123"])?["token"] as? String else {
            XCTFail("the demo API gave no token"); return
        }
        let bills = demoAPI("/api/purchase-invoices", bearer: bearer)?["invoices"] as? [[String: Any]] ?? []
        guard let bill = bills.first(where: { $0["supplierName"] as? String == "Ripsitukku Oy" }),
              let billId = bill["id"] as? String, let due = bill["dueDate"] as? String else {
            XCTFail("the demo API lists no Ripsitukku Oy ostolasku"); return
        }
        XCTAssertEqual(bill["displayStatus"] as? String, "overdue", "the seed's Ripsitukku Oy bill is not overdue")
        let dueParts = due.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard dueParts.count == 3 else { XCTFail("Ripsitukku Oy's due date reads \(due)"); return }
        let dueShown = "\(dueParts[2]).\(dueParts[1]).\(dueParts[0])"
        let candidates = demoAPI("/api/purchase-invoices/\(billId)/payments/candidates", bearer: bearer)?["candidates"] as? [[String: Any]] ?? []
        let anyMatch = candidates.contains { (($0["score"] as? Double) ?? 0) > 0 }
        let suggestions = demoAPI("/api/purchase-invoices/match", bearer: bearer)?["suggestions"] as? [[String: Any]] ?? []
        // As PurchaseMatch.sureSuggestions: sure, and carrying what a payment needs.
        let sure = suggestions.filter { suggestion in
            let score: Double = (suggestion["score"] as? Double) ?? 0
            let amount: Double = (suggestion["amount"] as? Double) ?? 0
            return score >= 0.8 && amount > 0 && suggestion["transactionId"] as? String != nil && suggestion["paidDate"] as? String != nil
        }.count
        keep("j-server", "Ripsitukku Oy due \(dueShown): \(candidates.count) bank rows, one scored: \(anyMatch); sure pairs: \(sure)")

        guard selectTab("Kirjanpito") else { capture("j0-no-tab"); XCTFail("Kirjanpito did not open"); return }
        let list = app.navigationBars["Ostolaskut"]
        for _ in 0..<2 where !list.exists {
            tapLabel("label BEGINSWITH %@", "Ostolaskut")
            _ = list.waitForExistence(timeout: 10)
        }
        guard list.exists else { capture("j0-no-ostolaskut"); tree("j0-no-ostolaskut"); XCTFail("Ostolaskut did not open"); return }

        // The row reads as one element: name, second line, amount and badge.
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Ripsitukku Oy", "139,00")).firstMatch
        guard row.waitForExistence(timeout: 20), reveal(row) else {
            capture("j1-no-row"); tree("j1-no-row"); XCTFail("Ostolaskut lists no Ripsitukku Oy row"); return
        }
        let rowLabel = row.label
        keep("j-row", rowLabel)
        capture("j1-ostolaskut")
        let overdueWords = rowLabel.lowercased().components(separatedBy: "myöhässä").count - 1
        XCTAssertEqual(overdueWords, 1, "the row says Myöhässä \(overdueWords) times: \(rowLabel)")
        XCTAssertTrue(rowLabel.contains(dueShown), "the row's due date is not \(dueShown), with its year: \(rowLabel)")

        // Ostolaskut row → the primary: two taps, no scroll.
        taps = 0
        scrolls = 0
        row.tap(); taps += 1
        guard app.navigationBars["Ripsitukku Oy"].waitForExistence(timeout: 20) else {
            capture("j2-no-detail"); tree("j2-no-detail"); XCTFail("the Ripsitukku Oy ostolasku did not open"); return
        }
        let primary = app.buttons["ostolasku-primary"]
        guard primary.waitForExistence(timeout: 20) else {
            capture("j2-no-primary"); tree("j2-no-primary"); XCTFail("the open bill has no primary at the bottom"); return
        }
        capture("j2-detail")
        XCTAssertEqual(primary.label, "Kohdista pankkiin")
        XCTAssertTrue(primary.isHittable, "Kohdista pankkiin is not hittable without a scroll")
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists {
            XCTAssertLessThanOrEqual(primary.frame.maxY, tabBar.frame.minY + 1, "Kohdista pankkiin \(primary.frame) is under the tab bar \(tabBar.frame)")
        }
        let paymentActions = app.buttons.matching(NSPredicate(format: "label IN %@", ["Kohdista pankkiin", "Kohdista pankkitapahtumaan", "Kirjaa maksu"]))
        XCTAssertEqual(paymentActions.count, 1, "the body shows \(paymentActions.count) payment actions")
        primary.tap(); taps += 1
        let picker = app.navigationBars["Kohdista pankkiin"]
        let opened = picker.waitForExistence(timeout: 10)
        measure("ostolasku-kohdista-pankkiin", reached: opened, maxTaps: 2, maxScrolls: 0)
        guard opened else { capture("j3-no-picker"); tree("j3-no-picker"); return }

        // Only a row that shares the amount, the viite or the name says why; and when none does,
        // the footer says so instead of calling the top rows the best matches.
        let rowsHeader = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Pankkitapahtumat")).firstMatch
        _ = rowsHeader.waitForExistence(timeout: 20)
        capture("j3-picker")
        if rowsHeader.exists {
            let dateOnly = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Miksi: maksettu"))
            let dateOnlyCount = dateOnly.count
            XCTAssertEqual(dateOnlyCount, 0, "a row is explained by its date alone: \(dateOnlyCount > 0 ? dateOnly.firstMatch.label : "")")
            let noMatch = app.staticTexts["Mikään tapahtuma ei vastaa summaa, viitettä tai nimeä. Hae nimellä tai summalla."]
            let best = app.staticTexts["Valitse pankkitapahtuma, jolla tämä ostolasku maksettiin. Parhaat osumat ovat ylimpänä."]
            if anyMatch {
                XCTAssertTrue(best.waitForExistence(timeout: 5), "a row matches the bill, but the footer does not say the best are on top")
            } else {
                XCTAssertTrue(noMatch.waitForExistence(timeout: 5), "no row matches the bill, but the footer does not say so")
                XCTAssertFalse(best.exists, "no row matches the bill, yet the footer calls the top rows the best matches")
            }
        } else {
            tree("j3-picker"); XCTFail("Kohdista pankkiin listed no bank rows")
        }
        picker.buttons["Sulje"].tap()
        XCTAssertTrue(waitGone(picker, timeout: 10), "Sulje did not close Kohdista pankkiin")

        // The bill to its last section: no second payment action, no inline delete.
        for _ in 0..<3 { app.windows.firstMatch.swipeUp(velocity: .fast) }
        capture("j4-detail-end")
        XCTAssertEqual(paymentActions.count, 1, "scrolled to the end, the body shows \(paymentActions.count) payment actions")
        XCTAssertFalse(app.buttons["Poista ostolasku"].exists, "the body repeats Poista ostolasku")

        let menu = app.navigationBars["Ripsitukku Oy"].buttons["Toiminnot"]
        guard menu.waitForExistence(timeout: 5) else { capture("j5-no-menu"); tree("j5-no-menu"); XCTFail("no Toiminnot"); return }
        menu.tap()
        let menuLink = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Kohdista pankkiin", "ostolasku-primary")).firstMatch
        let menuPay = app.buttons["Kirjaa maksu"].firstMatch
        guard menuLink.waitForExistence(timeout: 5) else {
            capture("j5-toiminnot"); tree("j5-toiminnot"); XCTFail("Toiminnot has no Kohdista pankkiin"); return
        }
        capture("j5-toiminnot")
        XCTAssertTrue(menuPay.exists, "Toiminnot has no Kirjaa maksu")
        XCTAssertTrue(app.buttons["Poista ostolasku"].exists, "Toiminnot has no Poista ostolasku")
        // X164: on one line, not hyphenated onto a second. The item's own text when iOS exposes it,
        // otherwise the whole item against Kirjaa maksu, a one-line item of the same menu.
        let line = UIFont.preferredFont(forTextStyle: .body).lineHeight
        let text = menuLink.staticTexts.firstMatch
        keep("j-menu", "Kohdista pankkiin \(menuLink.frame), text \(text.exists ? "\(text.frame)" : "none"); Kirjaa maksu \(menuPay.frame); line \(line) pt")
        if text.exists {
            XCTAssertLessThanOrEqual(text.frame.height, 1.5 * line, "the item wraps: \(text.frame.height) pt for a \(line) pt line")
        } else {
            XCTAssertLessThanOrEqual(menuLink.frame.height, menuPay.frame.height + 0.5 * line,
                                     "the item wraps: \(menuLink.frame.height) pt beside Kirjaa maksu's \(menuPay.frame.height) pt")
        }
        menuLink.tap()
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "Toiminnot > Kohdista pankkiin opened no sheet of that title")
        capture("j6-menu-picker")
        if picker.exists {
            picker.buttons["Sulje"].tap()
            _ = waitGone(picker, timeout: 10)
        }

        // Back to Kirjanpito, then the matching screen: Ostolaskut sits above it in the hub.
        edgeSwipeBack()
        if !list.waitForExistence(timeout: 5) { app.navigationBars["Ripsitukku Oy"].buttons.firstMatch.tap() }
        edgeSwipeBack()
        let hub = app.navigationBars["Kirjanpito"]
        if !hub.waitForExistence(timeout: 5) && list.exists { list.buttons.firstMatch.tap() }
        guard hub.waitForExistence(timeout: 5) else { capture("j7-no-hub"); tree("j7-no-hub"); XCTFail("back on Kirjanpito failed"); return }
        let matching = app.navigationBars["Kohdista ostolaskujen maksut"]
        guard tapLabel("label BEGINSWITH %@", "Kohdista ostolaskujen maksut"), matching.waitForExistence(timeout: 10) else {
            capture("j7-no-matching"); tree("j7-no-matching"); XCTFail("Kohdista ostolaskujen maksut did not open"); return
        }
        // The footer line stays when the button goes; it is there once the open bills have loaded.
        let footer = app.staticTexts["Pankin maksut avoimille ostolaskuille."]
        let footerShown = footer.waitForExistence(timeout: 20)
        capture("j7-matching")
        if !footerShown { tree("j7-matching") }
        XCTAssertTrue(footerShown, "Kohdista ostolaskujen maksut shows no 'Pankin maksut avoimille ostolaskuille.'")
        let bulk = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Hyväksy kaikki varmat")).firstMatch
        if sure == 0 {
            XCTAssertFalse(bulk.exists, "no sure pair, yet the screen offers \(bulk.exists ? bulk.label : "")")
        } else {
            XCTAssertTrue(app.buttons["Hyväksy kaikki varmat (\(sure))"].exists, "\(sure) sure pair(s), but no Hyväksy kaikki varmat (\(sure))")
        }
    }

    /// One answer from the demo API the app uses (the runner shares the Mac's loopback), as testH
    /// reads back its save. Test values from app/scripts/demo-seed.ts; only ever the throwaway demo API.
    private func demoAPI(_ path: String, bearer: String? = nil, body: [String: String]? = nil) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
        var result: [String: Any]?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 30)
        return result
    }
}
