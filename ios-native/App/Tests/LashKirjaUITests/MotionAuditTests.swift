import XCTest

/// Simulator motion audit (docs/quality/SIMULATOR.md §4): every reachable screen and action, each
/// recorded as a short video by the host (`.rec` request, `simctl io recordVideo`) while the app's
/// MotionProbe (`-LKMotionAudit`) logs every layout change to probe.log. scripts/sim/motion-audit.py
/// then looks for intermediate screens, flashes, late layout shifts and dropped frames per step.
///
/// The walk records, it does not assert: a step whose target is missing is kept as "skipped" so
/// one absent label never hides the rest. Each suite starts from a fresh launch; run the suites
/// one by one on the slow iMac (scripts/sim/motion-audit.sh <suite>).
final class MotionAuditTests: WalkTestCase {
    /// Replaces `WalkTestCase.setUp`: the probe and the capture fixture need launch arguments.
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
        app.launchArguments += ["-LKUITest", "-LKMotionAudit"]
        app.launchEnvironment["LK_MOTION_LOG"] = "\(shotDir)/probe.log"
        // `-LKUITest` carries the launch-phase marker: sign-in waits for the app to settle, not 8 s.
        launchSignedIn()
        if app.buttons["Ei nyt"].waitForExistence(timeout: 5) { app.buttons["Ei nyt"].tap() }
        _ = app.tabBars.firstMatch.waitForExistence(timeout: 30)
        sleep(2); dismissSystemPrompts()
    }

    // MARK: Recording

    struct Step: Codable {
        var id: String, suite: String, from: String, action: String, to: String, kind: String
        var expect: String
        var tapAt: Double, doneAt: Double, recStart: Double?, recEnd: Double?
        var video: String?, reached: Bool, skipped: Bool
        var crashed: Bool? = nil
    }

    private var suite = ""

    /// Asks the host to record `seconds` of video, runs `action` once the recording runs, and adds
    /// the step to steps.json. `kind` tells the analyzer what motion is expected: "nav" (one
    /// destination), "sheet", "swap" (a state change in place), "scroll", "load".
    @discardableResult
    func step(_ id: String, from: String, to: String, kind: String = "nav", expect: String = "single destination",
              seconds: Int = 4, reached: (() -> Bool)? = nil, _ action: () -> Bool) -> Bool {
        sleep(1)
        let name = "\(shotDir)/m-\(id)"
        try? FileManager.default.removeItem(atPath: "\(name).recording")
        FileManager.default.createFile(atPath: "\(name).rec", contents: "\(seconds)".data(using: .utf8))
        // The host writes .recording once simctl says "Recording started".
        var started = false
        for _ in 0..<80 { if FileManager.default.fileExists(atPath: "\(name).recording") { started = true; break }; usleep(250_000) }
        // The first frames are the settled "from" screen.
        usleep(600_000)
        let tapAt = Date().timeIntervalSince1970
        let done = action()
        let doneAt = Date().timeIntervalSince1970
        // The recording ends by itself; the next step waits for it so videos never overlap.
        for _ in 0..<Int(seconds * 4 + 60) where FileManager.default.fileExists(atPath: "\(name).rec") { usleep(250_000) }
        // A crash or a hang the system killed: kept as its own finding, then the app comes back
        // signed in so the rest of the suite still runs.
        let crashed = app.state != .runningForeground
        if crashed { note("CRASH \(suite)/\(id): app state \(app.state.rawValue)") }
        let ok = !crashed && done && (reached?() ?? true)
        let times = (try? String(contentsOfFile: "\(name).recording", encoding: .utf8))?
            .split(separator: "\n").compactMap { Double($0) } ?? []
        save(Step(id: id, suite: suite, from: from, action: id, to: to, kind: kind, expect: expect,
                  tapAt: tapAt, doneAt: doneAt, recStart: times.first, recEnd: times.count > 1 ? times[1] : nil,
                  video: started ? "m-\(id).mov" : nil, reached: ok, skipped: !done, crashed: crashed))
        if crashed { setUp() }
        note("\(done ? (ok ? "STEP" : "MISS-TARGET") : "SKIP") \(suite)/\(id): \(from) -> \(to)")
        return done
    }

    private func save(_ step: Step) {
        let path = "\(shotDir)/steps.json"
        var all = (try? JSONDecoder().decode([Step].self, from: Data(contentsOf: URL(fileURLWithPath: path)))) ?? []
        all.append(step)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(all).write(to: URL(fileURLWithPath: path))
    }

    /// The host opens it (scripts/sim/run-ui.sh, also while a step records), as a notification would.
    func sendLink(_ url: String) {
        FileManager.default.createFile(atPath: "\(shotDir)/\(UUID().uuidString).openurl", contents: url.data(using: .utf8))
    }

    /// An invoice id from the demo API itself (the runner shares the Mac's loopback with the tunnel).
    func demoInvoiceId() -> String? {
        func call(_ path: String, _ body: [String: String]?, _ token: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
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
            _ = done.wait(timeout: .now() + 30)
            return result
        }
        // Test values from app/scripts/demo-seed.ts; only ever against the throwaway demo API.
        guard let token = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String,
              let list = call("/api/invoices?limit=5", nil, token)?["invoices"] as? [[String: Any]] else { return nil }
        return list.first { ($0["status"] as? String) != "draft" }?["id"] as? String ?? list.first?["id"] as? String
    }

    // MARK: Moves (each returns whether it could act, never waits for the result)

    func element(_ pred: String, _ arg: String, in scope: XCUIElement? = nil) -> XCUIElement {
        (scope ?? app).descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
    }
    /// A visible element by label (only under `scope` when given), scrolled to beforehand (outside
    /// the recording), or nil.
    func find(_ pred: String, _ arg: String, scrolls: Int = 6, in scope: XCUIElement? = nil) -> XCUIElement? {
        let e = element(pred, arg, in: scope)
        _ = e.waitForExistence(timeout: 10)
        for attempt in 0...scrolls {
            // Without scrolling (toolbar buttons, sheets) any hittable match will do.
            if e.exists && e.isHittable && (scrolls == 0 || (e.frame.minY > 90 && e.frame.maxY < app.windows.firstMatch.frame.maxY - 90)) { return e }
            if attempt == scrolls { break }
            app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1)
        }
        return e.exists && e.isHittable ? e : nil
    }
    func press(_ e: XCUIElement?) -> Bool {
        guard let e else { return false }
        e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); taps += 1
        return true
    }
    func navBar(_ title: String) -> () -> Bool { { self.app.navigationBars[title].waitForExistence(timeout: 8) } }
    func backButton() -> XCUIElement? {
        let b = app.navigationBars.firstMatch.buttons.element(boundBy: 0)
        return b.exists && b.isHittable ? b : nil
    }
    func scrollToTop() { app.statusBars.firstMatch.exists ? app.statusBars.firstMatch.tap() : (); sleep(1) }
    /// An item of the bar's Toiminnot, the menu opened before the recording; nil, the menu closed
    /// again, when it has no such item. The invoice's actions live there besides its primary (N6).
    func menuItem(_ label: String) -> XCUIElement? {
        guard press(find("label == %@", "Toiminnot", scrolls: 0)) else { return nil }
        if let item = find("label == %@", label, scrolls: 0) { return item }
        // At the leading edge, which the trailing menu never reaches.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        return nil
    }

    /// Tab switch as a recorded step.
    func tabStep(_ id: String, from: String, _ name: String) {
        step(id, from: from, to: "tab \(name)", reached: { self.app.tabBars.buttons[name].isSelected }) {
            press(app.tabBars.buttons[name].firstMatch)
        }
        sleep(2)
    }

    /// Push by label, record, then back and swipe-back as their own steps.
    func pushAndBack(_ id: String, from: String, label: String, title: String, pred: String = "label BEGINSWITH %@",
                     swipeBack: Bool = true, then extra: (() -> Void)? = nil) {
        guard let target = find(pred, label) else { note("SKIP \(suite)/\(id): no \(label)"); return }
        step("\(id)-open", from: from, to: title, seconds: 5, reached: navBar(title)) { press(target) }
        sleep(2)
        extra?()
        if swipeBack {
            step("\(id)-swipeback", from: title, to: from, kind: "nav") { edgeSwipeBack(); return true }
        } else {
            step("\(id)-back", from: title, to: from, kind: "nav") { press(backButton()) }
        }
        sleep(1)
    }

    // MARK: Suites, in order of the owner's impact

    func test01_Koti() {
        suite = "koti"
        tabStep("koti-from-myynti-setup", from: "launch", "Koti")
        step("koti-refresh", from: "Koti", to: "Koti", kind: "load", expect: "content stays put while refreshing", seconds: 5) {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            return true
        }
        sleep(2)
        step("koti-prev-month", from: "Koti", to: "Koti (previous month)", kind: "swap", expect: "month swaps in place", seconds: 5) {
            press(find("label == %@", "Edellinen kuukausi", scrolls: 0))
        }
        step("koti-next-month", from: "Koti (previous month)", to: "Koti", kind: "swap", expect: "month swaps in place", seconds: 5) {
            press(find("label == %@", "Seuraava kuukausi", scrolls: 0))
        }
        step("koti-scroll", from: "Koti", to: "Koti", kind: "scroll", expect: "list scrolls, nothing pops in") {
            app.windows.firstMatch.swipeUp(velocity: .fast); return true
        }
        sleep(2); scrollToTop()
        pushAndBack("koti-workqueue", from: "Koti", label: "Tuonnit ja virheet", title: "Tuonnit ja virheet")
        pushAndBack("koti-bank", from: "Koti", label: "Pankki", title: "Pankki")
        scrollToTop()
        step("koti-settings-sheet", from: "Koti", to: "Asetukset sheet", kind: "sheet", seconds: 5, reached: navBar("Asetukset")) {
            press(app.buttons["Asetukset"].firstMatch)
        }
        sleep(2)
        step("koti-settings-close", from: "Asetukset sheet", to: "Koti", kind: "sheet") { press(find("label == %@", "Valmis", scrolls: 0)) }
        step("koti-assistant-sheet", from: "Koti", to: "Avustaja", kind: "sheet", seconds: 5) {
            press(app.buttons["Avustaja"].firstMatch)
        }
        sleep(2)
        step("koti-assistant-swipedown", from: "Avustaja", to: "Koti", kind: "sheet") {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                .press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            return true
        }
        step("koti-add-sheet", from: "Koti", to: "Lisää sheet", kind: "sheet") { press(app.tabBars.buttons["Lisää"].firstMatch) }
        sleep(1)
        step("koti-add-close", from: "Lisää sheet", to: "Koti", kind: "sheet") {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap(); return true
        }
    }

    func test02_Myynti() {
        suite = "myynti"
        tabStep("myynti-tab", from: "Koti", "Myynti")
        tabStep("myynti-tab-revisit-koti", from: "Myynti", "Koti")
        tabStep("myynti-tab-revisit", from: "Koti", "Myynti")
        step("myynti-refresh", from: "Myynti", to: "Myynti", kind: "load", expect: "content stays put while refreshing", seconds: 5) {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            return true
        }
        sleep(2)
        pushAndBack("myynti-customers", from: "Myynti", label: "Asiakkaat", title: "Asiakkaat") {
            if let row = self.find("label CONTAINS %@", "Oy", scrolls: 0) {
                self.step("myynti-customer-open", from: "Asiakkaat", to: "Asiakas", seconds: 5) { self.press(row) }
                sleep(2)
                self.step("myynti-customer-back", from: "Asiakas", to: "Asiakkaat") { self.press(self.backButton()) }
            }
        }
        pushAndBack("myynti-recurring", from: "Myynti", label: "Toistuvat laskut", title: "Toistuvat laskut")
        if let late = find("label CONTAINS %@", "myöhässä", scrolls: 2) {
            step("myynti-filter-late", from: "Myynti", to: "Laskut (myöhässä)", kind: "swap", expect: "list swaps in place", seconds: 5) { press(late) }
            sleep(2)
        }
        if let invoice = find("label CONTAINS %@", "Lasku ", scrolls: 4) {
            step("myynti-invoice-open", from: "Myynti", to: "Lasku", seconds: 5) { press(invoice) }
            sleep(2)
            step("myynti-invoice-scroll", from: "Lasku", to: "Lasku", kind: "scroll", expect: "nothing pops in") {
                app.windows.firstMatch.swipeUp(velocity: .fast); return true
            }
            sleep(1)
            step("myynti-invoice-back", from: "Lasku", to: "Myynti") { press(backButton()) }
        }
        step("myynti-new-invoice", from: "Myynti", to: "Uusi lasku", kind: "sheet", seconds: 5, reached: navBar("Uusi lasku")) {
            press(app.buttons["Uusi lasku"].firstMatch)
        }
        sleep(2)
        step("myynti-new-invoice-cancel", from: "Uusi lasku", to: "Myynti", kind: "sheet") {
            press(find("label == %@", "Peruuta", scrolls: 0))
        }
        if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
        step("myynti-list-scroll", from: "Myynti", to: "Myynti", kind: "scroll", expect: "list scrolls, nothing pops in") {
            app.windows.firstMatch.swipeUp(velocity: .fast); return true
        }
        sleep(1)
        if let more = find("label BEGINSWITH %@", "Näytä enemmän", scrolls: 8) {
            step("myynti-load-more", from: "Myynti", to: "Myynti (more rows)", kind: "load", expect: "rows grow below, nothing above moves", seconds: 5) { press(more) }
        }
    }

    func test03_Raportit() {
        suite = "raportit"
        tabStep("raportit-tab", from: "Koti", "Raportit")
        step("raportit-prev-year", from: "Raportit", to: "Raportit (previous year)", kind: "swap", expect: "year swaps in place", seconds: 5) {
            press(find("label == %@", "Edellinen vuosi", scrolls: 0))
        }
        step("raportit-next-year", from: "Raportit (previous year)", to: "Raportit", kind: "swap", expect: "year swaps in place", seconds: 5) {
            press(find("label == %@", "Seuraava vuosi", scrolls: 0))
        }
        step("raportit-refresh", from: "Raportit", to: "Raportit", kind: "load", expect: "content stays put while refreshing", seconds: 5) {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            return true
        }
        sleep(2)
        // A figure of the report, looked for in its list: over the whole app "Myynti" found the tab
        // bar's button, and the step measured a tab switch instead of a drill-down.
        if let drill = find("label BEGINSWITH %@", "Menot", scrolls: 2, in: app.collectionViews.firstMatch) {
            step("raportit-drill-open", from: "Raportit", to: "drill-down", seconds: 5,
                 reached: { self.app.tabBars.buttons["Raportit"].isSelected && self.backButton() != nil }) { press(drill) }
            sleep(2)
            step("raportit-drill-swipeback", from: "drill-down", to: "Raportit") { edgeSwipeBack(); return true }
        }
        step("raportit-scroll", from: "Raportit", to: "Raportit", kind: "scroll", expect: "nothing pops in") {
            app.windows.firstMatch.swipeUp(velocity: .fast); return true
        }
        sleep(1)
        if let picker = find("label BEGINSWITH %@", "Luokittain", scrolls: 4) {
            step("raportit-category-picker", from: "Raportit", to: "Raportit (other category)", kind: "swap", seconds: 5) {
                // The segmented picker: its second segment.
                let seg = picker.buttons.element(boundBy: 1)
                return press(seg.exists ? seg : picker)
            }
        }
        if let zip = find("label BEGINSWITH %@", "Lataa zip", scrolls: 6) {
            step("raportit-zip-sheet", from: "Raportit", to: "zip sheet", kind: "sheet", seconds: 5) { press(zip) }
            sleep(2)
            step("raportit-zip-close", from: "zip sheet", to: "Raportit", kind: "sheet") {
                let w = app.windows.firstMatch
                w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                    .press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
                return true
            }
        }
    }

    func test04_Asetukset() {
        suite = "asetukset"
        step("asetukset-open", from: "Koti", to: "Asetukset sheet", kind: "sheet", seconds: 5, reached: navBar("Asetukset")) {
            press(app.buttons["Asetukset"].firstMatch)
        }
        sleep(2)
        for (id, label) in [("seller", "Laskuttajan tiedot"), ("templates", "Sähköpostimallit"), ("payments", "Maksut"),
                            ("password", "Vaihda salasana"), ("passkeys", "Pääsyavaimet"), ("devices", "Laitteet"),
                            ("lock", "Sovelluslukitus"), ("notifications", "Ilmoitukset"), ("privacy", "Tietosuoja"),
                            ("help", "Ohje"), ("report", "Ilmoita ongelmasta")] {
            guard let row = find("label BEGINSWITH %@", label) else { note("SKIP asetukset/\(id): no \(label)"); continue }
            step("asetukset-\(id)-open", from: "Asetukset", to: label, seconds: 5) { press(row) }
            sleep(2)
            step("asetukset-\(id)-back", from: label, to: "Asetukset") { press(backButton()) }
            if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
        }
        scrollToTop()
        step("asetukset-close", from: "Asetukset sheet", to: "Koti", kind: "sheet") { press(find("label == %@", "Valmis", scrolls: 0)) }
    }

    func test05_Chat() {
        suite = "chat"
        step("chat-open", from: "Koti", to: "Avustaja", kind: "sheet", seconds: 5) { press(app.buttons["Avustaja"].firstMatch) }
        sleep(3)
        let field = app.textFields.firstMatch.exists ? app.textFields.firstMatch : app.textViews.firstMatch
        if field.waitForExistence(timeout: 5) {
            step("chat-focus", from: "Avustaja", to: "Avustaja (keyboard)", kind: "swap", expect: "keyboard rises, messages stay pinned") {
                field.tap(); return true
            }
            field.typeText("Paljonko myin tässä kuussa?")
            step("chat-send", from: "Avustaja", to: "Avustaja (answer)", kind: "load", expect: "answer appears below, nothing above jumps", seconds: 8) {
                let send = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Lähetä", "Send")).firstMatch
                if send.exists { send.tap(); return true }
                field.typeText("\n"); return true
            }
        }
        step("chat-close", from: "Avustaja", to: "Koti", kind: "sheet") {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                .press(forDuration: 0.1, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
            return true
        }
    }

    func test06_SalesInvoiceFlow() {
        suite = "lasku"
        tab("Myynti")
        step("lasku-new", from: "Myynti", to: "Uusi lasku", kind: "sheet", seconds: 5, reached: navBar("Uusi lasku")) {
            press(app.buttons["Uusi lasku"].firstMatch)
        }
        sleep(2)
        if let customer = find("label BEGINSWITH %@", "Asiakas", scrolls: 0) {
            step("lasku-customer-picker", from: "Uusi lasku", to: "asiakasvalinta", seconds: 5) { press(customer) }
            sleep(2)
            if let first = find("label CONTAINS %@", "Oy", scrolls: 0) {
                step("lasku-customer-pick", from: "asiakasvalinta", to: "Uusi lasku", expect: "back to the form, filled") { press(first) }
            } else {
                step("lasku-customer-cancel", from: "asiakasvalinta", to: "Uusi lasku") { press(backButton()) }
            }
        }
        step("lasku-form-scroll", from: "Uusi lasku", to: "Uusi lasku", kind: "scroll", expect: "nothing pops in") {
            app.windows.firstMatch.swipeUp(velocity: .fast); return true
        }
        step("lasku-cancel", from: "Uusi lasku", to: "Myynti", kind: "sheet") { press(find("label == %@", "Peruuta", scrolls: 0)) }
        if let discard = find("label == %@", "Hylkää muutokset", scrolls: 0) {
            step("lasku-discard", from: "Hylätäänkö muutokset?", to: "Myynti", kind: "sheet") { press(discard) }
        }
        // An existing invoice: the payment sheet and the copy action (which opens the form).
        if let invoice = find("label CONTAINS %@", "Lasku ", scrolls: 4) {
            step("lasku-open", from: "Myynti", to: "Lasku", seconds: 5) { press(invoice) }
            sleep(2)
            // The primary when the invoice waits for its payment, else a Toiminnot item: the Maksu and
            // Kopioi tiles are gone (N6).
            if let pay = find("label == %@", "Kirjaa maksu", scrolls: 0) ?? menuItem("Kirjaa maksu") {
                step("lasku-payment-sheet", from: "Lasku", to: "Kirjaa maksu", kind: "sheet", seconds: 5) { press(pay) }
                sleep(1)
                step("lasku-payment-cancel", from: "Kirjaa maksu", to: "Lasku", kind: "sheet") { press(find("label == %@", "Peruuta", scrolls: 0)) }
            }
            if let copy = menuItem("Kopioi luonnokseksi") {
                step("lasku-copy", from: "Lasku", to: "Uusi lasku (copy)", kind: "sheet", seconds: 5) { press(copy) }
                sleep(2)
                step("lasku-copy-cancel", from: "Uusi lasku (copy)", to: "Lasku", kind: "sheet") { press(find("label == %@", "Peruuta", scrolls: 0)) }
                if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
            }
            step("lasku-back", from: "Lasku", to: "Myynti") { press(backButton()) }
        }
    }

    func test07_Bank() {
        suite = "pankki"
        tabStep("pankki-kirjanpito-tab", from: "Koti", "Kirjanpito")
        guard let pankki = find("label BEGINSWITH %@", "Pankki") else { note("SKIP pankki: no Pankki row"); return }
        // One push to the rows (N2): the hub's open and its "Näytä kaikki" push were two.
        step("pankki-open", from: "Kirjanpito", to: "Pankki", seconds: 5, reached: navBar("Pankki")) { press(pankki) }
        sleep(2)
        // The first row, while it is at the top: Saldo yhteensä opens Pankkiyhteys ja tilit.
        if let accounts = find("label BEGINSWITH %@", "Saldo yhteensä", scrolls: 4) {
            step("pankki-accounts-open", from: "Pankki", to: "Pankkiyhteys ja tilit", seconds: 5) { press(accounts) }
            sleep(2)
            step("pankki-accounts-back", from: "Pankkiyhteys ja tilit", to: "Pankki") { press(backButton()) }
        }
        step("pankki-feed-scroll", from: "Pankki", to: "Pankki", kind: "scroll", expect: "nothing pops in") {
            app.windows.firstMatch.swipeUp(velocity: .fast); return true
        }
        if let more = find("label BEGINSWITH %@", "Näytä enemmän", scrolls: 8) {
            step("pankki-feed-more", from: "Pankki", to: "Pankki (more)", kind: "load",
                 expect: "rows grow below, nothing above moves", seconds: 5) { press(more) }
        }
        step("pankki-back", from: "Pankki", to: "Kirjanpito") { press(backButton()) }
        for (id, label) in [("email", "Sähköposti"), ("purchases", "Ostolaskut"), ("match", "Kohdista ostolaskujen maksut"),
                            ("periods", "Kuukauden sulku"), ("alv", "ALV-ilmoitus"), ("ledger", "Kirjanpito, Tuloslaskelma")] {
            guard let row = find("label BEGINSWITH %@", label) else { note("SKIP pankki/\(id): no \(label)"); continue }
            step("kirjanpito-\(id)-open", from: "Kirjanpito", to: label, seconds: 5) { press(row) }
            sleep(3)
            step("kirjanpito-\(id)-back", from: label, to: "Kirjanpito") { edgeSwipeBack(); return true }
            sleep(1)
        }
    }

    /// Offline: the banner and the cached screens (scripts/sim/api-proxy.py drops every connection).
    func test08_Offline() {
        suite = "offline"
        goOffline()
        step("offline-tab-myynti", from: "Koti", to: "tab Myynti (offline)", kind: "nav", expect: "cached list, banner without shift", seconds: 5) {
            press(app.tabBars.buttons["Myynti"].firstMatch)
        }
        sleep(2)
        step("offline-refresh", from: "Myynti", to: "Myynti (offline error)", kind: "load", expect: "error without shift", seconds: 6) {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            return true
        }
        goOnline()
        step("online-again", from: "Myynti (offline)", to: "Myynti", kind: "load", expect: "banner leaves without shift", seconds: 8) {
            let w = app.windows.firstMatch
            w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: w.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
            return true
        }
    }

    /// Steps known to be good and known to be bad on `native`, to calibrate the analyzer.
    /// Bad: the w32 brief's item 7 (the upload screen moves once the reading finishes) and item 9
    /// ("Näytä tarkistettavat": the cover closes, the tab switches and Kuitit is pushed, each shown).
    func test00_Calibration() {
        suite = "calibration"
        // Good: a plain tab switch, a plain push and its swipe-back.
        tabStep("good-tab-kirjanpito", from: "Koti", "Kirjanpito")
        if let row = find("label BEGINSWITH %@", "Kuukauden sulku") {
            step("good-push-periods", from: "Kirjanpito", to: "Kuukauden sulku", seconds: 5) { press(row) }
            sleep(3)
            step("good-swipeback-periods", from: "Kuukauden sulku", to: "Kirjanpito") { edgeSwipeBack(); return true }
        }
        // Bad (item 9's mechanism, AppModel.pendingRoute): a link to an invoice while the Asetukset
        // sheet is up closes the sheet, switches to Myynti and pushes the invoice, each animated.
        if let id = demoInvoiceId() {
            let link = "lashkirja://invoice/\(id)"
            let invoice = app.navigationBars.matching(NSPredicate(format: "identifier CONTAINS[c] %@", "lasku")).firstMatch
            // iOS asks "Open in LashKirja?" the first time a link reaches an install, and every walk
            // is a fresh install: answered here, outside the recording, so the step films the app.
            sendLink(link)
            let open = springboard.buttons["Open"]
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline && !invoice.exists {
                if open.exists { open.tap(); break }
                usleep(250_000)
            }
            if invoice.waitForExistence(timeout: 15) { edgeSwipeBack(); sleep(1) } else { note("calibration: the first link opened no invoice") }
            tab("Koti")
            press(app.buttons["Asetukset"].firstMatch); _ = app.navigationBars["Asetukset"].waitForExistence(timeout: 8); sleep(2)
            step("bad-link-over-sheet", from: "Asetukset sheet on Koti", to: "Lasku (Myynti)", seconds: 7,
                 reached: { invoice.waitForExistence(timeout: 8) && !self.app.navigationBars["Asetukset"].exists }) {
                sendLink(link)
                if open.waitForExistence(timeout: 3) { open.tap() }
                return true
            }
            sleep(2)
            // A link that did not open leaves the sheet over the tabs, and the rest of the walk
            // (items 7 and 9) would tap through it.
            if app.navigationBars["Asetukset"].exists { swipeSheetDown("Asetukset"); sleep(1) }
            tab("Kirjanpito")
        }
        // Bad (item 7): the capture fixture uploads and is read; the screen moves as rows finish.
        guard let receipts = find("label BEGINSWITH %@", "Kuitit") else { note("SKIP calibration: no Kuitit"); return }
        press(receipts); _ = app.navigationBars["Kuitit"].waitForExistence(timeout: 10); sleep(3)
        let camera = app.navigationBars["Kuitit"].buttons["Kuvaa kuitti"]
        press(camera.exists ? camera : app.buttons["Kuvaa kuitti"].firstMatch)
        let fixture = app.buttons["capture-fixture"].firstMatch
        guard fixture.waitForExistence(timeout: 10) else { note("SKIP calibration: no capture fixture"); return }
        if !fixture.isHittable { app.swipeUp(); sleep(1) }
        step("bad-capture-upload", from: "Uusi kuitti", to: "Uusi kuitti (read)", kind: "load",
             expect: "rows finish in place, the screen does not move", seconds: 14) { press(fixture) }
        saveReviewRow()
        // Bad (item 9): the summary's way to Kuitit.
        if let go = find("label BEGINSWITH %@", "Näytä tarkistettavat", scrolls: 3) ?? find("label BEGINSWITH %@", "Siirry kuitteihin", scrolls: 3) {
            step("bad-show-review", from: "Uusi kuitti", to: "Kuitit", seconds: 6, reached: navBar("Kuitit")) { press(go) }
        } else {
            note("SKIP calibration/bad-show-review: no Näytä tarkistettavat / Siirry kuitteihin")
            dump(app, "calibration-no-review-button")
        }
    }

    /// Item 9's button, "Näytä tarkistettavat", shows only once the queue has settled with a saved
    /// receipt the server left for review, and the last save of a queue closes the screen. So the
    /// first reading is kept in the queue (Takaisin) and a second copy of the fixture is added: with
    /// two rows its reading takes the several-files path (`AutoAccept.takesAutoSavePath`) and is
    /// saved at once, pending review, or, when the server refuses an empty reading, waits behind
    /// "Avaa lomake" and is saved there as OwnerScreensTests.testC does (dummy data; the walk's demo
    /// API reads nothing). It never offers "Käytä lomakkeessa": runs 39056167779 and 39056964743
    /// waited 90 s for that one. The first row is then dropped with "Hylkää tallentamattomat".
    /// Outside any recording; a miss is noted with the element tree.
    func saveReviewRow() {
        let vendor = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Myyjä", "Myyjä")).firstMatch
        let use = app.buttons.matching(NSPredicate(format: "label == %@", "Käytä lomakkeessa"))
        // The reading opens the form by itself; Takaisin keeps its row in the queue.
        if vendor.waitForExistence(timeout: 60) {
            press(app.buttons["Takaisin"].firstMatch)
            let discard = app.buttons["Hylkää muutokset"].firstMatch
            if discard.waitForExistence(timeout: 3) { discard.tap() }
        }
        guard use.firstMatch.waitForExistence(timeout: 30) else {
            note("calibration: the read row offers no Käytä lomakkeessa"); dump(app, "calibration-first-row"); return
        }
        // An element tap, not `press`: a coordinate tap right after a swipe lands on the list
        // still scrolling and only stops it.
        guard let fixture = find("identifier == %@", "capture-fixture", scrolls: 4) else {
            note("calibration: no capture fixture under the queue"); dump(app, "calibration-second-fixture"); return
        }
        fixture.tap()
        // The row's own line ("Odottaa tarkistusta", or the duplicate's): the summary under the
        // queue says "1 odottaa tarkistusta" already for the first, unsaved row.
        let pending = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@",
                                                           "Odottaa tarkistusta", "Samanlainen kuitti on jo tallennettu")).firstMatch
        let refused = app.buttons["Avaa lomake"].firstMatch
        let approved = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Hyväksytty automaattisesti")).firstMatch
        guard let outcome = firstOf([pending, refused, approved], timeout: 90) else {
            note("calibration: the second fixture was not read"); dump(app, "calibration-second-fixture"); return
        }
        guard outcome !== approved else {
            note("calibration: the second fixture was approved, nothing waits for review"); dump(app, "calibration-second-fixture"); return
        }
        if outcome === refused {
            if !refused.isHittable { app.swipeDown() }
            refused.tap()
            guard vendor.waitForExistence(timeout: 10) else { note("calibration: Avaa lomake opened no form"); dump(app, "calibration-refused-form"); return }
            guard fillAndSave(vendor) else { return }
            guard pending.waitForExistence(timeout: 30) else { note("calibration: the save left no row for review"); dump(app, "calibration-after-save"); return }
        }
        let actions = app.buttons["Toiminnot"].firstMatch
        guard actions.waitForExistence(timeout: 30) else { note("calibration: no Toiminnot on the queue"); dump(app, "calibration-after-save"); return }
        actions.tap()
        let drop = app.buttons["Hylkää tallentamattomat"].firstMatch
        guard drop.waitForExistence(timeout: 5) else { note("calibration: no Hylkää tallentamattomat"); dump(app, "calibration-drop"); return }
        drop.tap()
        let confirm = app.buttons["confirm-sheet-confirm"].firstMatch
        if confirm.waitForExistence(timeout: 5) { confirm.tap(); _ = confirm.waitForNonExistence(timeout: 5) }
    }

    /// The first of `elements` to exist within `timeout`, or nil. Asks `exists` itself, as
    /// OwnerScreensTests.waitGone does; the last answer is taken after the deadline.
    func firstOf(_ elements: [XCUIElement], timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let hit = elements.first(where: { $0.exists }) { return hit }
            usleep(250_000)
        }
        return elements.first(where: { $0.exists })
    }

    /// The form a refused reading opened: dummy vendor, sum and category, then "Tallenna kuitti".
    /// The first row is still unsaved, so the save returns to the queue.
    func fillAndSave(_ vendor: XCUIElement) -> Bool {
        func blank(_ field: XCUIElement, _ placeholder: String) -> Bool {
            let value = (field.value as? String) ?? ""
            return value.isEmpty || value == placeholder
        }
        if blank(vendor, "Myyjä") { type(vendor, "Testikauppa Oy") }
        let total = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Summa €", "Summa €")).firstMatch
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && blank(total, "Summa €") { type(total, "12") }
        // The keyboard's Valmis: the queue's own Valmis is not on screen while the form is.
        let done = app.buttons["Valmis"].firstMatch
        if done.exists { done.tap(); _ = done.waitForNonExistence(timeout: 3) }
        // Category is required and only the cloud AI suggests one.
        let category = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Kategoria, ")).firstMatch
        if category.waitForExistence(timeout: 5), category.label.hasSuffix("Valitse") {
            if !category.isHittable { app.swipeUp() }
            category.tap()
            let choice = app.buttons["Tarvikkeet & ostot"].firstMatch
            if choice.waitForExistence(timeout: 5) { choice.tap() }
        }
        guard tap("Tallenna kuitti") else { note("calibration: no Tallenna kuitti"); dump(app, "calibration-no-save"); return false }
        return true
    }
}
