import Testing
import Foundation
@testable import LashKirjaCore

private let nbsp = "\u{00A0}"

private func item(_ json: String) throws -> DashboardItem {
    try JSONDecoder().decode(DashboardItem.self, from: Data(json.utf8))
}

private func dashboard(_ extra: String) throws -> Dashboard {
    let json = #"{"month":"2026-10","income":0,"expenses":0,"matching":{"matchable":0,"matched":0,"suggested":0}"# + (extra.isEmpty ? "" : ",\(extra)") + "}"
    return try JSONDecoder().decode(Dashboard.self, from: Data(json.utf8))
}

private func figures(_ json: String) throws -> VatDueFigures {
    try JSONDecoder().decode(VatDueFigures.self, from: Data(json.utf8))
}

private let now = ISO8601DateFormatter().date(from: "2026-10-03T09:00:00Z")!

// MARK: Muistuta (web DashboardClient overdue_invoice)

@Test func overdueInvoiceOffersAReminderUntilOneWasSent() throws {
    let open = try item(#"{"id":"o1","kind":"overdue_invoice","invoiceId":"I1","customerId":"C1","number":2,"party":"Harun","amount":81.58,"dueDate":"2026-10-01","daysLate":1,"nextReminderAt":null}"#)
    #expect(open.nextReminderAt == nil)
    #expect(Koti.taskAction(open, now: now) == .remind)
    #expect(Koti.taskAction(open, now: now).label == "Muistuta")
    #expect(Koti.overdueSubtitle(open, now: now) == "Lasku 2 · myöhässä 1 päivä")

    // The last reminder's term still runs: the row opens the invoice, which says when.
    let reminded = try item(#"{"id":"o2","kind":"overdue_invoice","invoiceId":"I2","number":5,"party":"Liisa","amount":10,"daysLate":20,"nextReminderAt":"2026-10-10T08:00:00.000Z"}"#)
    #expect(Koti.reminderWaits(reminded, now: now))
    #expect(Koti.taskAction(reminded, now: now) == .open("Avaa"))
    #expect(Koti.overdueSubtitle(reminded, now: now) == "Lasku 5 · myöhässä 20 päivää · muistutettu")

    // Once the term has run out a new reminder may go again.
    let later = ISO8601DateFormatter().date(from: "2026-10-11T00:00:00Z")!
    #expect(Koti.taskAction(reminded, now: later) == .remind)
}

// MARK: Täydennä (web FP-6, ReceiptApprovalSheet)

@Test func pendingReceiptWithGapsIsCompletedNotApproved() throws {
    let ready = try item(#"{"id":"p1","kind":"pending_receipt","receiptId":"R1","party":"K-Market","amount":12.4,"category":"tarvikkeet","vatRate":25.5,"gaps":[]}"#)
    #expect(Koti.taskAction(ready, now: now) == .approve)
    #expect(Koti.pendingSubtitle(ready) == "tarvikkeet · ALV 25,5 %")

    let gaps = try item(#"{"id":"p2","kind":"pending_receipt","receiptId":"R2","party":"kuitti.jpg","amount":null,"gaps":["amount","vendor"]}"#)
    #expect(Koti.taskAction(gaps, now: now) == .complete)
    #expect(Koti.taskAction(gaps, now: now).label == "Täydennä")
    #expect(Koti.pendingSubtitle(gaps) == "Lisää summa ja myyjä")

    let bare = try item(#"{"id":"p3","kind":"pending_receipt","receiptId":"R3","party":"S-Market","amount":3,"gaps":[]}"#)
    #expect(Koti.pendingSubtitle(bare) == "Tarkista luokka ja ALV")
}

@Test func approvalGapWording() {
    #expect(KotiApproval.gapText(["amount", "vendor"]) == "Lisää summa ja myyjä")
    #expect(KotiApproval.gapText(["amount"]) == "Lisää summa")
    #expect(KotiApproval.gapText(["vendor"]) == "Lisää myyjä")
    #expect(KotiApproval.gapText([]) == "")
    #expect(KotiApproval.gapNote(["amount"]) == "Lisää summa, ennen kuin kuitin voi hyväksyä.")
    #expect(KotiApproval.subtitle(type: "meno", fromBank: false) == "Kuitti odottaa hyväksyntää")
    #expect(KotiApproval.subtitle(type: "tulo", fromBank: false) == "Tulokuitti odottaa hyväksyntää")
    #expect(KotiApproval.subtitle(type: "tulo", fromBank: true) == "Tunnistettu myynti pankkitililtä")
}

private func receipt(_ fields: String) throws -> Receipt {
    let json = #"{"id":"R1","type":"meno","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z""# + (fields.isEmpty ? "" : ",\(fields)") + "}"
    return try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
}

@Test func approvalSheetAsksOnlyForWhatIsMissing() throws {
    let empty = ReceiptForm(receipt: try receipt(""))
    #expect(KotiApproval.fields(baseline: empty, gaps: ["amount", "vendor"], errors: [:]) == [.vendor, .amount, .date, .category, .vat])

    let nearly = ReceiptForm(receipt: try receipt(#""vendor":"K-Market","date":"2026-10-01","category":"tarvikkeet","totalAmount":12.4,"vatDetails":[{"rate":25.5,"amount":2.52}]"#))
    #expect(KotiApproval.fields(baseline: nearly, gaps: [], errors: [:]).isEmpty)

    // A gap the server names is asked even when the text is there (a blank-looking vendor).
    #expect(KotiApproval.fields(baseline: nearly, gaps: ["vendor"], errors: [:]) == [.vendor])
    // A field the save refused is shown so it can be fixed in place.
    #expect(KotiApproval.fields(baseline: nearly, gaps: [], errors: ["totalAmount": "x", "vat-0": "y"]) == [.amount, .vat])
}

@Test func approvalPatchCarriesTheFilledGaps() throws {
    let r = try receipt(#""date":"2026-10-01","category":"tarvikkeet""#)
    let baseline = ReceiptForm(receipt: r)
    var form = baseline
    form.vendor = "K-Market"
    form.setTotal("12,40")
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: r.updatedAt) else {
        Issue.record("expected a patch"); return
    }
    #expect(patch.changes("vendor"))
    #expect(patch.changes("totalAmount"))
    #expect(!patch.changes("category"))
}

// MARK: ALV-raja (web :1118-1137)

@Test func vatThresholdWarnsFromThreeQuarters() throws {
    let below = try dashboard(#""vat":{"registered":false,"entityType":"toiminimi","ytdRevenue":14999,"threshold":20000}"#)
    #expect(Koti.vatThreshold(below) == nil)

    let near = try dashboard(#""vat":{"registered":false,"entityType":"toiminimi","ytdRevenue":15000,"threshold":20000}"#)
    let notice = try #require(Koti.vatThreshold(near))
    #expect(notice.title == "ALV-raja lähestyy")
    #expect(!notice.exceeded)
    #expect(notice.body == "Liikevaihtosi tänä vuonna on 15\(nbsp)000,00\(nbsp)€. Raja on 20\(nbsp)000,00\(nbsp)€. Rekisteröidy hyvissä ajoin.")

    let over = try dashboard(#""vat":{"registered":false,"entityType":"toiminimi","ytdRevenue":20000,"threshold":20000}"#)
    #expect(Koti.vatThreshold(over)?.title == "ALV-raja ylittynyt")
    #expect(Koti.vatThreshold(over)?.exceeded == true)
    #expect(Koti.vatThreshold(over)?.body.hasSuffix("Rekisteröidy OmaVerossa heti.") == true)

    // Registered owners, and a threshold figure that did not load, get no card.
    let registered = try dashboard(#""vat":{"registered":true,"entityType":"toiminimi","ytdRevenue":50000,"threshold":20000}"#)
    #expect(Koti.vatThreshold(registered) == nil)
    let failed = try dashboard(#""vat":{"registered":false,"entityType":"toiminimi","ytdRevenue":20000,"threshold":20000},"sectionErrors":{"threshold":"ALV-rajaa ei voitu laskea"}"#)
    #expect(Koti.vatThreshold(failed) == nil)
}

// MARK: ALV-ilmoitus deadline (web lib/vat-deadline.ts, lib/vat-due.ts)

@Test func kotiVatDueNamesThePeriodAndWhereItOpens() throws {
    let august = try #require(KotiVatDue(key: "2026-08"))
    #expect(august.label == "Elokuu 2026")
    #expect(august.dueIso == "2026-10-12")
    #expect(august.lastMonth == "2026-08")
    let q3 = try #require(KotiVatDue(key: "2026-Q3"))
    #expect(q3.label == "Q3/2026")
    #expect(q3.lastMonth == "2026-09")
    let year = try #require(KotiVatDue(key: "2026"))
    #expect(year.dueIso == "2027-03-01")
    #expect(year.lastMonth == "2026-12")
    #expect(KotiVatDue(key: "nonsense") == nil)
}

@Test func kotiShowsTheReturnDueNowOrTheMonthsOwn() {
    // The current month: the next return due. A past month: the period that month closes, if any.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month")?.key == "2026-08")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: nil)?.key == "2026-08")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "quarter")?.key == "2026-Q3")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: false, month: "2026-06", today: "2026-10-03", kind: "quarter")?.key == "2026-Q2")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: false, month: "2026-08", today: "2026-10-03", kind: "month")?.key == "2026-08")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: false, month: "2026-07", today: "2026-10-03", kind: "quarter") == nil)
    #expect(Koti.vatDue(registered: false, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month") == nil)
}

@Test func vatDueRowReadsAsOnEveryScreen() throws {
    let due = try #require(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-09", today: "2026-09-30", kind: "month"))
    let august = try figures(#"{"field308":{"label":"308","amount":159.38,"isRefund":false},"filing":null,"pendingReceiptCount":0}"#)
    #expect(Koti.vatDueTitle == "ALV-ilmoitus")
    #expect(Koti.vatDueSecondary(due, august) == "Elokuu 2026 · eräpäivä 12.10. · Ilmoittamatta")
    #expect(Koti.vatDueSecondary(due, nil) == "Elokuu 2026 · eräpäivä 12.10.")
    #expect(august.amount == Decimal(string: "159.38"))
    #expect(Koti.vatDueNotes(august).isEmpty)

    let september = try #require(KotiVatDue(key: "2026-09"))
    let refund = try figures(#"{"field308":{"amount":159.38,"isRefund":true},"filing":{"filedAt":"2026-10-05T00:00:00Z","paidAt":null,"filedAmount":-159.38}}"#)
    #expect(Koti.vatDueSecondary(september, refund) == "Syyskuu 2026 · palautus · eräpäivä 12.11. · Ilmoitettu")

    let filedUnpaid = try figures(#"{"field308":{"amount":100,"isRefund":false},"filing":{"filedAt":"2026-10-05T00:00:00Z","paidAt":null,"filedAmount":100}}"#)
    #expect(Koti.vatDueSecondary(september, filedUnpaid) == "Syyskuu 2026 · eräpäivä 12.11. · Ilmoitettu, maksamatta")
    let paid = try figures(#"{"field308":{"amount":100,"isRefund":false},"filing":{"filedAt":"2026-10-05T00:00:00Z","paidAt":"2026-10-06T00:00:00Z","filedAmount":100}}"#)
    #expect(Koti.vatDueSecondary(september, paid) == "Syyskuu 2026 · eräpäivä 12.11. · Maksettu")

    // F66: figures that moved after filing say so, in the line and in a note.
    let moved = try figures(#"{"field308":{"amount":170,"isRefund":false},"filing":{"filedAt":"2026-10-05T00:00:00Z","paidAt":null,"filedAmount":159.38},"pendingReceiptCount":2}"#)
    #expect(Koti.vatDueSecondary(september, moved) == "Syyskuu 2026 · eräpäivä 12.11. · Ilmoitettu, maksamatta · muuttunut ilmoituksen jälkeen")
    #expect(Koti.vatDueNotes(moved) == [
        "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu 159,38\(nbsp)€, nyt 170,00\(nbsp)€.",
        "2 kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä.",
    ])
    let one = try figures(#"{"field308":{"amount":1,"isRefund":false},"pendingReceiptCount":1}"#)
    #expect(Koti.vatDueNotes(one) == ["1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä."])
}

// MARK: Layout

@Test func kotiPlacesTheNewCards() {
    let base = KotiLayout.sections(.init())
    #expect(!base.contains(.onboarding))
    #expect(!base.contains(.vatThreshold))
    let both = KotiLayout.sections(.init(hasPositions: true, onboardingOpen: true, vatThreshold: true))
    #expect(both.first == .onboarding)
    #expect(both.firstIndex(of: .vatThreshold)! == both.firstIndex(of: .positions)! + 1)
}
