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
        // The one-time notification question stands answered: on the first walk of a fresh
        // simulator it rose over the baseline's steps (M000). First, so no value-less flag before
        // it is read as taking the key for its value.
        app.launchArguments += ["-notifications.asked.v1", "YES", "-LKUITest", "-LKMotionAudit"]
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
        /// When the element was resolved, and when the app's probe saw the finger come down.
        var foundAt: Double? = nil, touchAt: Double? = nil
        /// Whether the action put a finger on the app (a link or typed text does not).
        var pressed: Bool? = nil
    }

    private var suite = ""
    /// The step's own touch, set by `press` and `touching`: when its element was resolved, when the
    /// touch went out, and whether it was a finger on the app.
    private var stamp: (found: Double, tap: Double, finger: Bool)?
    /// The longest a recording runs; run-ui.sh caps it there too.
    static let recordCap = 30.0

    /// Asks the host to record, runs `action` once the recording runs, and adds the step to
    /// steps.json. `kind` tells the analyzer what motion is expected: "nav" (one destination),
    /// "sheet", "swap" (a state change in place), "scroll", "load".
    ///
    /// The action resolves its element before it stamps the tap (`press`, `touching`): stamped
    /// first, the step's t = 0 held 1–4 s of XCUITest looking for the element (M046, M056). The
    /// app's probe line for the touch (TOUCH) is when it came in. The recording runs `seconds` past
    /// the action, past a presentation's 'MARK presented' (`presents`) and past `until`, then asks
    /// the host to stop: a fixed length ended before a presentation the main thread held back, and
    /// the step filmed nothing (M026, M029, M096).
    ///
    /// A step whose `reached` says no is MISS-TARGET, and `recover` takes the walk back to where
    /// the next steps expect it: a cancelled pop read STEP and the walk went on measuring the wrong
    /// screen (M001, M043). Returns whether the step ran and reached its target.
    @discardableResult
    func step(_ id: String, from: String, to: String, kind: String = "nav", expect: String = "single destination",
              seconds: Int = 4, presents: Bool = false, until: (() -> Bool)? = nil,
              reached: (() -> Bool)? = nil, recover: (() -> Void)? = nil, _ action: () -> Bool) -> Bool {
        sleep(1)
        let name = "\(shotDir)/m-\(id)"
        for leftover in ["recording", "stop"] { try? FileManager.default.removeItem(atPath: "\(name).\(leftover)") }
        FileManager.default.createFile(atPath: "\(name).rec", contents: "\(Int(Self.recordCap))".data(using: .utf8))
        // The host writes .recording once simctl says "Recording started", or after its 150 looks
        // for that line. On a loaded runner it came 20 and 38 s after the request (the first step
        // of both PR walks in gate 39659357338), past a 20 s wait here: the step went on without
        // counting the video the host still recorded, and read NO-MOTION.
        var started = false
        for _ in 0..<240 { if FileManager.default.fileExists(atPath: "\(name).recording") { started = true; break }; usleep(250_000) }
        // The first frames are the settled "from" screen.
        usleep(600_000)
        let probe = ProbeTail()
        let askedAt = Date().timeIntervalSince1970
        // The host stops at its cap whatever this asks; a second is kept for its own stop.
        let cap = (recording(name).first ?? askedAt) + Self.recordCap - 1
        stamp = nil
        xcui("begin", id)
        let done = action()
        let doneAt = Date().timeIntervalSince1970
        xcui("end", id)
        let tapAt = stamp?.tap ?? askedAt, foundAt = stamp?.found ?? askedAt, pressed = stamp?.finger ?? false
        var stopAt = doneAt + Double(seconds)
        // Two seconds of the sheet after the main thread let it go: it rose 2.7–6.8 s after the
        // tap, past a fixed recording (M026, run 39322652535).
        if done, presents, let mark = probe.first("MARK", "presented", after: tapAt, deadline: min(cap - 2, tapAt + 20)) {
            stopAt = max(stopAt, mark + 2)
        }
        if done, let until {
            xcui("begin", "\(id).until")
            _ = until()
            xcui("end", "\(id).until")
            stopAt = max(stopAt, Date().timeIntervalSince1970 + 1.5)
        }
        while Date().timeIntervalSince1970 < min(stopAt, cap) { usleep(100_000) }
        FileManager.default.createFile(atPath: "\(name).stop", contents: nil)
        // The next step waits for the host to end this one, so videos never overlap.
        let ended = Date().addingTimeInterval(started ? max(0, cap + 1 - Date().timeIntervalSince1970) + 15 : 15)
        while Date() < ended && FileManager.default.fileExists(atPath: "\(name).rec") { usleep(250_000) }
        let touchAt = pressed ? probe.first("TOUCH", after: tapAt - 0.05) : nil
        // A crash or a hang the system killed: kept as its own finding, then the app comes back
        // signed in so the rest of the suite still runs.
        let crashed = app.state != .runningForeground
        if crashed { note("CRASH \(suite)/\(id): app state \(app.state.rawValue)") }
        let ok = !crashed && done && (reached?() ?? true)
        let times = recording(name)
        let recEnd = times.count > 1 ? times[1] : nil
        save(Step(id: id, suite: suite, from: from, action: id, to: to, kind: kind, expect: expect,
                  tapAt: tapAt, doneAt: doneAt, recStart: times.first, recEnd: recEnd,
                  video: started ? "m-\(id).mov" : nil, reached: ok, skipped: !done, crashed: crashed,
                  foundAt: foundAt, touchAt: touchAt, pressed: pressed))
        if crashed { setUp() }
        note("\(done ? (ok ? "STEP" : "MISS-TARGET") : "SKIP") \(suite)/\(id): \(from) -> \(to)")
        if done, let recEnd, recEnd < doneAt + 1 {
            note("MISS-WINDOW \(suite)/\(id): the recording ended \(String(format: "%.1f", recEnd - doneAt)) s after the action")
        }
        if done && !crashed && !ok, let recover {
            recover()
            note("RECOVER \(suite)/\(id)")
        }
        return ok
    }

    /// The host's start and stop epoch times for `name` (run-ui.sh), as far as written.
    private func recording(_ name: String) -> [Double] {
        (try? String(contentsOfFile: "\(name).recording", encoding: .utf8))?
            .split(separator: "\n").compactMap { Double($0) } ?? []
    }

    /// 'XCUI begin|end <t> <step>' in xcui.log: the stretches XCUITest drove the app inside a
    /// recording. Its element snapshots run on the app's main thread, so a STALL there is the
    /// harness's, not the app's (M003, M041, M069, M098).
    private func xcui(_ edge: String, _ id: String) {
        let path = "\(shotDir)/xcui.log"
        let line = "XCUI \(edge) \(String(format: "%.3f", Date().timeIntervalSince1970)) \(id)\n".data(using: .utf8)!
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line); h.closeFile() }
        else { FileManager.default.createFile(atPath: path, contents: line) }
    }

    /// probe.log from the moment a step began: the app's own MARK and TOUCH lines, read without
    /// asking XCUITest (whose snapshots would hold the main thread the step is filming).
    struct ProbeTail {
        /// Where the app writes it (LK_MOTION_LOG); a probe that could not write there leaves it in
        /// its container, read only after the walk, and the step then films its fixed length.
        static var path: String { "\(shotDir)/probe.log" }
        let offset: UInt64 = ((try? FileManager.default.attributesOfItem(atPath: ProbeTail.path))?[.size] as? NSNumber)?.uint64Value ?? 0

        /// The time of the first '<kind> <t> <name>' line at or after `after` (only `name` when
        /// given), looked for again until `deadline`, or once when there is none.
        func first(_ kind: String, _ name: String? = nil, after: Double, deadline: Double? = nil) -> Double? {
            guard FileManager.default.fileExists(atPath: Self.path) else { return nil }
            while true {
                if let handle = FileHandle(forReadingAtPath: Self.path) {
                    defer { try? handle.close() }
                    try? handle.seek(toOffset: offset)
                    let text = String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
                    for line in text.split(separator: "\n") {
                        let parts = line.split(separator: " ")
                        guard parts.count >= 3, parts[0] == kind, let t = Double(parts[1]), t >= after else { continue }
                        if let name, parts[2] != name { continue }
                        return t
                    }
                }
                guard let deadline, Date().timeIntervalSince1970 < deadline else { return nil }
                usleep(200_000)
            }
        }
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

    func element(_ pred: String, _ args: [Any], type: XCUIElement.ElementType, in scope: XCUIElement? = nil) -> XCUIElement {
        (scope ?? app).descendants(matching: type).matching(NSPredicate(format: pred, argumentArray: args)).firstMatch
    }
    /// A visible element of `type` whose label matches (only under `scope` when given), scrolled to
    /// beforehand (outside the recording), or nil. A button unless said: over any element type the
    /// first match was a section header or a row's own text with the same words, and the step
    /// pressed something that does nothing (M044, M051, M094).
    func find(_ pred: String, _ args: Any..., type: XCUIElement.ElementType = .button, scrolls: Int = 6,
              in scope: XCUIElement? = nil) -> XCUIElement? {
        let e = element(pred, args, type: type, in: scope)
        _ = e.waitForExistence(timeout: 10)
        for attempt in 0...scrolls {
            // Without scrolling (toolbar buttons, sheets) any hittable match will do.
            if e.exists && e.isHittable && (scrolls == 0 || inside(e)) { return e }
            if attempt == scrolls { break }
            app.windows.firstMatch.swipeUp(velocity: .slow); sleep(1)
        }
        return e.exists && e.isHittable ? e : nil
    }
    /// Clear of the bars. The frame comes from a snapshot: a row that left after `exists` answered
    /// fails the snapshot, where reading `frame` failed the test (M005).
    private func inside(_ e: XCUIElement) -> Bool {
        guard let frame = try? e.snapshot().frame else { return false }
        return frame.minY > 90 && frame.maxY < app.windows.firstMatch.frame.maxY - 90
    }
    /// A row by its title: "<title>, <subtitle>", or the title alone where a row has no subtitle.
    static let titled = "label == %@ OR label BEGINSWITH %@"
    func row(_ title: String, scrolls: Int = 6) -> XCUIElement? { find(Self.titled, title, title + ",", scrolls: scrolls) }

    /// Stamps the step's touch going out, once its element is resolved; a step's first touch counts.
    func touching(found: Double? = nil, finger: Bool = true) {
        let now = Date().timeIntervalSince1970
        if stamp == nil { stamp = (found ?? now, now, finger) }
    }
    /// Taps the middle of `e` once it exists and is hittable; false (the step is SKIP) when it is
    /// not: a tap on a missing element threw and ended the whole suite (M005, M027). The frame comes
    /// from a snapshot and the tap goes to that point of the window, so XCUITest has nothing of `e`
    /// left to resolve after the stamp.
    @discardableResult
    func press(_ e: XCUIElement?) -> Bool {
        guard let e, e.exists, e.isHittable, let frame = try? e.snapshot().frame else { return false }
        let found = Date().timeIntervalSince1970
        let window = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
        touching(found: found)
        window.withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap(); taps += 1
        return true
    }
    /// A drag across the window between two normalized points, stamped as a press is.
    @discardableResult
    func drag(from a: CGVector, to b: CGVector, hold: TimeInterval = 0.1) -> Bool {
        let w = app.windows.firstMatch
        let start = w.coordinate(withNormalizedOffset: a), end = w.coordinate(withNormalizedOffset: b)
        touching()
        start.press(forDuration: hold, thenDragTo: end)
        return true
    }
    func tapWindow(_ at: CGVector) -> Bool {
        let point = app.windows.firstMatch.coordinate(withNormalizedOffset: at)
        touching()
        point.tap()
        return true
    }
    func flingUp() -> Bool {
        let w = app.windows.firstMatch
        touching()
        w.swipeUp(velocity: .fast)
        return true
    }
    /// Pull to refresh from the first list cell, where a thumb starts it: from 25 % of the window
    /// the drag began on Myynti's search field and pulled nothing (M030, M083). A screen without
    /// list cells (Koti) is pulled from there still.
    func pullToRefresh() -> Bool {
        let w = app.windows.firstMatch
        let window = w.frame
        let cell = app.cells.firstMatch
        var top = CGPoint(x: window.midX, y: window.height * 0.25)
        if cell.exists, cell.isHittable, let frame = try? cell.snapshot().frame,
           frame.midY > 0, frame.midY < window.height * 0.5 {
            top = CGPoint(x: frame.midX, y: frame.midY)
        }
        let origin = w.coordinate(withNormalizedOffset: .zero)
        touching()
        origin.withOffset(CGVector(dx: top.x, dy: top.y))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: top.x, dy: top.y + window.height * 0.5)))
        return true
    }
    /// WalkTestCase's swipe, stamped as a step's touch. The gesture is written out here as well:
    /// the gate's baseline walk builds this file over native's WalkTestCase, and all three walks
    /// must swipe alike.
    override func edgeSwipeBack() { swipeFromEdge(to: 0.85) }
    /// From the left edge to `x` of the width, pressed 0.1 s, dragged slowly and held 0.3 s before
    /// the release, so where the finger stops decides the pop: released while moving, the pop was
    /// cancelled at about 46 % on the slow simulator (M001).
    func swipeFromEdge(to x: CGFloat) {
        let w = app.windows.firstMatch
        let start = w.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = w.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5))
        touching()
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
    }

    func navBar(_ title: String) -> () -> Bool { { self.app.navigationBars[title].waitForExistence(timeout: 8) } }
    /// `e` has left: a sheet's own bar, or a screen a push covered.
    func gone(_ e: XCUIElement) -> () -> Bool { { e.waitForNonExistence(timeout: 8) } }
    /// The back button of the screen on top. Not a bar's first button: that was Valmis on a sheet's
    /// root (M051) and the ⋯ menu on a tab's root.
    func backButton() -> XCUIElement? {
        app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex.first { $0.isHittable }
    }
    /// Any back button: a pushed screen has one and a tab's root none, where titles cannot tell the
    /// ledger ('Kirjanpito') from the root it is pushed on.
    var anyBack: XCUIElement { app.navigationBars.buttons.matching(identifier: "BackButton").firstMatch }
    /// Elements only these roots show, so a back step knows it came home.
    var kotiHome: XCUIElement { app.buttons["Edellinen kuukausi"] }
    var myyntiHome: XCUIElement { app.navigationBars["Myynti"] }
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

    /// Back to `home` outside any recording: a discard question answered, else the back button, at
    /// most twice. A walk left on the wrong screen measured it in place of the next steps (M043).
    func goBack(until home: XCUIElement) {
        for _ in 0..<2 where !home.exists {
            let discard = app.buttons["Hylkää muutokset"]
            if discard.exists { discard.tap() } else if let back = backButton() { back.tap() } else { break }
            _ = home.waitForExistence(timeout: 5)
        }
    }

    /// Tab switch as a recorded step.
    func tabStep(_ id: String, from: String, _ name: String) {
        step(id, from: from, to: "tab \(name)", reached: { self.app.tabBars.buttons[name].isSelected },
             recover: { _ = self.selectTab(name) }) {
            press(app.tabBars.buttons[name].firstMatch)
        }
        sleep(2)
    }

    /// Push `target`, record, then back or swipe-back as its own step. The open must reach `title`
    /// and the back must bring back `home` (an element only `from` shows), or the step is
    /// MISS-TARGET: a missed open is undone and its back step skipped, a missed back is finished
    /// with the back button (M001, M022, M043).
    func pushAndBack(_ id: String, from: String, to title: String, target: XCUIElement?, home: XCUIElement,
                     swipeBack: Bool = true, then extra: (() -> Void)? = nil) {
        let back = "\(id)-\(swipeBack ? "swipeback" : "back")"
        guard let target else { note("SKIP \(suite)/\(id): no row for \(title)"); return }
        let opened = step("\(id)-open", from: from, to: title, seconds: 5, reached: navBar(title),
                          recover: { self.goBack(until: home) }) { press(target) }
        guard opened else { note("SKIP \(suite)/\(back): \(title) did not open"); return }
        sleep(2)
        extra?()
        let left = app.navigationBars[title]
        let returned = { home.waitForExistence(timeout: 8) && left.waitForNonExistence(timeout: 3) }
        if swipeBack {
            step(back, from: title, to: from, kind: "nav", reached: returned, recover: { self.goBack(until: home) }) {
                edgeSwipeBack(); return true
            }
        } else {
            step(back, from: title, to: from, kind: "nav", reached: returned, recover: { self.goBack(until: home) }) {
                press(backButton())
            }
        }
        sleep(1)
    }

    // MARK: Suites, in order of the owner's impact

    func test01_Koti() {
        suite = "koti"
        // From Myynti, as the step says: the app opens on Koti, so a tap on Koti right after launch
        // moved nothing and the step was NO-MOTION (final gate 39580643433).
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        tabStep("koti-from-myynti-setup", from: "Myynti", "Koti")
        step("koti-refresh", from: "Koti", to: "Koti", kind: "load", expect: "content stays put while refreshing", seconds: 5) {
            pullToRefresh()
        }
        sleep(2)
        step("koti-prev-month", from: "Koti", to: "Koti (previous month)", kind: "swap", expect: "month swaps in place", seconds: 5) {
            press(find("label == %@", "Edellinen kuukausi", scrolls: 0))
        }
        step("koti-next-month", from: "Koti (previous month)", to: "Koti", kind: "swap", expect: "month swaps in place", seconds: 5) {
            press(find("label == %@", "Seuraava kuukausi", scrolls: 0))
        }
        step("koti-scroll", from: "Koti", to: "Koti", kind: "scroll", expect: "list scrolls, nothing pops in") { flingUp() }
        sleep(2); scrollToTop()
        // Shown while an import has failed, as one has in N1's CI seed (M022).
        pushAndBack("koti-workqueue", from: "Koti", to: "Tuonnit ja virheet", target: row("Tuonnit ja virheet"), home: kotiHome)
        scrollToTop()
        // The Rahatilanne card's heading opens the bank: its label never began with 'Pankki' (M022).
        pushAndBack("koti-bank", from: "Koti", to: "Pankki", target: find("label BEGINSWITH %@", "Rahatilanne"), home: kotiHome)
        scrollToTop()
        let settings = app.navigationBars["Asetukset"]
        step("koti-settings-sheet", from: "Koti", to: "Asetukset sheet", kind: "sheet", seconds: 5, presents: true,
             reached: navBar("Asetukset")) {
            press(app.buttons["Asetukset"].firstMatch)
        }
        sleep(2)
        step("koti-settings-close", from: "Asetukset sheet", to: "Koti", kind: "sheet", reached: gone(settings),
             recover: { self.swipeSheetDown("Asetukset") }) {
            press(find("label == %@", "Valmis", scrolls: 0))
        }
        // The Avustaja sheet's own toolbar button; its title is the conversation's.
        let assistant = app.buttons["Keskustelut"]
        step("koti-assistant-sheet", from: "Koti", to: "Avustaja", kind: "sheet", seconds: 5, presents: true,
             reached: { assistant.waitForExistence(timeout: 8) }) {
            press(app.buttons["Avustaja"].firstMatch)
        }
        sleep(2)
        step("koti-assistant-swipedown", from: "Avustaja", to: "Koti", kind: "sheet", reached: gone(assistant),
             recover: { _ = self.drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98)) }) {
            drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98))
        }
        let add = app.navigationBars["Lisää"]
        step("koti-add-sheet", from: "Koti", to: "Lisää sheet", kind: "sheet", presents: true, reached: navBar("Lisää")) {
            press(app.tabBars.buttons["Lisää"].firstMatch)
        }
        sleep(1)
        step("koti-add-close", from: "Lisää sheet", to: "Koti", kind: "sheet", reached: gone(add),
             recover: { self.swipeSheetDown("Lisää") }) {
            tapWindow(CGVector(dx: 0.5, dy: 0.1))
        }
    }

    func test02_Myynti() {
        suite = "myynti"
        tabStep("myynti-tab", from: "Koti", "Myynti")
        tabStep("myynti-tab-revisit-koti", from: "Myynti", "Koti")
        tabStep("myynti-tab-revisit", from: "Koti", "Myynti")
        step("myynti-refresh", from: "Myynti", to: "Myynti", kind: "load", expect: "content stays put while refreshing", seconds: 5) {
            pullToRefresh()
        }
        sleep(2)
        pushAndBack("myynti-customers", from: "Myynti", to: "Asiakkaat", target: find("label == %@", "Asiakkaat"), home: myyntiHome) {
            // The customer's screen covers the list; its title is the name once it has loaded.
            let list = self.app.navigationBars["Asiakkaat"]
            guard let customer = self.find("label CONTAINS %@", "Oy", scrolls: 0) else { self.note("SKIP myynti/myynti-customer-open: no customer"); return }
            let opened = self.step("myynti-customer-open", from: "Asiakkaat", to: "Asiakas", seconds: 5, reached: self.gone(list),
                                   recover: { self.goBack(until: list) }) { self.press(customer) }
            guard opened else { self.note("SKIP myynti/myynti-customer-back: the customer did not open"); return }
            sleep(2)
            self.step("myynti-customer-back", from: "Asiakas", to: "Asiakkaat", reached: self.navBar("Asiakkaat"),
                      recover: { self.goBack(until: list) }) { self.press(self.backButton()) }
        }
        pushAndBack("myynti-recurring", from: "Myynti", to: "Toistuvat laskut", target: find("label == %@", "Toistuvat laskut"), home: myyntiHome)
        // The Myöhässä chip, in either case: 'myöhässä' alone found the late invoice's row and
        // pushed it (M028). Not the receivables bar or its legend, whose labels carry the sum.
        if let late = find("label BEGINSWITH[c] %@ AND NOT (label CONTAINS %@)", "myöhässä", "€", scrolls: 2) {
            step("myynti-filter-late", from: "Myynti", to: "Laskut (myöhässä)", kind: "swap", expect: "list swaps in place", seconds: 5,
                 reached: { late.waitForExistence(timeout: 3) && late.isSelected }) { press(late) }
            sleep(2)
        }
        // An invoice row: the customer, then 'Lasku <n>'. The chip's own label holds no 'Lasku '.
        let invoiceBar = app.navigationBars.matching(NSPredicate(format: "identifier == %@ OR identifier BEGINSWITH %@", "Lasku", "Lasku ")).firstMatch
        if let invoice = find("label CONTAINS %@", ", Lasku ", scrolls: 4) {
            let opened = step("myynti-invoice-open", from: "Myynti", to: "Lasku", seconds: 5, reached: { invoiceBar.waitForExistence(timeout: 8) },
                              recover: { self.goBack(until: self.myyntiHome) }) { press(invoice) }
            if opened {
                sleep(2)
                step("myynti-invoice-scroll", from: "Lasku", to: "Lasku", kind: "scroll", expect: "nothing pops in") { flingUp() }
                sleep(1)
                step("myynti-invoice-back", from: "Lasku", to: "Myynti", reached: { self.myyntiHome.waitForExistence(timeout: 8) },
                     recover: { self.goBack(until: self.myyntiHome) }) { press(backButton()) }
            } else {
                note("SKIP myynti/myynti-invoice-back: the invoice did not open")
            }
        }
        let form = app.navigationBars["Uusi lasku"]
        step("myynti-new-invoice", from: "Myynti", to: "Uusi lasku", kind: "sheet", seconds: 5, presents: true, reached: navBar("Uusi lasku")) {
            press(app.buttons["Uusi lasku"].firstMatch)
        }
        sleep(2)
        step("myynti-new-invoice-cancel", from: "Uusi lasku", to: "Myynti", kind: "sheet", reached: gone(form),
             recover: { self.goBack(until: self.myyntiHome); if form.exists { self.swipeSheetDown("Uusi lasku") } }) {
            press(find("label == %@", "Peruuta", scrolls: 0))
        }
        if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
        step("myynti-list-scroll", from: "Myynti", to: "Myynti", kind: "scroll", expect: "list scrolls, nothing pops in") { flingUp() }
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
            pullToRefresh()
        }
        sleep(2)
        // A figure of the report, looked for in its list: over the whole app "Myynti" found the tab
        // bar's button, and the step measured a tab switch instead of a drill-down. Its link (a
        // button, 9): with Kuukausittain first (B8) the chart's Menot bar came first and the tap
        // picked a month (gate run 39334500321).
        if let drill = find("elementType == 9 AND label BEGINSWITH %@", "Menot", scrolls: 2, in: app.collectionViews.firstMatch) {
            step("raportit-drill-open", from: "Raportit", to: "drill-down", seconds: 5,
                 // Raportit's own bar covered: on Raportit's toolbar buttons 'a back button' was true.
                 reached: { self.gone(self.app.navigationBars["Raportit"])() && self.app.tabBars.buttons["Raportit"].isSelected },
                 recover: { self.goBack(until: self.app.navigationBars["Raportit"]) }) { press(drill) }
            sleep(2)
            if app.navigationBars["Raportit"].exists {
                note("SKIP raportit/raportit-drill-swipeback: the drill-down did not open")
            } else {
                step("raportit-drill-swipeback", from: "drill-down", to: "Raportit", reached: navBar("Raportit"),
                     recover: { self.goBack(until: self.app.navigationBars["Raportit"]) }) { edgeSwipeBack(); return true }
            }
        }
        step("raportit-scroll", from: "Raportit", to: "Raportit", kind: "scroll", expect: "nothing pops in") { flingUp() }
        sleep(1)
        // The segmented control itself, at the segment not chosen yet: 'Luokittain' found the
        // section's header, and the segment the step meant was the chosen one (M044).
        if let picker = find("TRUEPREDICATE", type: .segmentedControl, scrolls: 4) {
            let other = picker.buttons.matching(NSPredicate(format: "selected == false")).firstMatch
            let name = other.exists ? other.label : ""
            step("raportit-category-picker", from: "Raportit", to: "Raportit (other category)", kind: "swap", seconds: 5,
                 reached: { picker.buttons[name].waitForExistence(timeout: 3) && picker.buttons[name].isSelected }) { press(other) }
        }
        if let zip = find("label == %@", "Lataa zip", scrolls: 6) {
            // The preview's title is the file's name.
            let sheet = app.navigationBars.matching(NSPredicate(format: "identifier ENDSWITH %@", ".zip")).firstMatch
            step("raportit-zip-sheet", from: "Raportit", to: "zip sheet", kind: "sheet", seconds: 5, presents: true,
                 reached: { sheet.waitForExistence(timeout: 8) }) { press(zip) }
            sleep(2)
            step("raportit-zip-close", from: "zip sheet", to: "Raportit", kind: "sheet", reached: gone(sheet),
                 recover: { _ = self.drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98)) }) {
                drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98))
            }
        }
    }

    func test04_Asetukset() {
        suite = "asetukset"
        let sheet = app.navigationBars["Asetukset"]
        step("asetukset-open", from: "Koti", to: "Asetukset sheet", kind: "sheet", seconds: 5, presents: true, reached: navBar("Asetukset")) {
            press(app.buttons["Asetukset"].firstMatch)
        }
        sleep(2)
        for (id, label) in [("seller", "Laskuttajan tiedot"), ("templates", "Sähköpostimallit"), ("payments", "Maksut"),
                            ("password", "Vaihda salasana"), ("passkeys", "Pääsyavaimet"), ("devices", "Laitteet"),
                            ("lock", "Sovelluslukitus"), ("notifications", "Ilmoitukset"), ("privacy", "Tietosuoja"),
                            ("help", "Ohje"), ("report", "Ilmoita ongelmasta")] {
            // The row, "<title>, <subtitle>": 'Tietosuoja' found the header 'Tietosuoja ja ohje', and
            // the back step that followed pressed Valmis and closed the sheet (M051).
            guard let entry = row(label) else { note("SKIP asetukset/\(id): no \(label)"); continue }
            let opened = step("asetukset-\(id)-open", from: "Asetukset", to: label, seconds: 5, reached: gone(sheet),
                              recover: { self.goBack(until: sheet) }) { press(entry) }
            guard opened else { note("SKIP asetukset/asetukset-\(id)-back: \(label) did not open"); continue }
            sleep(2)
            step("asetukset-\(id)-back", from: label, to: "Asetukset", reached: navBar("Asetukset"),
                 recover: { self.goBack(until: sheet) }) { press(backButton()) }
            if app.buttons["Hylkää muutokset"].exists { app.buttons["Hylkää muutokset"].tap(); sleep(1) }
        }
        scrollToTop()
        step("asetukset-close", from: "Asetukset sheet", to: "Koti", kind: "sheet", reached: gone(sheet),
             recover: { self.swipeSheetDown("Asetukset") }) {
            press(find("label == %@", "Valmis", scrolls: 0))
        }
    }

    func test05_Chat() {
        suite = "chat"
        // The Avustaja sheet's own toolbar button; its title is the conversation's.
        let assistant = app.buttons["Keskustelut"]
        step("chat-open", from: "Koti", to: "Avustaja", kind: "sheet", seconds: 5, presents: true,
             reached: { assistant.waitForExistence(timeout: 8) }) { press(app.buttons["Avustaja"].firstMatch) }
        sleep(3)
        let field = app.textFields.firstMatch.exists ? app.textFields.firstMatch : app.textViews.firstMatch
        if field.waitForExistence(timeout: 5) {
            step("chat-focus", from: "Avustaja", to: "Avustaja (keyboard)", kind: "swap", expect: "keyboard rises, messages stay pinned",
                 reached: { self.app.keyboards.firstMatch.waitForExistence(timeout: 5) }) {
                press(field)
            }
            field.typeText("Paljonko myin tässä kuussa?")
            step("chat-send", from: "Avustaja", to: "Avustaja (answer)", kind: "load", expect: "answer appears below, nothing above jumps", seconds: 8) {
                let send = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Lähetä", "Send")).firstMatch
                if send.exists { return press(send) }
                touching(finger: false); field.typeText("\n"); return true
            }
        }
        // Koti again with its tab bar, and no keyboard left over it (M064).
        step("chat-close", from: "Avustaja", to: "Koti", kind: "sheet",
             reached: { self.gone(assistant)() && self.app.keyboards.firstMatch.waitForNonExistence(timeout: 5) && self.app.tabBars.firstMatch.isHittable },
             recover: { _ = self.drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98)) }) {
            drag(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.98))
        }
    }

    func test06_SalesInvoiceFlow() {
        suite = "lasku"
        // Selected, not only tapped: the first tap after sign-in was lost, Koti stayed up and every
        // lasku step was skipped (final gate 39580643433).
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        let form = app.navigationBars["Uusi lasku"]
        step("lasku-new", from: "Myynti", to: "Uusi lasku", kind: "sheet", seconds: 5, presents: true, reached: navBar("Uusi lasku")) {
            press(app.buttons["Uusi lasku"].firstMatch)
        }
        sleep(2)
        // The button: 'Asiakas' found the section's header, and the picker never opened (M094).
        if let customer = find("label == %@", "Valitse asiakas", scrolls: 0) {
            let picker = app.navigationBars["Valitse asiakas"]
            let shown = step("lasku-customer-picker", from: "Uusi lasku", to: "asiakasvalinta", kind: "sheet", seconds: 5, presents: true,
                             reached: { picker.waitForExistence(timeout: 8) }) { press(customer) }
            sleep(2)
            if shown {
                // A row of the picker, the list on top: over the whole app 'Oy' found a Myynti row
                // under the form (M094). The form's list holds 'Valitse asiakas'; the picker's does not.
                let lists = app.collectionViews
                let top = lists.element(boundBy: max(0, lists.count - 1))
                let close = { _ = self.press(self.find("label == %@", "Sulje", scrolls: 0)) }
                if !top.buttons["Valitse asiakas"].exists, let first = find("label CONTAINS %@", "Oy", scrolls: 0, in: top) {
                    step("lasku-customer-pick", from: "asiakasvalinta", to: "Uusi lasku", kind: "sheet", expect: "back to the form, filled",
                         reached: gone(picker), recover: close) { press(first) }
                } else {
                    step("lasku-customer-cancel", from: "asiakasvalinta", to: "Uusi lasku", kind: "sheet", reached: gone(picker),
                         recover: close) { press(find("label == %@", "Sulje", scrolls: 0)) }
                }
            }
        }
        step("lasku-form-scroll", from: "Uusi lasku", to: "Uusi lasku", kind: "scroll", expect: "nothing pops in") { flingUp() }
        // A filled form asks before it closes: the step ends on that question or on Myynti.
        let discard = app.buttons["Hylkää muutokset"]
        step("lasku-cancel", from: "Uusi lasku", to: "Myynti", kind: "sheet",
             reached: { discard.waitForExistence(timeout: 3) || form.waitForNonExistence(timeout: 5) }) {
            press(find("label == %@", "Peruuta", scrolls: 0))
        }
        if discard.exists {
            step("lasku-discard", from: "Hylätäänkö muutokset?", to: "Myynti", kind: "sheet", reached: gone(form),
                 recover: { self.swipeSheetDown("Uusi lasku") }) { press(discard) }
        }
        // A sent or late invoice, its row naming a due date: the first row was the draft Lasku 4,
        // which has neither a payment nor a copy (M095).
        let invoiceBar = app.navigationBars.matching(NSPredicate(format: "identifier == %@ OR identifier BEGINSWITH %@", "Lasku", "Lasku ")).firstMatch
        guard let invoice = find("label CONTAINS %@ AND label CONTAINS %@", ", Lasku ", "eräpäivä", scrolls: 4) else {
            note("SKIP lasku/lasku-open: no sent invoice"); return
        }
        let opened = step("lasku-open", from: "Myynti", to: "Lasku", seconds: 5, reached: { invoiceBar.waitForExistence(timeout: 8) },
                          recover: { self.goBack(until: self.myyntiHome) }) { press(invoice) }
        guard opened else { note("SKIP lasku/lasku-back: the invoice did not open"); return }
        sleep(2)
        // Its number once loaded ('Lasku' before): the copy is told from it by that title.
        let numbered = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        let title = numbered.waitForExistence(timeout: 10) ? numbered.identifier : invoiceBar.identifier
        let detail = app.navigationBars[title]
        // The primary when the invoice waits for its payment, else a Toiminnot item: the Maksu and
        // Kopioi tiles are gone (N6).
        if let pay = find("label == %@", "Kirjaa maksu", scrolls: 0) ?? menuItem("Kirjaa maksu") {
            let sheet = app.navigationBars["Kirjaa maksu"]
            let shown = step("lasku-payment-sheet", from: "Lasku", to: "Kirjaa maksu", kind: "sheet", seconds: 5, presents: true,
                             reached: { sheet.waitForExistence(timeout: 8) }) { press(pay) }
            sleep(1)
            if shown {
                step("lasku-payment-cancel", from: "Kirjaa maksu", to: "Lasku", kind: "sheet", reached: gone(sheet),
                     recover: { self.swipeSheetDown("Kirjaa maksu") }) { press(find("label == %@", "Peruuta", scrolls: 0)) }
            }
        }
        // Toiminnot > Kopioi luonnokseksi, the menu opened outside the recording: 'Kopioi' found the
        // reference number's copy glyph (M095). The copy is a new draft, pushed over this invoice.
        if let copy = menuItem("Kopioi luonnokseksi") {
            let copied = app.navigationBars.matching(NSPredicate(format: "(identifier == %@ OR identifier BEGINSWITH %@) AND identifier != %@",
                                                                 "Lasku", "Lasku ", title)).firstMatch
            let made = step("lasku-copy", from: "Lasku", to: "Lasku (kopio)", seconds: 5, reached: { copied.waitForExistence(timeout: 10) },
                            recover: { self.goBack(until: detail) }) { press(copy) }
            sleep(2)
            if made {
                step("lasku-copy-back", from: "Lasku (kopio)", to: "Lasku", reached: { detail.waitForExistence(timeout: 8) },
                     recover: { self.goBack(until: detail) }) { press(backButton()) }
            }
        } else {
            note("SKIP lasku/lasku-copy: no Kopioi luonnokseksi in Toiminnot")
        }
        step("lasku-back", from: "Lasku", to: "Myynti", reached: { self.myyntiHome.waitForExistence(timeout: 8) },
             recover: { self.goBack(until: self.myyntiHome) }) { press(backButton()) }
    }

    func test07_Bank() {
        suite = "pankki"
        tabStep("pankki-kirjanpito-tab", from: "Koti", "Kirjanpito")
        let books = app.navigationBars["Kirjanpito"], bank = app.navigationBars["Pankki"]
        guard let pankki = row("Pankki") else { note("SKIP pankki: no Pankki row"); return }
        // One push to the rows (N2): the hub's open and its "Näytä kaikki" push were two.
        let opened = step("pankki-open", from: "Kirjanpito", to: "Pankki", seconds: 5, reached: navBar("Pankki"),
                          recover: { self.goBack(until: books) }) { press(pankki) }
        guard opened else { note("SKIP pankki/pankki-back: Pankki did not open"); return }
        sleep(2)
        // The first row, while it is at the top: Saldo yhteensä opens Pankkiyhteys ja tilit.
        if let accounts = find("label BEGINSWITH %@", "Saldo yhteensä", scrolls: 4) {
            let shown = step("pankki-accounts-open", from: "Pankki", to: "Pankkiyhteys ja tilit", seconds: 5,
                             reached: navBar("Pankkiyhteys ja tilit"), recover: { self.goBack(until: bank) }) { press(accounts) }
            sleep(2)
            if shown {
                step("pankki-accounts-back", from: "Pankkiyhteys ja tilit", to: "Pankki", reached: navBar("Pankki"),
                     recover: { self.goBack(until: bank) }) { press(backButton()) }
            }
        }
        step("pankki-feed-scroll", from: "Pankki", to: "Pankki", kind: "scroll", expect: "nothing pops in") { flingUp() }
        if let more = find("label BEGINSWITH %@", "Näytä enemmän", scrolls: 8) {
            step("pankki-feed-more", from: "Pankki", to: "Pankki (more)", kind: "load",
                 expect: "rows grow below, nothing above moves", seconds: 5) { press(more) }
        }
        step("pankki-back", from: "Pankki", to: "Kirjanpito", reached: { books.waitForExistence(timeout: 8) && bank.waitForNonExistence(timeout: 3) },
             recover: { self.goBack(until: books) }) { press(backButton()) }
        for (id, label) in [("email", "Sähköposti"), ("purchases", "Ostolaskut"), ("match", "Kohdista ostolaskujen maksut"),
                            ("periods", "Kuukauden sulku"), ("alv", "ALV-ilmoitus"), ("ledger", "Tulos ja tase, Tuloslaskelma")] {
            guard let row = find("label BEGINSWITH %@", label) else { note("SKIP pankki/\(id): no \(label)"); continue }
            // Pushed or not by the back button: the ledger's title is the root's own 'Kirjanpito'.
            let opened = step("kirjanpito-\(id)-open", from: "Kirjanpito", to: label, seconds: 5,
                              reached: { self.anyBack.waitForExistence(timeout: 8) }, recover: { self.goBack(until: books) }) { press(row) }
            guard opened else { note("SKIP pankki/kirjanpito-\(id)-back: \(label) did not open"); continue }
            sleep(3)
            step("kirjanpito-\(id)-back", from: label, to: "Kirjanpito", reached: { self.anyBack.waitForNonExistence(timeout: 8) && books.exists },
                 recover: { self.goBack(until: books) }) { edgeSwipeBack(); return true }
            sleep(1)
        }
    }

    /// Offline: the banner and the cached screens (scripts/sim/api-proxy.py drops every connection).
    func test08_Offline() {
        suite = "offline"
        let banner = app.descendants(matching: .any).matching(identifier: "offline-banner").firstMatch
        goOffline()
        step("offline-tab-myynti", from: "Koti", to: "tab Myynti (offline)", kind: "nav", expect: "cached list, banner without shift", seconds: 5,
             reached: { self.app.tabBars.buttons["Myynti"].isSelected }, recover: { _ = self.selectTab("Myynti") }) {
            press(app.tabBars.buttons["Myynti"].firstMatch)
        }
        sleep(2)
        // The pill comes after two missed requests, at another moment in each walk (M084): the
        // refresh starts with it up, outside the recording, so all three walks film the same thing.
        if !banner.waitForExistence(timeout: 15) {
            _ = pullToRefresh()
            if !banner.waitForExistence(timeout: 15) { note("offline: no offline-banner before offline-refresh") }
        }
        step("offline-refresh", from: "Myynti", to: "Myynti (offline error)", kind: "load", expect: "error without shift", seconds: 6) {
            pullToRefresh()
        }
        goOnline()
        // Filmed until the pill has gone, up to 15 s: the first request that reaches the server
        // takes it away, the refresh's or the 8 s probe's.
        step("online-again", from: "Myynti (offline)", to: "Myynti", kind: "load", expect: "banner leaves without shift", seconds: 8,
             until: { banner.waitForNonExistence(timeout: 15) }, reached: { !banner.exists }) {
            pullToRefresh()
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
            let books = app.navigationBars["Kirjanpito"]
            let opened = step("good-push-periods", from: "Kirjanpito", to: "Kuukauden sulku", seconds: 5, reached: navBar("Kuukauden sulku"),
                              recover: { self.goBack(until: books) }) { press(row) }
            sleep(3)
            if opened {
                // The walk's own check: a pop let go at 0.3 of the width is cancelled, and the step
                // must say MISS-TARGET. Without a reached check it read STEP (M001, M043).
                step("check-short-swipeback", from: "Kuukauden sulku", to: "Kirjanpito", expect: "MISS-TARGET: the pop is cancelled",
                     reached: { books.waitForExistence(timeout: 3) }) { swipeFromEdge(to: 0.3); return true }
                _ = app.navigationBars["Kuukauden sulku"].waitForExistence(timeout: 2)
                if app.navigationBars["Kuukauden sulku"].exists {
                    step("good-swipeback-periods", from: "Kuukauden sulku", to: "Kirjanpito", reached: { books.waitForExistence(timeout: 8) },
                         recover: { self.goBack(until: books) }) { edgeSwipeBack(); return true }
                } else {
                    note("SKIP calibration/good-swipeback-periods: the short swipe left Kuukauden sulku")
                }
            }
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
            let deadline = Date().addingTimeInterval(45)
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
        // The summary under the settled queue: the first, unsaved row waits for its check, so the
        // second saved and left for review (a look-alike too) makes two. The rows themselves no
        // longer tell: the first row's own slot says "Odottaa tarkistusta" from the start (N4), and
        // the approval is said by the summary alone.
        let pending = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "2 odottaa tarkistusta")).firstMatch
        let refused = app.buttons["Avaa lomake"].firstMatch
        let approved = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Hyväksyttiin automaattisesti")).firstMatch
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
        // "Summa" beside the field, "0,00" in it while empty; the field is named "Summa euroina".
        let total = app.textFields.matching(NSPredicate(format: "label BEGINSWITH %@ OR placeholderValue == %@", "Summa", "0,00")).firstMatch
        // Whole euros: the decimal key follows the simulator's region, not the app's Finnish.
        if total.exists && blank(total, "0,00") { type(total, "12") }
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
        // Pinned under the form (N4): tapped where it is, as `tap` scrolls for anything near the bottom edge.
        let save = app.buttons["Tallenna kuitti"].firstMatch
        guard save.waitForExistence(timeout: 5) else { note("calibration: no Tallenna kuitti"); dump(app, "calibration-no-save"); return false }
        save.tap()
        return true
    }
}
