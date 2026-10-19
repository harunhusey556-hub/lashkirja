import XCTest

/// P2 additions: Spotlight routes, receipt thumbnails, next invoice number, dates in Helsinki.
final class P2Tests: WalkTestCase {
    /// Reads ids from the demo API the app uses (through the walk proxy), with the demo-seed login.
    func demoJSON(_ path: String) -> [String: Any] {
        func call(_ req: URLRequest) -> [String: Any] {
            var out: [String: Any] = [:]
            let done = expectation(description: path)
            URLSession.shared.dataTask(with: req) { data, _, _ in
                out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 30)
            return out
        }
        let base = "http://127.0.0.1:3998"
        var login = URLRequest(url: URL(string: base + "/api/auth/token")!)
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "content-type")
        login.httpBody = #"{"email":"demo@lashkirja.fi","password":"demo123"}"#.data(using: .utf8)
        let token = call(login)["token"] as? String ?? ""
        var get = URLRequest(url: URL(string: base + path)!)
        get.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return call(get)
    }

    func testA_SpotlightInvoiceRoute() {
        let invoices = demoJSON("/api/invoices")["invoices"] as? [[String: Any]] ?? []
        guard let sent = invoices.first(where: { $0["status"] as? String == "sent" }), let id = sent["id"] as? String,
              let number = sent["number"] else { check("P2 demo API lists a sent invoice", false); return }
        openURL("lashkirja://invoice/\(id)")
        let ok = app.staticTexts["Lasku \(number)"].waitForExistence(timeout: 20)
        shot("p2-spotlight-invoice"); check("P2 Spotlight invoice link opens Lasku \(number)", ok)
    }
    func testB_SpotlightCustomerRoute() {
        let customers = demoJSON("/api/customers")["customers"] as? [[String: Any]] ?? []
        guard let anna = customers.first(where: { $0["name"] as? String == "Anna Asiakas" }), let id = anna["id"] as? String
        else { check("P2 demo API lists Anna Asiakas", false); return }
        openURL("lashkirja://customer/\(id)")
        let ok = app.staticTexts["Anna Asiakas"].waitForExistence(timeout: 20)
        shot("p2-spotlight-customer"); check("P2 Spotlight customer link opens Anna Asiakas", ok)
    }
    /// U038: only a loaded receipt picture counts. `app.images` also counted the chevrons and the tab
    /// bar's icons, so the check passed on a list without a single picture. The thumbnails speak to
    /// XCUITest only under `-LKUITest` (ReceiptThumbnail), so the app is launched again with it.
    func testC_ReceiptThumbnails() {
        app.terminate()
        app.launchArguments.append("-LKUITest")
        launchSignedIn()
        dismissSystemPrompts()
        XCTAssertTrue(selectTab("Kirjanpito"), "Kirjanpito is not selected")
        tap("Kuitit"); sleep(6)
        let pictures = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@ AND label == %@", "receipt-thumbnail", "Pienoiskuva"))
        // Each row fetches its picture once it is on screen.
        for _ in 0..<30 where pictures.count == 0 { sleep(1) }
        shot("p2-receipts"); dump(app, "p2-receipts")
        check("P2 Kuitit list shows image thumbnails (\(pictures.count))", pictures.count > 0)
        XCTAssertGreaterThan(pictures.count, 0, "no Kuitit row shows its picture")
    }
    /// U038: the caption is the server's next number, and the form opens on the Helsinki day with the
    /// due date 14 days on. The check read only "Seuraava laskunumero", so it passed while the picker
    /// drew 17.10.2026 above "Eräpäivä 1.11.2026 · 14 pv" on the UTC simulator.
    func testD_NextInvoiceNumber() {
        let next = demoJSON("/api/invoices/sequence")["nextNumber"] as? Int
        tab("Myynti"); tap("Uusi lasku"); sleep(4)
        let caption = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Seuraava laskunumero'")).firstMatch
        shot("p2-next-number"); check("P2 new invoice shows \(caption.exists ? caption.label : "no next number")", caption.exists)
        let expected = next.map { "Seuraava laskunumero: \($0)" } ?? "no sequence from the demo API"
        check("P2 the next number is the server's (\(expected))", caption.exists && caption.label == expected)
        XCTAssertEqual(caption.exists ? caption.label : nil, expected)
        expectFormDates(issue: HelsinkiDay.today(), "P2 D")
    }

    /// U012 U025 U063 U090 U102: a day shown or picked is the Helsinki day in any device zone. At
    /// Etc/GMT+12 Helsinki midnight always drew as the day before ('Laskun päivä 17.10.2026' above
    /// 'Eräpäivä 1.11.2026 · 14 pv'), and a picked day was saved one day late.
    func testE_InvoiceDatesFollowHelsinki() {
        relaunch(zone: "Etc/GMT+12")
        let today = HelsinkiDay.today()
        let next = demoJSON("/api/invoices/sequence")["nextNumber"] as? Int
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        tap("Uusi lasku")
        guard app.navigationBars["Uusi lasku"].waitForExistence(timeout: 15) else { XCTFail("Uusi lasku did not open"); return }
        waitEnabled(app.buttons["Luo lasku"].firstMatch)
        shot("p2e-new-invoice")
        expectFormDates(issue: today, "P2 E")

        // The next day, in the month the calendar opens on (the day before on a month's last day).
        let picked = today.adding(1).month == today.month ? today.adding(1) : today.adding(-1)
        guard pick(picked) else { return }
        shot("p2e-picked")
        expectFormDates(issue: picked, "P2 E picked")

        // Saved as a draft: the server has the day that was picked, and the due date from it.
        guard createInvoice() else { return }
        let created = next.map { "Lasku \($0)" } ?? "Lasku ?"
        let opened = app.navigationBars[created].waitForExistence(timeout: 20)
        check("P2 E the created invoice opens (\(created))", opened)
        XCTAssertTrue(opened, "\(created) did not open after Luo lasku")
        let invoices = demoJSON("/api/invoices")["invoices"] as? [[String: Any]] ?? []
        let draft = invoices.first { next != nil && ($0["number"] as? Int) == next }
        let issue = (draft?["issueDate"] as? String).map { String($0.prefix(10)) }
        let due = (draft?["dueDate"] as? String).map { String($0.prefix(10)) }
        check("P2 E the draft's issueDate is \(picked.iso) (\(issue ?? "none"))", issue == picked.iso)
        XCTAssertEqual(issue, picked.iso, "the draft's issueDate")
        XCTAssertEqual(due, picked.adding(14).iso, "the draft's dueDate")

        // The recurring editor's 'Alkaa' opens on the Helsinki day too.
        if opened { back(created) }
        tap("Toistuvat laskut")
        let newSchedule = app.buttons["Uusi toistuva lasku"].firstMatch
        if newSchedule.waitForExistence(timeout: 15) {
            newSchedule.tap(); taps += 1
            let sheet = app.navigationBars["Uusi toistuva lasku"]
            XCTAssertTrue(sheet.waitForExistence(timeout: 10), "Uusi toistuva lasku did not open")
            let start = shownDay(app.datePickers.firstMatch)
            shot("p2e-recurring")
            check("P2 E Alkaa is \(today.shown) (shows \(start ?? "nothing"))", start == today.shown)
            XCTAssertEqual(start, today.shown, "Alkaa")
            sheet.buttons["Peruuta"].tap()
            if app.buttons["Hylkää muutokset"].waitForExistence(timeout: 2) { app.buttons["Hylkää muutokset"].tap() }
            XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), "Uusi toistuva lasku did not close")
            // Toistuvat laskut is on Myynti's path now: back to the list the payment part opens from.
            back("Toistuvat laskut")
            _ = app.navigationBars["Toistuvat laskut"].waitForNonExistence(timeout: 10)
        } else {
            XCTFail("no Uusi toistuva lasku on Toistuvat laskut")
        }

        // Kirjaa maksu: from 13.00 Helsinki time a device at Kiritimati (UTC+14) is on the next day,
        // before it one at Etc/GMT+12 on the day before, so the device's own day is never Helsinki's.
        let zone = HelsinkiDay.hour() >= 13 ? "Pacific/Kiritimati" : "Etc/GMT+12"
        if zone != "Etc/GMT+12" { relaunch(zone: zone) }
        // From Myynti, not Koti: the draft this test just created joins Koti's first five tasks and
        // pushes the overdue row under "Näytä enemmän" (run 39180204687).
        XCTAssertTrue(selectTab("Myynti"), "Myynti is not selected")
        guard tapLabel("label CONTAINS %@", "myöhässä") else { XCTFail("no overdue invoice on Myynti"); return }
        let invoiceBar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Lasku ")).firstMatch
        let pay = app.buttons["Maksu"].firstMatch
        guard invoiceBar.waitForExistence(timeout: 20), pay.waitForExistence(timeout: 30) else {
            dump(app, "p2e-no-invoice"); XCTFail("the overdue invoice did not open with Maksu"); return
        }
        let number = Int(invoiceBar.identifier.dropFirst("Lasku ".count))
        pay.tap(); taps += 1
        let sheet = app.navigationBars["Kirjaa maksu"]
        guard sheet.waitForExistence(timeout: 10) else { XCTFail("Kirjaa maksu did not open"); return }
        let shown = shownDay(app.datePickers.firstMatch)
        shot("p2e-payment")
        let helsinki = HelsinkiDay.today()
        check("P2 E Maksupäivä at \(zone) is \(helsinki.shown) (shows \(shown ?? "nothing"))", shown == helsinki.shown)
        XCTAssertEqual(shown, helsinki.shown, "Maksupäivä at \(zone)")
        // One euro, not the open amount the sheet fills in: Lasku 2 is the seed's only overdue
        // invoice, and the classes after this one in a full run (P3 B, P5) still open it.
        let amount = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", "Summa", "Summa")).firstMatch
        guard amount.waitForExistence(timeout: 5) else { dump(app, "p2e-no-amount"); XCTFail("no Summa in Kirjaa maksu"); return }
        let filled = (amount.value as? String) ?? ""
        type(amount, String(repeating: XCUIKeyboardKey.delete.rawValue, count: filled.count + 2) + "1")
        XCTAssertEqual(amount.value as? String, "1", "Summa before Tallenna")
        sheet.buttons["Tallenna"].tap(); taps += 1
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 20), "Kirjaa maksu did not close after Tallenna")
        let listed = demoJSON("/api/invoices")["invoices"] as? [[String: Any]] ?? []
        guard let id = listed.first(where: { number != nil && ($0["number"] as? Int) == number })?["id"] as? String else {
            XCTFail("the demo API does not list \(invoiceBar.identifier)"); return
        }
        let payments = (demoJSON("/api/invoices/\(id)")["invoice"] as? [String: Any])?["payments"] as? [[String: Any]] ?? []
        let paid = (payments.last?["paidDate"] as? String).map { String($0.prefix(10)) }
        let shownIso = shown.flatMap(HelsinkiDay.init(shown:))?.iso
        check("P2 E the saved paidDate is the day the picker showed (\(paid ?? "none") vs \(shownIso ?? "none"))", paid != nil && paid == shownIso)
        XCTAssertEqual(paid, shownIso, "paidDate against the day Maksupäivä showed")
    }

    /// A fresh launch with the device in `zone`; the simulator itself runs in UTC.
    private func relaunch(zone: String) {
        app.terminate()
        app.launchEnvironment["TZ"] = zone
        launchSignedIn()
        dismissSystemPrompts()
        note("INFO P2 device zone \(zone)")
    }

    /// The invoice form's two dates as drawn: 'Laskun päivä', and the footer under 'Maksuaika' (14 pv).
    private func expectFormDates(issue: HelsinkiDay, _ step: String) {
        let shown = shownDay(app.datePickers.firstMatch)
        check("\(step) Laskun päivä is \(issue.shown) (shows \(shown ?? "nothing"))", shown == issue.shown)
        XCTAssertEqual(shown, issue.shown, "\(step): Laskun päivä")
        let footer = "Eräpäivä \(issue.adding(14).shown) · 14 pv"
        let due = app.staticTexts[footer].waitForExistence(timeout: 5)
        check("\(step) footer reads \(footer)", due)
        XCTAssertTrue(due, "\(step): no '\(footer)' under Maksuaika")
    }

    /// The day a compact DatePicker shows: its button's value ("18.10.2026").
    private func shownDay(_ picker: XCUIElement) -> String? {
        guard picker.waitForExistence(timeout: 10) else { return nil }
        return picker.buttons.firstMatch.value as? String
    }

    /// Picks `day` in the 'Laskun päivä' calendar, then closes the calendar.
    private func pick(_ day: HelsinkiDay) -> Bool {
        app.datePickers.firstMatch.buttons.firstMatch.tap(); taps += 1
        let patterns = day.calendarLabelPatterns()
        let cell = app.buttons.matching(NSPredicate(format: "label MATCHES[c] %@ OR label MATCHES[c] %@ OR label MATCHES[c] %@ OR label == %@",
                                                    patterns[0], patterns[1], patterns[2], "\(day.day)")).firstMatch
        guard cell.waitForExistence(timeout: 10) else {
            dump(app, "p2e-calendar"); XCTFail("no \(day.shown) in the Laskun päivä calendar"); return false
        }
        cell.tap(); taps += 1
        // A date-only calendar closes by itself once a day is picked; only if it stays is it closed
        // with a tap on the title bar. The dismiss region's centre lies over the Maksuaika segments,
        // and a tap sent there as the calendar closed itself chose "7 pv" (run 39164873388).
        let outside = app.descendants(matching: .any)["PopoverDismissRegion"]
        if !outside.waitForNonExistence(timeout: 3) { app.navigationBars["Uusi lasku"].tap() }
        _ = outside.waitForNonExistence(timeout: 5)
        return true
    }

    /// Anna Asiakas and one priced line, then Luo lasku.
    private func createInvoice() -> Bool {
        app.buttons["Valitse asiakas"].firstMatch.tap(); taps += 1
        let picker = app.navigationBars["Valitse asiakas"]
        guard picker.waitForExistence(timeout: 10) else { XCTFail("Valitse asiakas did not open"); return false }
        // The Myynti rows under the sheets carry the same name; only the sheet's row can be tapped.
        guard let anna = firstHittable(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Anna Asiakas")), timeout: 10) else {
            dump(app, "p2e-customers"); XCTFail("no Anna Asiakas to pick"); return false
        }
        anna.tap(); taps += 1
        _ = picker.waitForNonExistence(timeout: 10)
        let description = app.textViews["Rivin 1 kuvaus"].exists ? app.textViews["Rivin 1 kuvaus"] : app.textFields["Rivin 1 kuvaus"]
        type(description, "Ripsienpidennys")
        // The keyboard's bar lies over the price field under the description, so a tap on it never
        // focused it (run 39175542996): the keyboard goes first and the field is brought into view.
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let price = app.textFields["Rivin 1 à-hinta euroina"]
        if !price.isHittable { app.swipeUp() }
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: price)], timeout: 5)
        type(price, "10")
        if app.buttons["Valmis"].exists { app.buttons["Valmis"].tap() }
        let create = app.buttons["Luo lasku"].firstMatch
        guard create.waitForExistence(timeout: 5) else { XCTFail("no Luo lasku"); return false }
        create.tap(); taps += 1
        return true
    }

    private func waitEnabled(_ element: XCUIElement) {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: element)
        _ = XCTWaiter().wait(for: [enabled], timeout: 15)
    }

    private func firstHittable(_ query: XCUIElementQuery, timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let element = query.allElementsBoundByIndex.first(where: { $0.isHittable }) { return element }
            usleep(250_000)
        } while Date() < deadline
        return nil
    }

    /// The bar's Back button, as the owner taps it.
    private func back(_ title: String) {
        let bar = app.navigationBars[title]
        let button = bar.buttons["BackButton"].exists ? bar.buttons["BackButton"] : bar.buttons.element(boundBy: 0)
        button.tap(); taps += 1
    }
}

