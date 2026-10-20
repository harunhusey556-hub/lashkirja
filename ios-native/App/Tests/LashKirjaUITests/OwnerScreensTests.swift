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
        if !chip.isHittable { app.buttons["receipt-tab-all"].firstMatch.swipeLeft(); sleep(1) }
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
        let shown = app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex.first { $0.isHittable }
        if let shown { shown.tap() } else { edgeSwipeBack() }
        _ = app.navigationBars[title].waitForExistence(timeout: 10)
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
}
