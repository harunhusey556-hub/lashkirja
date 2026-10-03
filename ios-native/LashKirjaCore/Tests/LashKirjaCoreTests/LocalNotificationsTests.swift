import Testing
import Foundation
@testable import LashKirjaCore

private let helsinki: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/Helsinki")!
    return calendar
}()

/// 3.10.2026 at the given Helsinki time.
private func at(_ hour: Int, _ minute: Int = 0, day: Int = 3) -> Date {
    helsinki.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
}

private func item(_ kind: String, _ id: String, href: String = "/kuitit") -> FeedNotification {
    FeedNotification(id: id, kind: kind, title: "Otsikko \(id)", body: "Teksti", href: href, createdAt: "2026-10-03T08:00:00.000Z")
}

@Test func decodesTheServerFeed() throws {
    let json = """
    {"items":[{"id":"missing-receipt:t1","kind":"missing_receipt","title":"Kuitti puuttuu","body":"K-Market 24,90 €","href":"/pankki/tapahtumat?month=2026-09&nayta=toimet&rivi=t1","createdAt":"2026-10-03T08:00:00.000Z"},
               {"id":"x:1","kind":"something_new","title":"?","body":"?","href":"/","createdAt":"2026-10-03T08:00:00.000Z"}],
     "cursor":"2026-10-03T09:00:00.000Z","counts":{"missing_receipt":4,"overdue_invoice":1}}
    """
    let feed = try JSONDecoder().decode(NotificationFeed.self, from: Data(json.utf8))
    #expect(feed.cursor == "2026-10-03T09:00:00.000Z")
    #expect(feed.items.count == 2)
    #expect(feed.items[0].knownKind == .missingReceipt)
    #expect(feed.items[0].transactionId == "t1")
    #expect(feed.items[1].knownKind == nil)
    #expect(feed.counts["missing_receipt"] == 4)
}

@Test func quietHoursWrapPastMidnight() {
    let quiet = QuietHours(startHour: 21, endHour: 8)
    #expect(quiet.contains(at(21), calendar: helsinki))
    #expect(quiet.contains(at(23, 30), calendar: helsinki))
    #expect(quiet.contains(at(3), calendar: helsinki))
    #expect(quiet.contains(at(7, 59), calendar: helsinki))
    #expect(!quiet.contains(at(8), calendar: helsinki))
    #expect(!quiet.contains(at(20, 59), calendar: helsinki))
    // Same start and end: no quiet hours at all.
    #expect(!QuietHours(startHour: 8, endHour: 8).contains(at(8), calendar: helsinki))
    // A daytime window works too.
    let day = QuietHours(startHour: 9, endHour: 17)
    #expect(day.contains(at(12), calendar: helsinki))
    #expect(!day.contains(at(18), calendar: helsinki))
    #expect(quiet.end(after: at(23), calendar: helsinki) == at(8, day: 4))
    #expect(quiet.end(after: at(3), calendar: helsinki) == at(8))
}

@Test func deliveredIdsAreBoundedAndKeepTheNewest() {
    var store = DeliveredIds()
    store = store.adding((0..<600).map { "id\($0)" })
    #expect(store.ids.count == DeliveredIds.limit)
    #expect(store.contains("id599"))
    #expect(!store.contains("id0"))
    // Adding an id already there does not duplicate it.
    let again = store.adding(["id599"])
    #expect(again.ids.count == DeliveredIds.limit)
}