/// A calendar day in Helsinki, the day the app and the server count in.
private struct HelsinkiDay: Equatable {
    let year: Int
    let month: Int
    let day: Int

    static func today() -> HelsinkiDay {
        let c = calendar(helsinki).dateComponents([.year, .month, .day], from: Date())
        return HelsinkiDay(year: c.year ?? 0, month: c.month ?? 0, day: c.day ?? 0)
    }

    static func hour() -> Int { calendar(helsinki).component(.hour, from: Date()) }

    /// "18.10.2026", as the app prints a day.
    var shown: String { "\(day).\(month).\(year)" }
    /// "2026-10-18", as the API sends one.
    var iso: String { String(format: "%04d-%02d-%02d", year, month, day) }

    func adding(_ days: Int) -> HelsinkiDay {
        let utc = Self.calendar(TimeZone(identifier: "UTC")!)
        guard let start = utc.date(from: DateComponents(year: year, month: month, day: day)),
              let date = utc.date(byAdding: .day, value: days, to: start) else { return self }
        let c = utc.dateComponents([.year, .month, .day], from: date)
        return HelsinkiDay(year: c.year ?? 0, month: c.month ?? 0, day: c.day ?? 0)
    }

    /// The calendar's label for this day, in Finnish or English ("sunnuntai 19. lokakuuta",
    /// "Sunday, October 19", "Sunday 19 October"), as patterns that do not take 19 for 9.
    func calendarLabelPatterns() -> [String] {
        let fi = monthName("fi_FI"), en = monthName("en_US")
        return ["(.*\\D)?\(day)\\. \(fi).*", ".*\(en) \(day)(\\D.*)?", "(.*\\D)?\(day) \(en).*"]
    }

    private func monthName(_ locale: String) -> String {
        let utc = TimeZone(identifier: "UTC")!
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: locale)
        formatter.timeZone = utc
        formatter.dateFormat = "MMMM"
        return Self.calendar(utc).date(from: DateComponents(year: year, month: month, day: day)).map(formatter.string(from:)) ?? ""
    }

    private static let helsinki = TimeZone(identifier: "Europe/Helsinki")!

    private static func calendar(_ zone: TimeZone) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        return c
    }
}

extension HelsinkiDay {
    /// "18.10.2026" back to a day; nil for anything else.
    init?(shown: String) {
        let parts = shown.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        self.init(year: parts[2], month: parts[1], day: parts[0])
    }
}
