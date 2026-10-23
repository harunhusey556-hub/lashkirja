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
        // As WalkTestCase.setUp (U027 U104): the flag stands for the one-time notification question,
        // which the monitor above answers only once a later query runs into it. First, so no
        // value-less flag before it can be read as taking the key for its value.
        app.launchArguments += ["-notifications.asked.v1", "YES"]
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
    /// runs (CI, scripts/sim/run-ui.sh), a PNG in the shot directory. The host's picture is asked for
    /// first: asked after the in-process one, it came 1.2–4.4 s after the step, and c5's showed the
    /// toast already gone (audit row U094). How long the host took is noted and kept in `shotLag`.
    func capture(_ name: String) {
        let asked = Date()
        let png = requestShot("owner-" + name)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let lag = awaitShot(png, since: asked) {
            shotLag[name] = lag
            note("shot \(name) lag \(lag)")
        }
    }

    /// Milliseconds from a step's `capture` to the host's PNG, by step name; none without a watcher.
    var shotLag: [String: Int] = [:]

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
    // row, (e) the ostolasku toast after saving a bill where the server can read one. N4 (owner,
    // 2026-10-18, O1): the form's save in reach, labels that stay, and after the save a queue with one
    // action, quiet row words and nothing that moves.
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
        // X051: the row while its file is read, and the primary under it, before any outcome is in.
        // Only a queue of this one file: a row kept from an earlier run would be measured instead.
        // The read is quick (w64's c1 shot already showed the form), so each frame is one snapshot: a
        // row gone to the form leaves nothing measured instead of a failed query. The row is taken
        // after the primary; with no "Käytä lomakkeessa" yet (a read row has it), it was still being
        // read when the primary was.
        let rows = app.cells.containing(queueRow)
        func isRead(_ element: XCUIElementSnapshot) -> Bool {
            (element.elementType == .button && element.label == "Käytä lomakkeessa") || element.children.contains { isRead($0) }
        }
        var reading: (row: CGRect, primary: CGRect)?
        if rows.firstMatch.waitForExistence(timeout: 5), queuePrimary.waitForExistence(timeout: 2), rows.count == 1,
           let primary = try? queuePrimary.snapshot(), let row = try? rows.firstMatch.snapshot(), !isRead(row) {
            reading = (row.frame, primary.frame)
        }
        keep("c-reading-geometry", reading.map { "row \($0.row), primary \($0.primary)" } ?? "not measured: \(rows.count) rows")
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
        // M009: the form's one action is in reach on its first screen, with no scroll.
        let save = app.buttons["Tallenna kuitti"].firstMatch
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(save.waitForExistence(timeout: 5) && save.isHittable, "Tallenna kuitti is not on the form's first screen")
        if save.exists {
            keep("c-save-geometry", "Tallenna kuitti \(save.frame), window \(window)")
            XCTAssertLessThanOrEqual(save.frame.maxY, window.maxY - 20, "Tallenna kuitti ends at \(save.frame.maxY) of \(window.maxY)")
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
        // U097: the read row says what it waits for, once; "Valmis" is only the button that closes.
        let waiting = app.staticTexts.matching(NSPredicate(format: "label == %@", "Odottaa tarkistusta"))
        keep("c-read-row", "Valmis texts \(app.staticTexts.matching(NSPredicate(format: "label == %@", "Valmis")).count), Odottaa tarkistusta \(waiting.count)")
        XCTAssertFalse(app.staticTexts["Valmis"].exists, "the read row still says Valmis beside the Valmis button")
        XCTAssertEqual(waiting.count, 1, "'Odottaa tarkistusta' is said \(waiting.count) times on a queue of one read file")
        // The read row's action stands on its second line: the row is as tall as the saved row c5
        // measures, and "Valmis" stays where it is through the save (motion gate 39374914516: on a
        // line of its own it made the row 18 pt taller). Only a queue of this one file, as above.
        var read: (row: CGRect, primary: CGRect)?
        let readRow = rows.firstMatch
        if readRow.exists { waitStill(readRow) }
        if rows.count == 1, readRow.exists, queuePrimary.exists { read = (readRow.frame, queuePrimary.frame) }
        keep("c-read-geometry", read.map { "row \($0.row), primary \($0.primary)" } ?? "not measured: \(rows.count) rows")
        guard reopen.exists else { return }

        reopen.tap()
        guard vendor.waitForExistence(timeout: 10) else { capture("c4-no-form"); XCTFail("Käytä lomakkeessa did not open the form"); return }
        // While a field is typed into, the keyboard's own "Valmis" bar is the only bar over it: the
        // pinned save stood there too, over the amount row (iOS native 39285936564 tapped the save).
        let focused = NSPredicate(format: "hasKeyboardFocus == true")
        for _ in 0..<5 {
            vendor.tap()
            if XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: focused, object: vendor)], timeout: 2) == .completed { break }
        }
        if isBlank(vendor, "Myyjä") { vendor.typeText("Testikauppa Oy") }
        let keyboardDone = app.buttons["Valmis"].firstMatch
        if keyboardDone.waitForExistence(timeout: 3) {
            XCTAssertTrue(save.waitForNonExistence(timeout: 3), "Tallenna kuitti stands over the keyboard while Myyjä is typed into")
            keyboardDone.tap()
        }
        XCTAssertTrue(save.waitForExistence(timeout: 5), "Tallenna kuitti did not come back after Valmis")
        // "Summa" beside the field, "0,00" in it while empty; the field is named "Summa euroina".
        let total = app.textFields.matching(NSPredicate(format: "label BEGINSWITH %@ OR placeholderValue == %@", "Summa", "0,00")).firstMatch
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && isBlank(total, "0,00") {
            XCTAssertTrue(clearOfSave(total, save), "the amount stays under Tallenna kuitti at \(total.frame)")
            type(total, "12")
        }
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap(); sleep(1) }
        // U095: the filled rows keep their names (they read "Testikauppa Oy" and "12,40" alone).
        XCTAssertTrue(onTop("label == %@", "Myyjä"), "the filled vendor row has no Myyjä label")
        XCTAssertTrue(onTop("label BEGINSWITH %@", "Summa"), "the filled amount row has no Summa label")
        // Category is required and only the cloud AI suggests one: the owner picks it from the menu.
        let category = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if category.waitForExistence(timeout: 5), category.label.hasSuffix("Valitse") {
            // A save without one says so where the category is, and brings it into view: on the
            // first screen the field and its error sit under the pinned save, and the tap changed
            // nothing in sight (UI suite 39285931841).
            save.tap()
            let missing = app.staticTexts["Valitse kategoria."].firstMatch
            XCTAssertTrue(missing.waitForExistence(timeout: 5), "a save without a category said nothing")
            var inView = false
            for _ in 0..<20 where !inView {
                inView = missing.exists && missing.frame.minY > 100 && missing.frame.maxY <= save.frame.minY
                if !inView { usleep(250_000) }
            }
            XCTAssertTrue(inView, "'Valitse kategoria.' stays out of sight at \(missing.frame), Tallenna kuitti at \(save.frame)")
            capture("c4-category-missing")
            XCTAssertTrue(clearOfSave(category, save), "Kategoria stays under Tallenna kuitti at \(category.frame)")
            category.tap()
            let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
            if choice.waitForExistence(timeout: 5) { choice.tap() }
            XCTAssertTrue(category.label.hasSuffix("Tarvikkeet & ostot"), "category not chosen: \(category.label)")
        }
        // M009: "Kategoria" once, on the picker; a section header over it said it a second time.
        assertKategoriaOnce("the capture form")
        capture("c4-form-filled")
        // Pinned under the form: tapped where it is (`tap` scrolls for anything near the bottom edge).
        guard save.waitForExistence(timeout: 5) else { XCTFail("no Tallenna kuitti"); return }
        save.tap()

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
        // U094: the host's picture is asked for at the step, before the in-process one. How late it
        // came is kept, not bounded: 627–4661 ms within one run on a shared host (UI suite 39285931841).
        keep("c-shot-lag", shotLag.map { "\($0.key) \($0.value) ms" }.sorted().joined(separator: "\n"))
        if outcome == "toast" {
            XCTAssertTrue(toastLabel.contains("lasku"), "toast: \(toastLabel)")
            XCTAssertGreaterThan(toastFrame.minY, window.height * 0.6, "the toast is at \(toastFrame.minY): not at the bottom")
            assertMinimalQueue(reading: reading, read: read)
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

    /// The queue's primary: "Valmis", or "Näytä tarkistettavat (n)" once a saved receipt waits there.
    var queuePrimary: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Valmis", "Näytä tarkistettavat")).firstMatch
    }

    /// The fixture's queue row: the row (a button once saved, named by the file first) or its texts.
    var queueRow: NSPredicate {
        NSPredicate(format: "identifier == %@ OR label BEGINSWITH %@", "capture-queue-row", "testikuitti.jpg")
    }

    /// Scrolls a form row above the pinned save, as the owner would before tapping it: a row under
    /// the bar still counts as hittable, and a tap on it lands on the save (UI suite 39285931841).
    func clearOfSave(_ element: XCUIElement, _ save: XCUIElement) -> Bool {
        for attempt in 0...4 {
            guard element.exists else { return false }
            let bar = save.exists ? save.frame.minY : app.windows.firstMatch.frame.maxY
            if element.isHittable, element.frame.minY > 100, element.frame.maxY <= bar - 4 { return true }
            guard attempt < 4 else { break }
            app.windows.firstMatch.swipeUp(velocity: .slow)
            waitStill(element)
        }
        return false
    }

    /// A label on the screen on top: one under a sheet or cover is in the tree too, but cannot be hit.
    func onTop(_ format: String, _ label: String) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: format, label)).allElementsBoundByIndex.contains { $0.isHittable }
    }

    /// M009: "Kategoria" said once on the form on top, by its picker ("Kategoria, Valitse"). The
    /// picker is brought on screen first; a header over it would come with it.
    func assertKategoriaOnce(_ form: String, file: StaticString = #filePath, line: UInt = #line) {
        let picker = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if picker.exists && !picker.isHittable { app.swipeUp(); waitStill(picker) }
        let named = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label ==[c] %@ OR label BEGINSWITH %@", "Kategoria", "Kategoria, "))
            .allElementsBoundByIndex.filter { $0.isHittable }
        keep("kategoria", "\(form): \(named.map(\.label))")
        XCTAssertEqual(named.count, 1, "\(form) says Kategoria \(named.count) times: \(named.map(\.label))", file: file, line: line)
    }

    /// O1 and X051 after a bill was saved from the form: "Valmis" is the queue's one action, adding
    /// files is in Toiminnot, the row's kind is quiet text changed from the row's own menu, and
    /// neither that change nor the save moves the row or the button. `read`: the row waiting for
    /// the form (c3).
    func assertMinimalQueue(reading: (row: CGRect, primary: CGRect)?, read: (row: CGRect, primary: CGRect)?) {
        // The queue's list, not Kuitit's under the cover.
        let list = app.collectionViews.containing(queueRow).firstMatch
        guard list.waitForExistence(timeout: 5) else { tree("c5-no-queue"); XCTFail("the queue is not on the screen after the save"); return }
        let notActions = ["capture-fixture", "capture-queue-fixture", "capture-queue-row"]
        // A row's insides are the row: its kind Menu shows its label as an unnamed button inside
        // it (UI suite 39326372755: ["", "Valmis"], the "" at the row's lines, a child of the row).
        func buttonsIn(_ element: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            guard !notActions.contains(element.identifier) else { return [] }
            return (element.elementType == .button ? [element] : []) + element.children.flatMap(buttonsIn)
        }
        func readActions() -> [XCUIElementSnapshot] {
            ((try? list.snapshot())?.children ?? []).flatMap(buttonsIn)
                .filter { !notActions.contains($0.identifier) && !$0.label.hasPrefix("testikuitti.jpg") }
        }
        // Read until it holds still: a run had one more, unnamed, button while the saved row became
        // its kind menu (UI suite 39306520926, ["Valmis", ""]); whether it stays is what is asserted.
        var seen = readActions()
        for _ in 0..<12 where seen.count != 1 {
            usleep(250_000)
            seen = readActions()
        }
        let actions = seen.map(\.label)
        keep("c-queue-actions", seen.map { "\($0.label) [\($0.identifier)] \($0.frame)" }.joined(separator: " | "))
        if actions.count != 1 { tree("c5-queue-actions") }
        XCTAssertEqual(actions.count, 1, "the queue shows more than its primary: \(actions)")
        XCTAssertTrue(actions.first == "Valmis" || actions.first?.hasPrefix("Näytä tarkistettavat") == true, "the queue's action: \(actions)")
        XCTAssertEqual(list.images.matching(identifier: "arrow.left.arrow.right").count, 0, "the row still shows the ⇄ icon")
        XCTAssertEqual(list.buttons.matching(NSPredicate(format: "label IN %@", ["Ostolasku", "Kuitti"])).count, 0,
                       "the row still has its accent kind switch")
        // X052: a lone row says its own outcome; the owner saved it by hand, nothing was automatic.
        let automatic = list.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "Hyväksyttiin automaattisesti", "Hyväksytty automaattisesti"))
        XCTAssertEqual(automatic.count, 0, "a hand-saved lone row is called automatic: \(automatic.allElementsBoundByIndex.map(\.label))")

        let bar = app.navigationBars["Uusi kuitti"]
        let more = bar.buttons["Toiminnot"]
        if more.waitForExistence(timeout: 5) {
            more.tap()
            let photos = app.buttons["Valitse kuvista"].firstMatch
            XCTAssertTrue(photos.waitForExistence(timeout: 5), "Toiminnot has no Valitse kuvista")
            XCTAssertTrue(app.buttons["Valitse tiedosto"].firstMatch.exists, "Toiminnot has no Valitse tiedosto")
            capture("c6-queue-menu")
            // Closed without a choice: low on the screen, under the queue's buttons and away from the menu.
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
            XCTAssertTrue(waitGone(photos, timeout: 5), "Toiminnot did not close")
        } else {
            XCTFail("the queue has no Toiminnot")
        }

        // The saved row is one element, its menu (a button or a pop-up button by iOS version), in its
        // list cell; the cell is what moves the rows and the button under it.
        let cell = list.cells.containing(queueRow).firstMatch
        let row = list.descendants(matching: .any).matching(queueRow).firstMatch
        guard cell.waitForExistence(timeout: 5), queuePrimary.exists else { tree("c6-no-row"); XCTFail("no saved row or primary on the queue"); return }
        let saved = (row: cell.frame, primary: queuePrimary.frame)
        keep("c-saved-geometry", "row \(saved.row), primary \(saved.primary), label \(row.exists ? row.label : "none")")
        if let reading {
            XCTAssertEqual(saved.row.height, reading.row.height, accuracy: 1, "the saved row is \(saved.row.height) pt, \(reading.row.height) pt while read")
            XCTAssertEqual(saved.primary.minY, reading.primary.minY, accuracy: 1, "the save moved the primary from \(reading.primary.minY) to \(saved.primary.minY)")
        }
        if let read {
            XCTAssertEqual(saved.row.height, read.row.height, accuracy: 1, "the saved row is \(saved.row.height) pt, \(read.row.height) pt while it waited for the form")
            XCTAssertEqual(saved.primary.minY, read.primary.minY, accuracy: 1, "the primary was at \(read.primary.minY) beside the read row, at \(saved.primary.minY) after the save")
        }
        guard row.exists else { tree("c6-no-row-menu"); XCTFail("the saved row has no menu to change its kind"); return }
        // The file name is set aside: only the words after it name the kind.
        func names(_ kind: String) -> Bool { row.label.replacingOccurrences(of: "testikuitti.jpg", with: "").contains(kind) }
        // The kind is turned around and back from the row's menu, a tap on the row.
        for (title, kind) in [("Muuta kuitiksi", "Kuitti"), ("Muuta ostolaskuksi", "Ostolasku")] {
            row.tap()
            let change = app.buttons[title].firstMatch
            guard change.waitForExistence(timeout: 5) else {
                capture("c7-no-\(kind)"); tree("c7-no-\(kind)"); XCTFail("a tap on the saved row offers no \(title)"); return
            }
            change.tap()
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline && !names(kind) { usleep(250_000) }
            waitStill(cell)
            let now = (row: cell.frame, primary: queuePrimary.frame)
            keep("c-\(kind)-geometry", "row \(now.row), primary \(now.primary), label \(row.label)")
            XCTAssertTrue(names(kind), "after \(title) the row reads \(row.label)")
            XCTAssertEqual(now.row.height, saved.row.height, accuracy: 1, "\(title) made the row \(now.row.height) pt, \(saved.row.height) before")
            XCTAssertEqual(now.primary.minY, saved.primary.minY, accuracy: 1, "\(title) moved the primary from \(saved.primary.minY) to \(now.primary.minY)")
        }
        capture("c7-kind-back")
    }

    // U095 and M009 on Kuitti > Muokkaa, as testC checks the capture form: the fields keep their
    // names, "Kategoria" is said once, and Lisätiedot's fields are named.
    func testC1_ReceiptEditLabels() {
        guard openKuitit() else { capture("g0-no-kuitit"); XCTFail("Kuitit did not open"); return }
        guard tapLabel("label CONTAINS %@", "ABC Prisma Kotka") else {
            capture("g0-no-row"); XCTFail("seed receipt ABC Prisma Kotka is not listed"); return
        }
        // The receipt's own Toiminnot, in its page's bar: a tap while Kuitit still moved stayed on the
        // list, whose Toiminnot (Suodata, Valitse kuitteja) has no Muokkaa (UI suite 39384548360).
        let page = app.navigationBars["Kuitti"]
        if !page.waitForExistence(timeout: 8) {
            capture("g0-no-push")
            guard tapLabel("label CONTAINS %@", "ABC Prisma Kotka"), page.waitForExistence(timeout: 15) else {
                capture("g0-no-detail"); XCTFail("ABC Prisma Kotka did not open its page"); return
            }
        }
        let actions = page.buttons["Toiminnot"].firstMatch
        guard actions.waitForExistence(timeout: 20) else { capture("g0-no-detail"); XCTFail("the receipt did not load"); return }
        actions.tap()
        let edit = app.buttons["Muokkaa"].firstMatch
        guard edit.waitForExistence(timeout: 5) else { capture("g1-menu"); XCTFail("Toiminnot has no Muokkaa"); return }
        edit.tap()
        let sheet = app.navigationBars["Muokkaa kuittia"]
        guard sheet.waitForExistence(timeout: 10) else { capture("g1-no-sheet"); tree("g1-no-sheet"); XCTFail("Muokkaa did not open Muokkaa kuittia"); return }
        waitStill(sheet)
        capture("g1-edit-sheet")
        XCTAssertTrue(onTop("label == %@", "Myyjä"), "the vendor row has no Myyjä label")
        XCTAssertFalse(isBlank(field("Myyjä"), "Myyjä"), "the seed receipt's vendor is not in the form")
        XCTAssertTrue(onTop("label BEGINSWITH %@", "Summa"), "the amount row has no Summa label")
        assertKategoriaOnce("Muokkaa kuittia")
        // Lisätiedot is under the VAT rows. Waited for on top: the receipt under the sheet can have a
        // "Selite" of its own, which is in the tree from the start.
        for _ in 0..<3 where !onTop("label == %@", "Selite") {
            app.swipeUp()
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline && !onTop("label == %@", "Selite") { usleep(250_000) }
        }
        capture("g2-edit-sheet-lisatiedot")
        for label in ["Viitenumero", "Laskun numero", "Selite"] {
            XCTAssertTrue(onTop("label == %@", label), "Lisätiedot: \(label) has no label")
        }
        sheet.buttons["Peruuta"].tap()
        XCTAssertTrue(waitGone(sheet, timeout: 5), "Peruuta did not close Muokkaa kuittia")
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
        openAdd()
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

    /// Myynti's overdue row: its badge says "Myöhässä" and its line the due date. The late chip and
    /// the receivables bar say "Myöhässä" too, but name no invoice.
    static let overdueRow = "label CONTAINS 'Myöhässä' AND label CONTAINS %@"

    /// Labels of the actions that were tiles or buttons in the invoice's body.
    static let invoiceActions = ["PDF", "Lähetä", "Maksu", "Korttimaksu", "Kopioi", "Muokkaa", "Lähetä lasku",
                                 "Lähetä maksumuistutus", "Merkitse maksetuksi", "Kirjaa maksu"]

    func buttons(_ label: String) -> XCUIElementQuery { app.buttons.matching(NSPredicate(format: "label == %@", label)) }

    /// The shown screen's Back, then the bar of the screen under it. A sheet's stack has its own Back
    /// over the one of the screen beneath it, which is not hittable.
    func back(to title: String) {
        // A menu still open takes the first tap and closes (UI suite 39487668420 stayed on Lasku 2
        // under its Toiminnot), so the back is tried once more when the screen did not come.
        for _ in 0..<2 {
            let shown = app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex.first { $0.isHittable }
            if let shown { shown.tap() } else { edgeSwipeBack() }
            if app.navigationBars[title].waitForExistence(timeout: 10) { return }
        }
    }

    /// Closes an open menu without choosing, by a tap beside it, and waits until `item` has gone with it.
    /// The tap is at the leading edge: the trailing bar button's menu reaches past the screen's middle
    /// and its rows start under the bar, so a tap there would choose one.
    func closeMenu(showing item: XCUIElement) {
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        _ = waitGone(item, timeout: 5)
    }

    /// The texts the textClipped audit finds cut at this text size, as StabilityTests.test17 reads
    /// them. Its guesses at larger sizes ("may be clipped at larger Dynamic Type sizes") are only
    /// noted: they belong to B5, and it makes them for whole text too (testD).
    func clippedTexts() -> [String] {
        final class Found { var labels: [String] = [] }
        let found = Found()
        do {
            try app.performAccessibilityAudit(for: .textClipped) { issue in
                let label = issue.element?.label ?? ""
                let text = "\(label.isEmpty ? issue.compactDescription : label): \(issue.detailedDescription)"
                if "\(issue.compactDescription) \(issue.detailedDescription)".localizedCaseInsensitiveContains("larger") {
                    self.note("INFO owner audit at larger sizes: \(text)")
                } else {
                    found.labels.append(text)
                }
                return true
            }
        } catch {
            XCTFail("the textClipped audit did not run: \(error)")
        }
        return found.labels
    }

    // U006 U015 U029 U046 U047 (N6): one primary on the invoice, the state said once. Lasku 2 showed
    // 'Lähetä maksumuistutus' over four tiles (PDF, Lähetä, Maksu, Kopioi) that its ⋯ menu repeated,
    // a second reminder button on its Muistutus tab, and 'Myöhässä' three times: a badge, the days
    // beside it and the reminder's header. Lasku 3 showed PDF, Lähetä and Kopioi under 'Kirjaa maksu'.
    func testE_InvoiceDetailOnePrimary() {
        guard selectTab("Myynti") else { capture("e0-no-tab"); XCTFail("Myynti did not open"); return }
        let invoice = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        guard tapLabel(Self.overdueRow, "· eräpäivä"), invoice.waitForExistence(timeout: 20) else {
            capture("e0-no-overdue"); tree("e0-no-overdue"); XCTFail("no overdue invoice opened from Myynti"); return
        }
        let remind = buttons("Lähetä maksumuistutus")
        guard remind.firstMatch.waitForExistence(timeout: 20) else {
            capture("e1-no-reminder"); tree("e1-no-reminder"); XCTFail("\(invoice.identifier) offers no Lähetä maksumuistutus"); return
        }
        capture("e1-overdue-detail")
        let tiles = ["PDF", "Lähetä", "Maksu", "Kopioi"].filter { buttons($0).count > 0 }
        XCTAssertEqual(tiles, [], "\(invoice.identifier): the body still has the tiles")
        XCTAssertEqual(remind.count, 1, "\(invoice.identifier): Lähetä maksumuistutus \(remind.count) times")
        let late = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "Myöhässä [0-9]+ päivä(ä|n)"))
        XCTAssertTrue(late.firstMatch.exists, "\(invoice.identifier) has no 'Myöhässä N päivää'")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label == %@", "Myöhässä")).firstMatch.exists,
                       "\(invoice.identifier) still has the bare 'Myöhässä' badge")
        let stated = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "myöhässä")).allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(stated.count, 1, "\(invoice.identifier) says it is late \(stated.count) times: \(stated)")
        XCTAssertTrue(app.staticTexts["Laskun päivä"].exists, "\(invoice.identifier) has no 'Laskun päivä'")
        // Its Muistutus tab, which opens first: 'Avaa muistutus', and no second send button under it.
        let reminderPdf = buttons("Avaa muistutus").firstMatch
        if reveal(reminderPdf, scrolls: 3) {
            let below = remind.allElementsBoundByIndex.filter { $0.frame.minY > reminderPdf.frame.minY }
            XCTAssertEqual(below.count, 0, "\(invoice.identifier): the Muistutus tab repeats Lähetä maksumuistutus")
        } else {
            tree("e1-no-reminder-tab"); XCTFail("\(invoice.identifier): its Muistutus tab shows no Avaa muistutus")
        }

        invoice.buttons["Toiminnot"].firstMatch.tap()
        let menu = ["Avaa PDF", "Lähetä sähköpostilla", "Kirjaa maksu", "Kopioi luonnokseksi"]
        let missing = menu.filter { !buttons($0).firstMatch.waitForExistence(timeout: 5) }
        capture("e2-overdue-menu")
        XCTAssertEqual(missing, [], "\(invoice.identifier): Toiminnot lacks them")
        closeMenu(showing: buttons("Kopioi luonnokseksi").firstMatch)

        back(to: "Myynti")
        guard tapLabel("label CONTAINS 'Odottaa maksua' AND label CONTAINS %@", "· eräpäivä"), invoice.waitForExistence(timeout: 20) else {
            capture("e3-no-sent"); tree("e3-no-sent"); XCTFail("no sent invoice waiting for its payment opened from Myynti"); return
        }
        let pay = buttons("Kirjaa maksu")
        _ = pay.firstMatch.waitForExistence(timeout: 20)
        capture("e3-sent-detail")
        let body = Self.invoiceActions.filter { buttons($0).count > 0 }
        XCTAssertEqual(body, ["Kirjaa maksu"], "\(invoice.identifier): the body's actions")
        XCTAssertEqual(pay.count, 1, "\(invoice.identifier): Kirjaa maksu \(pay.count) times")
    }

    // M035 X141 (N6): Myynti's bar carried Avustaja, Asetukset and an icon-only "+" of the same
    // weight; 'Hae asiakkaiden maksut pankista' was a full-width card under the list; the overdue row
    // said 'myöhässä' in its line beside its 'Myöhässä' badge; the new invoice's Asiakas card offered
    // 'Uusi asiakas' beside 'Valitse asiakas', whose picker opens with it.
    func testF_MyyntiRootBar() {
        guard selectTab("Myynti") else { capture("f0-no-tab"); XCTFail("Myynti did not open"); return }
        let bar = app.navigationBars["Myynti"]
        let new = bar.buttons["Uusi lasku"]
        guard new.waitForExistence(timeout: 10) else { capture("f0-no-new"); tree("f0-no-new"); XCTFail("Myynti's bar has no Uusi lasku"); return }
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: Self.overdueRow, "Lasku "))
        _ = rows.firstMatch.waitForExistence(timeout: 15)
        capture("f1-myynti")
        keep("f-bar", "\(barItems(bar)); Uusi lasku \(new.frame)")
        // In words: the "+" glyph alone was about 44 pt wide.
        XCTAssertGreaterThan(new.frame.width, 60, "Uusi lasku is an icon, not its words: \(new.frame)")
        // Q2: the assistant is on Koti's bar only.
        XCTAssertFalse(bar.buttons["Avustaja"].exists, "Myynti's bar still has Avustaja")

        // The row's whole label, its badge included: the longest of the matches (its line is one too).
        if let row = rows.allElementsBoundByIndex.max(by: { $0.label.count < $1.label.count }) {
            let said = row.label.lowercased().components(separatedBy: "myöhässä").count - 1
            keep("f-row", row.label)
            XCTAssertEqual(said, 1, "the overdue row says myöhässä \(said) times: \(row.label)")
        } else {
            tree("f1-no-row"); XCTFail("Myynti lists no overdue invoice")
        }

        // The bank's payments: no longer under the list, in Toiminnot.
        let bank = buttons("Hae asiakkaiden maksut pankista")
        var inList = false
        for _ in 0..<6 where !inList {
            inList = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Hae asiakkaiden maksut pankista")).firstMatch.exists
            if !inList { app.windows.firstMatch.swipeUp(velocity: .fast) }
        }
        capture("f2-myynti-bottom")
        XCTAssertFalse(inList, "Myynti's list still has the Hae asiakkaiden maksut pankista card")
        let actions = bar.buttons["Toiminnot"]
        guard actions.waitForExistence(timeout: 5) else { tree("f2-no-actions"); XCTFail("Myynti's bar has no Toiminnot"); return }
        actions.tap()
        guard bank.firstMatch.waitForExistence(timeout: 5) else { capture("f2-menu"); XCTFail("Toiminnot has no Hae asiakkaiden maksut pankista"); return }
        bank.firstMatch.tap()
        let match = app.navigationBars["Maksut pankista"]
        XCTAssertTrue(match.waitForExistence(timeout: 10), "Toiminnot > Hae asiakkaiden maksut pankista did not open its sheet")
        match.buttons.matching(NSPredicate(format: "label IN %@", ["Sulje", "Peruuta"])).firstMatch.tap()
        XCTAssertTrue(waitGone(match, timeout: 10), "the bank payments sheet did not close")

        // Uusi lasku: one row in the Asiakas card; the picker's own Uusi asiakas makes and picks one.
        let form = app.navigationBars["Uusi lasku"]
        for _ in 0..<2 where !form.exists {
            new.tap()
            _ = form.waitForExistence(timeout: 10)
        }
        guard form.exists else { capture("f3-no-form"); XCTFail("Uusi lasku did not open the form"); return }
        let pick = buttons("Valitse asiakas")
        guard pick.firstMatch.waitForExistence(timeout: 10) else {
            capture("f3-no-pick"); tree("f3-no-pick"); XCTFail("the new invoice has no Valitse asiakas (a kept draft with a customer?)"); return
        }
        capture("f3-new-invoice")
        XCTAssertEqual(pick.count, 1, "Valitse asiakas \(pick.count) times")
        XCTAssertEqual(buttons("Uusi asiakas").count, 0, "the Asiakas card still offers Uusi asiakas beside Valitse asiakas")
        pick.firstMatch.tap()
        let picker = app.navigationBars["Valitse asiakas"]
        let add = buttons("Uusi asiakas").firstMatch
        guard picker.waitForExistence(timeout: 10), add.waitForExistence(timeout: 5) else {
            capture("f4-no-picker"); tree("f4-no-picker"); XCTFail("the picker has no Uusi asiakas"); return
        }
        add.tap()
        let customerForm = app.navigationBars["Uusi asiakas"]
        let nameField = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Nimi", "Nimi")).firstMatch
        guard customerForm.waitForExistence(timeout: 10), nameField.waitForExistence(timeout: 5) else {
            capture("f4-no-customer-form"); tree("f4-no-customer-form"); XCTFail("Uusi asiakas did not open its form"); return
        }
        // Found again by its digits: autocorrect may change the word.
        let token = String(Int.random(in: 100_000...999_999))
        let customer = "Testiasiakas \(token)"
        type(nameField, customer)
        customerForm.buttons["Tallenna"].tap()
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", token)).firstMatch
        let saved = waitGone(customerForm, timeout: 20) && waitGone(picker, timeout: 10) && card.waitForExistence(timeout: 10)
        capture("f5-customer-picked")
        if !saved { tree("f5-customer-picked") }
        XCTAssertTrue(saved, "the picker's Uusi asiakas did not create and pick \(customer)")

        form.buttons["Peruuta"].firstMatch.tap()
        let discard = app.buttons["Hylkää muutokset"].firstMatch
        if discard.waitForExistence(timeout: 5) { discard.tap() }
        XCTAssertTrue(waitGone(form, timeout: 10), "the new invoice did not close")
    }

    // X003 X028 (N6), the demo account with no mailbox: Lähetä lasku had only Peruuta in its bar,
    // its Lähetä and the reason it was blocked below the first screen. The reminder from Koti said
    // 'Sähköpostitiliä ei ole yhdistetty' with nothing to tap but Peruuta, and named no invoice.
    func testK_SendSheetFixInReach() {
        guard selectTab("Myynti") else { capture("k0-no-tab"); XCTFail("Myynti did not open"); return }
        let invoice = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        guard tapLabel(Self.overdueRow, "· eräpäivä"), invoice.waitForExistence(timeout: 20) else {
            capture("k0-no-overdue"); tree("k0-no-overdue"); XCTFail("no overdue invoice opened from Myynti"); return
        }
        let title = invoice.identifier
        let window = app.windows.firstMatch.frame
        // On the first screen: inside the window, above the home indicator, tappable.
        func inReach(_ element: XCUIElement) -> Bool {
            element.exists && element.isHittable && element.frame.minY >= window.minY && element.frame.maxY <= window.maxY - 34
        }
        let blocked = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Sähköpostitiliä ei ole yhdistetty")).firstMatch
        let fix = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Yhdistä sähköposti")).firstMatch
        let settings = app.navigationBars["Sähköpostien tuonti"]

        var under = clippedTexts()
        guard invoiceAction("Lähetä sähköpostilla") else { capture("k1-no-send"); XCTFail("\(title): Toiminnot has no Lähetä sähköpostilla"); return }
        let send = app.navigationBars["Lähetä lasku"]
        guard send.waitForExistence(timeout: 10) else { capture("k1-no-sheet"); XCTFail("Lähetä sähköpostilla did not open Lähetä lasku"); return }
        guard blocked.waitForExistence(timeout: 20) else {
            capture("k1-not-blocked"); tree("k1-not-blocked"); XCTFail("Lähetä lasku does not say the mailbox is missing: has the demo user one?"); return
        }
        waitStill(send)
        capture("k1-send-sheet")
        let bar = send.buttons["Lähetä"]
        XCTAssertTrue(bar.exists, "Lähetä lasku's bar has no Lähetä")
        XCTAssertFalse(bar.exists && bar.isEnabled, "Lähetä is enabled with no mailbox")
        XCTAssertTrue(inReach(blocked), "the block is not on the first screen: \(blocked.frame) of \(window)")
        XCTAssertTrue(inReach(fix), "Yhdistä sähköposti is not on the first screen: \(fix.exists ? "\(fix.frame)" : "missing")")
        let cut = clippedTexts().filter { !under.contains($0) }
        XCTAssertEqual(cut, [], "Lähetä lasku: text cut on the sheet")
        if inReach(fix) {
            fix.tap()
            XCTAssertTrue(settings.waitForExistence(timeout: 10), "Yhdistä sähköposti did not push the e-mail settings")
            capture("k2-send-fix")
            back(to: "Lähetä lasku")
        }
        send.buttons["Peruuta"].firstMatch.tap()
        XCTAssertTrue(waitGone(send, timeout: 10), "Peruuta did not close Lähetä lasku")

        // Koti's Muistuta stays and opens the sheet, which names the invoice and links the fix.
        guard selectTab("Koti") else { XCTFail("Koti did not open"); return }
        let remind = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Muistuta")).firstMatch
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Näytä enemmän")).firstMatch
        let tabs = app.tabBars.firstMatch
        // Clear of the bar at the top and of the floating tab bar, which takes a tap meant for a row.
        func clear(_ element: XCUIElement) -> Bool {
            element.exists && element.isHittable && element.frame.minY > 100 && (!tabs.exists || element.frame.maxY < tabs.frame.minY)
        }
        _ = remind.waitForExistence(timeout: 15)
        for _ in 0..<8 where !clear(remind) {
            if !remind.exists && clear(more) {
                more.tap()
                _ = remind.waitForExistence(timeout: 5)
            } else {
                app.windows.firstMatch.swipeUp(velocity: .slow)
            }
        }
        guard clear(remind) else { capture("k3-no-muistuta"); tree("k3-no-muistuta"); XCTFail("Koti has no Muistuta on the overdue task"); return }
        under = clippedTexts()
        remind.tap()
        let reminder = app.navigationBars["Maksumuistutus"]
        guard reminder.waitForExistence(timeout: 20) else { capture("k3-no-sheet"); XCTFail("Muistuta did not open Maksumuistutus"); return }
        waitStill(reminder)
        capture("k3-koti-reminder")
        // The sheet's own line, not Koti's row under it ('Lasku 2 · myöhässä 15 päivää').
        let named = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH[c] %@ AND NOT (label CONTAINS[c] %@)", "\(title) · ", "myöhässä")).firstMatch
        XCTAssertTrue(named.waitForExistence(timeout: 5), "Maksumuistutus from Koti does not name \(title)")
        XCTAssertTrue(blocked.exists, "Maksumuistutus does not say the mailbox is missing")
        XCTAssertTrue(inReach(fix), "Maksumuistutus has no Yhdistä sähköposti on its first screen")
        let cutReminder = clippedTexts().filter { !under.contains($0) }
        XCTAssertEqual(cutReminder, [], "Maksumuistutus: text cut on the sheet")
        if inReach(fix) {
            fix.tap()
            XCTAssertTrue(settings.waitForExistence(timeout: 10), "the reminder's Yhdistä sähköposti did not push the e-mail settings")
            capture("k4-reminder-fix")
            back(to: "Maksumuistutus")
        }
        reminder.buttons["Peruuta"].firstMatch.tap()
        XCTAssertTrue(waitGone(reminder, timeout: 10), "Peruuta did not close Maksumuistutus")
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
        // opens the fold, and so does the walk. The first look notes nothing: a row behind the fold
        // is the expected case, not a MISS (run 39521465092 noted one before finding it).
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Audit Hyvitys Oy,")).firstMatch
        var found = reveal(row)
        if found { row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); taps += 1 }
        for _ in 0..<2 where !found {
            guard tapLabel("label BEGINSWITH %@", "Näytä enemmän") else { break }
            found = tapLabel("label CONTAINS %@", "Audit Hyvitys Oy,")
        }
        guard found else { capture("j0-no-row"); XCTFail("Kuitit lists no Audit Hyvitys Oy"); return }
        // The offer is Toiminnot's item since N3 (U098): the page's body asks nothing of an unfiled
        // receipt. The notice comes with its own request after the receipt, so Toiminnot is opened
        // until it carries the item, and closed by its own button in between.
        let menu = app.navigationBars["Kuitti"].buttons["Toiminnot"].firstMatch
        guard menu.waitForExistence(timeout: 20) else { capture("j1-no-page"); XCTFail("the credit note's page did not open"); return }
        let credit = app.buttons["Merkitse ostolaskun hyvitykseksi"].firstMatch
        let deadline = Date().addingTimeInterval(20)
        repeat {
            menu.tap()
            if credit.waitForExistence(timeout: 3) { break }
            menu.tap()
            usleep(500_000)
        } while Date() < deadline
        capture("j1-credit-note")
        if !credit.exists { tree("j1-credit-note") }
        let bill = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "maksetaan myöhemmin")).firstMatch
        XCTAssertFalse(bill.exists, "the credit note is asked whether it is a bill paid later")
        XCTAssertTrue(credit.exists, "the credit note is not offered as an ostolasku's credit: no 'Merkitse ostolaskun hyvitykseksi'")
        XCTAssertFalse(app.buttons["Merkitse ostolaskuksi"].exists, "the credit note is offered as a bill to pay")
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

    /// The first of `query` that is on screen clear of the bars, scrolling down for it a few times,
    /// and still: the colours and frames read from it are where it rests.
    func onScreen(_ query: XCUIElementQuery, scrolls maxScrolls: Int = 4) -> XCUIElement? {
        let window = app.windows.firstMatch
        let tabs = app.tabBars.firstMatch
        _ = query.firstMatch.waitForExistence(timeout: 15)
        for attempt in 0...maxScrolls {
            let bottom = tabs.exists ? tabs.frame.minY : window.frame.maxY - 34
            if let found = query.allElementsBoundByIndex.first(where: { $0.exists && $0.isHittable && $0.frame.minY > 180 && $0.frame.maxY < bottom - 8 }) {
                waitStill(found)
                return found
            }
            if attempt < maxScrolls { window.swipeUp(velocity: .slow); scrolls += 1 }
        }
        return nil
    }

    /// A soft pill: accentSoft (243,230,227) inside the capsule at both ends, beside its words.
    func assertSoft(_ pill: XCUIElement, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let soft = RGB(r: 243, g: 230, b: 227)
        let frame = pill.frame
        let read = screenColours(app, at: [CGPoint(x: frame.minX + 5, y: frame.midY), CGPoint(x: frame.maxX - 5, y: frame.midY)])
        let shown = read.map { $0?.description ?? "off screen" }.joined(separator: " ")
        keep("g-pill", "\(name) \(frame): \(shown)")
        XCTAssertTrue(read.allSatisfy { $0?.near(soft, within: 20) == true }, "\(name): the pill reads \(shown), not accentSoft \(soft)",
                      file: file, line: line)
    }

    // M008 M017 M049 M088 M076 (P3): a row's own action is a soft pill, accentSoft under accentDark
    // words, as on the web. Koti's 'Kuvaa kuitti', Kuukauden sulku's row actions and the row
    // 'Hyväksy' of Kohdista ostolaskujen maksut were filled capsules, one more primary on every row.
    func testG_RowPillsAreSoft() {
        guard selectTab("Koti") else { capture("g0-no-tab"); XCTFail("Koti did not open"); return }
        let camera = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Kuvaa kuitti", "Kuvaa kuitti: "))
        guard let koti = onScreen(camera) else {
            capture("g0-no-pill"); tree("g0-no-pill"); XCTFail("Koti shows no Kuvaa kuitti on a task row: has the seed bank rows without a receipt?"); return
        }
        capture("g1-koti")
        assertSoft(koti, "Koti \(koti.label)")

        guard selectTab("Kirjanpito") else { capture("g2-no-tab"); XCTFail("Kirjanpito did not open"); return }
        let periods = app.navigationBars["Kuukauden sulku"]
        if tapLabel("label BEGINSWITH %@", "Kuukauden sulku"), periods.waitForExistence(timeout: 10) {
            let actions = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Kuvaa kuitti: ", "Täydennä: "))
            if let pill = onScreen(actions) {
                capture("g2-periods")
                assertSoft(pill, "Kuukauden sulku \(pill.label)")
            } else {
                note("INFO owner g: Kuukauden sulku's month has no row action to look at")
            }
            back(to: "Kirjanpito")
        } else {
            capture("g2-no-periods"); XCTFail("Kuukauden sulku did not open")
        }

        let matching = app.navigationBars["Kohdista ostolaskujen maksut"]
        guard tapLabel("label BEGINSWITH %@", "Kohdista ostolaskujen maksut"), matching.waitForExistence(timeout: 10) else {
            capture("g3-no-matching"); tree("g3-no-matching"); XCTFail("Kohdista ostolaskujen maksut did not open"); return
        }
        let accept = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Hyväksy maksu ostolaskulle"))
        if let pill = onScreen(accept, scrolls: 2) {
            capture("g3-matching")
            assertSoft(pill, "Kohdista ostolaskujen maksut \(pill.label)")
        } else {
            note("INFO owner g: Kohdista ostolaskujen maksut proposes no payment to look at")
        }
    }

    // X006 (P3): Koti's row pills take a 44 pt tall tap and their rows do not grow for it. The
    // capsule is caption bold with 5 pt above and below, about 24 pt, and a tap just above it opened
    // the row's own screen instead.
    func testL_KotiPillHitArea() {
        guard selectTab("Koti") else { capture("l0-no-tab"); XCTFail("Koti did not open"); return }
        let camera = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Kuvaa kuitti", "Kuvaa kuitti: "))
        guard let pill = onScreen(camera) else {
            capture("l0-no-pill"); tree("l0-no-pill"); XCTFail("Koti shows no Kuvaa kuitti on a task row"); return
        }
        capture("l1-koti")
        let tabs = app.tabBars.firstMatch
        let pills = app.buttons.matching(NSPredicate(format: "label MATCHES %@", "(Hyväksy|Täydennä|Kohdista|Kuvaa kuitti|Muistuta)(: .*)?"))
            .allElementsBoundByIndex.filter { $0.exists && $0.frame.minY > 130 && (!tabs.exists || $0.frame.maxY < tabs.frame.minY) }
        keep("l-pills", pills.map { "\($0.label) \($0.frame)" }.joined(separator: "; "))
        for each in pills {
            XCTAssertGreaterThanOrEqual(each.frame.height, 44, "\(each.label): a \(each.frame.height) pt tall target")
        }

        // The row holds its height: 10 pt above and below its tallest column (TaskRow), the trailing
        // one being the amount, 6 pt, and the capsule.
        let capsule = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .bold).lineHeight + 10
        let centre = CGPoint(x: pill.frame.midX, y: pill.frame.midY)
        let rows = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Kuitti puuttuu")).allElementsBoundByIndex
        if let row = rows.first(where: { $0.frame.width > 200 && $0.frame.contains(centre) }) {
            let texts = row.staticTexts.allElementsBoundByIndex.map(\.frame)
            let left = texts.filter { $0.midX < row.frame.midX }
            let right = texts.filter { $0.midX >= row.frame.midX }
            let named = left.isEmpty ? 0 : left.map(\.maxY).max()! - left.map(\.minY).min()!
            let trailing = (right.map(\.height).max().map { $0 + 6 } ?? 0) + capsule
            let expected = 20 + max(36, named, trailing)
            keep("l-row", "\(row.label) \(row.frame); texts \(texts); capsule \(capsule) pt; expected \(expected) pt")
            XCTAssertEqual(row.frame.height, expected, accuracy: 1, "the row is \(row.frame.height) pt tall for \(expected) pt of content")
        } else {
            tree("l1-no-row"); XCTFail("no task row holds the Kuvaa kuitti at \(centre)")
        }

        // A tap 8 pt above the visible capsule is the pill's, not the row's.
        let window = app.windows.firstMatch
        let above = CGPoint(x: pill.frame.midX, y: pill.frame.midY - capsule / 2 - 8)
        window.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: above.x - window.frame.minX, dy: above.y - window.frame.minY)).tap()
        taps += 1
        let flow = app.navigationBars["Uusi kuitti"]
        let opened = flow.waitForExistence(timeout: 10)
        capture("l2-above-the-pill")
        XCTAssertTrue(opened, "a tap 8 pt above the capsule did not open Kuvaa kuitti")
        if opened {
            flow.buttons["Peruuta"].firstMatch.tap()
            XCTAssertTrue(waitGone(flow, timeout: 10), "Peruuta did not close the receipt page")
        }
        let pushed = app.navigationBars.buttons.matching(identifier: "BackButton").firstMatch
        XCTAssertFalse(pushed.exists, "the tap opened the row's own screen: \(app.navigationBars.firstMatch.identifier)")
    }

    // M099 X004 M034 (P3): figures in the colour of their role. Koti's '−100 % vs. syyskuu' was success
    // green; the invoice's Yhteensä was the palest number on its card; Toistuvat laskut's button
    // floated under its message, outside the card.
    func testM_FiguresInTheirColours() {
        guard selectTab("Koti") else { capture("m0-no-tab"); XCTFail("Koti did not open"); return }
        // Green only for more sales than the month before (the CI seed: 0,00 € against 245,00 €).
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Myynti ", " % vs. ")).firstMatch
        if card.waitForExistence(timeout: 15), reveal(card) {
            let percent = card.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", " % vs. ")).firstMatch
            waitStill(card)
            let grows = percent.label.hasPrefix("+")
            let expected = grows ? RGB(r: 71, g: 116, b: 85) : RGB(r: 106, g: 100, b: 95)
            let read = darkestColour(app, in: percent.frame)
            capture("m1-koti-card")
            keep("m-percent", "'\(percent.label)' \(percent.frame): \(read?.description ?? "off screen")")
            XCTAssertTrue(read?.near(expected, within: 15) == true,
                          "'\(percent.label)' reads \(read?.description ?? "off screen"), not \(grows ? "success" : "ink2") \(expected)")
        } else {
            note("INFO owner m: Koti's sales card shows no percent (no sales the month before)")
        }

        guard selectTab("Myynti") else { capture("m2-no-tab"); XCTFail("Myynti did not open"); return }
        let invoice = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        guard tapLabel("label CONTAINS 'Odottaa maksua' AND label CONTAINS %@", "· eräpäivä"), invoice.waitForExistence(timeout: 20) else {
            capture("m2-no-invoice"); tree("m2-no-invoice"); XCTFail("no sent invoice opened from Myynti"); return
        }
        let lines = app.buttons["Rivit"].firstMatch
        if lines.waitForExistence(timeout: 10) { lines.tap() }
        // A LabeledContent row reads as one text: "Yhteensä, 146,84 €".
        let total = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Yhteensä, ")).firstMatch
        guard reveal(total) else { capture("m2-no-total"); tree("m2-no-total"); XCTFail("\(invoice.identifier)'s Rivit shows no Yhteensä"); return }
        waitStill(total)
        // The figure's half of the row; the label's half is ink in any case.
        let row = total.frame
        let figure = CGRect(x: row.midX, y: row.minY, width: row.maxX - row.midX, height: row.height)
        let read = darkestColour(app, in: figure)
        capture("m2-invoice-total")
        keep("m-total", "\(total.label) \(row): \(read?.description ?? "off screen")")
        XCTAssertLessThanOrEqual(read?.luma ?? 255, 70, "\(invoice.identifier): Yhteensä's figure is no darker than \(read?.description ?? "off screen")")

        back(to: "Myynti")
        let recurring = app.navigationBars["Toistuvat laskut"]
        guard tap("Toistuvat laskut"), recurring.waitForExistence(timeout: 15) else {
            capture("m3-no-recurring"); tree("m3-no-recurring"); XCTFail("Toistuvat laskut did not open"); return
        }
        let waiting = NSPredicate(format: "label ENDSWITH %@", "odottaa luontia.")
        let message = app.staticTexts.matching(waiting).firstMatch
        let create = app.buttons["Luo odottavat laskut"].firstMatch
        guard message.waitForExistence(timeout: 15), create.waitForExistence(timeout: 5) else {
            capture("m3-no-card"); tree("m3-no-card"); XCTFail("Toistuvat laskut has no 'odottaa luontia' card: has the seed an overdue schedule?"); return
        }
        capture("m3-recurring")
        let cell = app.cells.containing(waiting).firstMatch
        XCTAssertTrue(cell.exists, "the message is in no list cell")
        if cell.exists {
            XCTAssertTrue(cell.frame.contains(create.frame), "Luo odottavat laskut \(create.frame) is outside its message's card \(cell.frame)")
        }
    }

    // X116 (P3): Sähköpostimallit has an icon of its own and no dot. 'envelope.badge' always drew one,
    // which read as something unread, beside Sähköpostien tuonti's plain envelope.
    func testN_TemplatesIconHasNoDot() {
        openSettings()
        let templates = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Sähköpostimallit")).firstMatch
        let mailImport = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Sähköpostien tuonti")).firstMatch
        guard templates.waitForExistence(timeout: 15), mailImport.waitForExistence(timeout: 10) else {
            capture("n0-settings"); tree("n0-settings"); XCTFail("Asetukset lists no Sähköpostimallit or no Sähköpostien tuonti"); return
        }
        capture("n1-settings")
        // The icon is hidden from VoiceOver, so XCTest sees no image: SettingRow names the row
        // "setting-<symbol>". It can land on the row's button or on its title, so either counts.
        func symbol(_ title: String) -> String? {
            let row = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "setting-", title)).firstMatch
            return row.exists ? row.identifier : nil
        }
        let own = symbol("Sähköpostimallit"), other = symbol("Sähköpostien tuonti")
        keep("n-icons", "Sähköpostimallit \(own ?? "none"); Sähköpostien tuonti \(other ?? "none")")
        XCTAssertNotNil(own, "Sähköpostimallit shows no icon")
        XCTAssertNotNil(other, "Sähköpostien tuonti shows no icon")
        XCTAssertNotEqual(own, "setting-envelope.badge", "Sähköpostimallit still shows envelope.badge, whose dot reads as unread")
        XCTAssertNotEqual(own, other, "Sähköpostimallit and Sähköpostien tuonti share one icon")
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
