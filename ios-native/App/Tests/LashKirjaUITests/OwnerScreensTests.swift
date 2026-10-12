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
        app.launch()
        if app.secureTextFields.firstMatch.waitForExistence(timeout: 8) { signIn(app) }
        // The passkey offer after a password sign-in.
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
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

    func waitGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    /// Kirjanpito → "Kuitit, 28 kuittia" (as StabilityTests.openHubRow).
    func openKuitit() -> Bool {
        guard selectTab("Kirjanpito") else { note("MISS tab Kirjanpito not selected"); return false }
        for _ in 0..<2 where !app.navigationBars["Kuitit"].exists {
            tapLabel("label BEGINSWITH %@", "Kuitit")
            _ = app.navigationBars["Kuitit"].waitForExistence(timeout: 10)
        }
        return app.navigationBars["Kuitit"].exists
    }

    /// Taps a tab until it reports itself selected. The first tap after sign-in can land while the
    /// passkey offer or a system prompt is still leaving, and is then lost (CI round 1: still on Koti).
    func selectTab(_ name: String) -> Bool {
        let button = app.tabBars.buttons[name].firstMatch
        guard button.waitForExistence(timeout: 10) else { return false }
        for _ in 0..<3 where !button.isSelected {
            dismissSystemPrompts()
            button.tap(); taps += 1
            // A fresh expectation each round: XCTest allows one wait per expectation.
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: button)
            _ = XCTWaiter().wait(for: [selected], timeout: 5)
        }
        return button.isSelected
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
        actions.tap()
        let delete = app.buttons["Poista kuitti"].firstMatch
        guard delete.waitForExistence(timeout: 5) else { capture("a1-menu"); XCTFail("Toiminnot has no Poista kuitti"); return }
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
        XCTAssertGreaterThanOrEqual(frame.width, window.width - 2, "the sheet is \(frame.width) of \(window.width) wide: a floating bubble")
        XCTAssertGreaterThan(confirm.frame.midY, window.height * 0.6, "Poista is at \(confirm.frame.midY): not where the thumb is")

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

        // Uploaded, read by the server (no cloud AI in CI: an empty reading), then the form opens by itself.
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
        // A reading the form changed asks first; nothing was typed, but the answer is the same.
        if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
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
        for _ in 0..<30 {
            if toast.exists { outcome = "toast"; break }
            if !screen.exists { outcome = "closed"; break }
            sleep(1)
        }
        capture("c5-after-save")
        if outcome.isEmpty { tree("c5-after-save") }
        keep("c-save-outcome", outcome.isEmpty ? "none" : (outcome == "toast" ? toast.label : outcome))
        XCTAssertFalse(outcome.isEmpty, "Tallenna kuitti neither saved (screen still up, no toast)")
        if outcome == "toast" {
            let window = app.windows.firstMatch.frame
            XCTAssertTrue(toast.label.contains("lasku"), "toast: \(toast.label)")
            XCTAssertGreaterThan(toast.frame.minY, window.height * 0.6, "the toast is at \(toast.frame.minY): not at the bottom")
        } else if (testRun?.totalFailureCount ?? 0) == 0 {
            // The server files a bill as an ostolasku only when the reading says "lasku", and only the
            // cloud AI reads the document type; CI never calls it, so this run saved a plain receipt.
            throw XCTSkip("(e) ostolasku toast: the demo API cannot read a bill without cloud AI; (b) and (c) passed, the save closed the screen")
        }
    }
}
