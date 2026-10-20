import XCTest

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
        if !chip.isHittable { app.buttons["receipt-tab-all"].firstMatch.swipeLeft(); sleep(1) }
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
        // after the primary; with no "Käytä lomakkeessa" yet (a read row is taller by it), it was
        // still being read when the primary was.
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
            assertMinimalQueue(reading: reading)
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
    /// neither that change nor the save moves the row or the button.
    func assertMinimalQueue(reading: (row: CGRect, primary: CGRect)?) {
        // The queue's list, not Kuitit's under the cover.
        let list = app.collectionViews.containing(queueRow).firstMatch
        guard list.waitForExistence(timeout: 5) else { tree("c5-no-queue"); XCTFail("the queue is not on the screen after the save"); return }
        let notActions = ["capture-fixture", "capture-queue-fixture", "capture-queue-row"]
        func buttonsIn(_ element: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            (element.elementType == .button ? [element] : []) + element.children.flatMap(buttonsIn)
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
        let actions = app.buttons["Toiminnot"].firstMatch
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
}