@Test func prefsDefaultsAndDecodingOlderData() throws {
    let prefs = NotificationPrefs()
    #expect(prefs.enabled)
    #expect(prefs.quietHours == QuietHours(startHour: 21, endHour: 8))
    #expect(!prefs.dailySummary)
    #expect(prefs.summaryHour == 18 && prefs.summaryMinute == 0)
    #expect(NotificationKind.allCases.allSatisfy { prefs.isOn($0) })
    let decoded = try JSONDecoder().decode(NotificationPrefs.self, from: Data(#"{"enabled":false}"#.utf8))
    #expect(!decoded.enabled)
    #expect(decoded.quietHoursOn)
    var muted = prefs
    muted.set(.overdueInvoice, on: false)
    #expect(!muted.isOn(.overdueInvoice))
}

@Test func planSendsNewItemsOnceEachWhenFew() {
    let items = [item("missing_receipt", "missing-receipt:a"), item("vat_due", "vat-due:2026-08"), item("missing_receipt", "missing-receipt:b")]
    let delivered = DeliveredIds().adding(["missing-receipt:b"])
    let plan = NotificationPlanner.plan(items, prefs: NotificationPrefs(), delivered: delivered, now: at(12), calendar: helsinki)
    #expect(!plan.hold)
    #expect(plan.outgoing.map(\.id) == ["missing-receipt:a", "vat-due:2026-08"])
    #expect(plan.outgoing[0].threadId == "lk.missing_receipt")
    #expect(plan.outgoing[0].transactionId == "a")
    #expect(plan.outgoing[0].categoryId == NotificationAction.missingReceiptCategory)
    #expect(plan.outgoing[1].categoryId == nil)
    #expect(Set(plan.markDelivered) == ["missing-receipt:a", "vat-due:2026-08"])
}

@Test func planSumsUpAKindWhenThereAreTooMany() {
    let items = (1...4).map { item("missing_receipt", "missing-receipt:\($0)") } + [item("vat_due", "vat-due:2026-08")]
    let plan = NotificationPlanner.plan(items, prefs: NotificationPrefs(), delivered: DeliveredIds(), now: at(12), calendar: helsinki)
    #expect(plan.outgoing.count == 2)
    let summary = plan.outgoing.first { $0.kind == .missingReceipt }!
    #expect(summary.id == "lk.summary.missing_receipt")
    #expect(summary.body == "4 ostoa odottaa kuittia.")
    #expect(summary.href == "/pankki/tapahtumat?nayta=toimet")
    #expect(summary.transactionId == nil)
    #expect(summary.threadId == "lk.missing_receipt")
    #expect(plan.outgoing.contains { $0.id == "vat-due:2026-08" })
    #expect(plan.markDelivered.count == 5)
}

@Test func planHoldsDuringQuietHoursAndMutesDisabledKinds() {
    var prefs = NotificationPrefs()
    prefs.set(.overdueInvoice, on: false)
    let items = [item("missing_receipt", "missing-receipt:a"), item("overdue_invoice", "overdue-invoice:i:0")]
    let quiet = NotificationPlanner.plan(items, prefs: prefs, delivered: DeliveredIds(), now: at(22), calendar: helsinki)
    #expect(quiet.hold)
    #expect(quiet.outgoing.isEmpty)
    // A muted kind is put aside for good; the rest waits for the morning.
    #expect(quiet.markDelivered == ["overdue-invoice:i:0"])

    let day = NotificationPlanner.plan(items, prefs: prefs, delivered: DeliveredIds(), now: at(9), calendar: helsinki)
    #expect(!day.hold)
    #expect(day.outgoing.map(\.id) == ["missing-receipt:a"])

    var noQuiet = NotificationPrefs()
    noQuiet.quietHoursOn = false
    #expect(!NotificationPlanner.plan(items, prefs: noQuiet, delivered: DeliveredIds(), now: at(22), calendar: helsinki).hold)
}

@Test func planIgnoresUnknownKinds() {
    let plan = NotificationPlanner.plan([item("something_new", "x:1")], prefs: NotificationPrefs(), delivered: DeliveredIds(),
                                        now: at(12), calendar: helsinki)
    #expect(plan.outgoing.isEmpty)
    #expect(plan.markDelivered.isEmpty)
}

@Test func runSummaryTexts() {
    #expect(NotificationPlanner.summary(.missingReceipt, count: 1).body == "1 osto odottaa kuittia.")
    #expect(NotificationPlanner.summary(.overdueInvoice, count: 3).body == "3 laskua on myöhässä.")
    #expect(NotificationPlanner.summary(.overdueInvoice, count: 3).href == "/laskut?status=overdue")
    #expect(NotificationPlanner.summary(.receiptReview, count: 2).body == "2 kuittia odottaa tarkistusta.")
    #expect(NotificationPlanner.summary(.receiptReview, count: 2).href == "/sahkoposti")
    #expect(NotificationPlanner.summary(.bankSyncFailed, count: 2).href == "/tyot")
}

@Test func dailySummaryCountsOnlyEnabledKinds() {
    var prefs = NotificationPrefs()
    prefs.dailySummary = true
    let counts = ["missing_receipt": 3, "overdue_invoice": 1, "receipt_review": 0, "vat_due": 1]
    let text = NotificationPlanner.dailySummary(counts: counts, prefs: prefs)
    #expect(text?.title == "Päivän yhteenveto")
    #expect(text?.body == "3 ostoa odottaa kuittia, 1 lasku myöhässä, ALV-ilmoitus tekemättä.")
    prefs.set(.missingReceipt, on: false)
    #expect(NotificationPlanner.dailySummary(counts: counts, prefs: prefs)?.body == "1 lasku myöhässä, ALV-ilmoitus tekemättä.")
    // Nothing open: no summary at all.
    #expect(NotificationPlanner.dailySummary(counts: ["missing_receipt": 0], prefs: prefs) == nil)
    prefs.dailySummary = false
    #expect(NotificationPlanner.dailySummary(counts: counts, prefs: prefs) == nil)
}

@Test func dailySummaryFiresAtTheNextChosenTime() {
    var prefs = NotificationPrefs()
    prefs.summaryHour = 18
    #expect(NotificationPlanner.nextDailySummary(after: at(12), prefs: prefs, calendar: helsinki) == at(18))
    #expect(NotificationPlanner.nextDailySummary(after: at(18), prefs: prefs, calendar: helsinki) == at(18, day: 4))
    #expect(NotificationPlanner.nextDailySummary(after: at(19), prefs: prefs, calendar: helsinki) == at(18, day: 4))
}

@Test func backgroundRefreshAsksAgainInAboutNinetyMinutesOutsideQuietHours() {
    let prefs = NotificationPrefs()
    #expect(NotificationPlanner.nextRefresh(after: at(12), prefs: prefs, calendar: helsinki) == at(13, 30))
    // 20:00 + 90 min falls at 21:30, inside quiet hours: no point waking before 8.
    #expect(NotificationPlanner.nextRefresh(after: at(20), prefs: prefs, calendar: helsinki) == at(8, day: 4))
    #expect(NotificationPlanner.nextRefresh(after: at(23), prefs: prefs, calendar: helsinki) == at(8, day: 4))
}

@Test func permissionIsAskedOnceWhenAReceiptIsFirstMissing() {
    #expect(NotificationPlanner.shouldAskPermission(undetermined: true, askedBefore: false, firstRun: false, missingReceipts: 1))
    #expect(!NotificationPlanner.shouldAskPermission(undetermined: true, askedBefore: false, firstRun: true, missingReceipts: 1))
    #expect(!NotificationPlanner.shouldAskPermission(undetermined: true, askedBefore: true, firstRun: false, missingReceipts: 1))
    #expect(!NotificationPlanner.shouldAskPermission(undetermined: true, askedBefore: false, firstRun: false, missingReceipts: 0))
    #expect(!NotificationPlanner.shouldAskPermission(undetermined: false, askedBefore: false, firstRun: false, missingReceipts: 3))
}

@Test func tapOpensTheLinkOrTheCamera() {
    #expect(NotificationTap.resolve(href: "/laskut/lasku?id=i1", transactionId: nil, action: nil) == .route("/laskut/lasku?id=i1"))
    #expect(NotificationTap.resolve(href: "/pankki/tapahtumat?rivi=t1", transactionId: "t1", action: NotificationAction.capture) == .capture("t1"))
    #expect(NotificationTap.resolve(href: "/pankki/tapahtumat?rivi=t1", transactionId: "t1", action: nil) == .route("/pankki/tapahtumat?rivi=t1"))
    #expect(NotificationTap.resolve(href: nil, transactionId: nil, action: nil) == .none)
    #expect(NotificationTap.resolve(href: "", transactionId: nil, action: nil) == .none)
}

@Test func everyKindHasASettingsLabel() {
    #expect(NotificationKind.allCases.count == 6)
    #expect(NotificationKind.missingReceipt.label == "Puuttuvat kuitit")
    #expect(NotificationKind.allCases.allSatisfy { !$0.label.isEmpty && !$0.detail.isEmpty })
}

/// Every href the server and the summaries use opens a screen (AppLink), none is a dead end.
@Test func everyNotificationLinkOpensAScreen() {
    #expect(AppLink.parse("/pankki/tapahtumat?month=2026-09&nayta=toimet&rivi=t1") == .bankFeed(month: "2026-09", onlyOpen: true, transactionId: "t1"))
    #expect(AppLink.parse("/laskut/lasku?id=i1") == .invoice("i1"))
    #expect(AppLink.parse("/kirjanpito/alv?period=2026-08") == .alv("2026-08"))
    #expect(AppLink.parse("/kirjanpito/kuukausi?month=2026-09") == .periods)
    #expect(AppLink.parse("/tyot") == .workQueue)
    #expect(AppLink.parse("/kuitit/kuitti?id=r1") == .receipt("r1"))
    for kind in NotificationKind.allCases {
        #expect(AppLink.parse(NotificationPlanner.summary(kind, count: 2).href) != nil, "\(kind)")
    }
}
