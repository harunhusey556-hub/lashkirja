import Testing
import Foundation
@testable import LashKirjaCore

private let nbsp = "\u{00A0}"

private func dashboard(_ extra: String) throws -> Dashboard {
    let json = #"{"month":"2026-10","income":0,"expenses":0,"matching":{"matchable":0,"matched":0,"suggested":0}"# + (extra.isEmpty ? "" : ",\(extra)") + "}"
    return try JSONDecoder().decode(Dashboard.self, from: Data(json.utf8))
}

private func bank(_ state: String, count: Int = 2, balance: Decimal = 1200, hasBalance: Bool = true) throws -> Dashboard.BankSummary {
    let json = #"{"totalBalance":\#(balance),"accountCount":\#(count),"needsAttention":0,"state":"\#(state)","hasBalance":\#(hasBalance)}"#
    return try JSONDecoder().decode(Dashboard.BankSummary.self, from: Data(json.utf8))
}

private func totals(_ open: Decimal, overdue: Decimal = 0, count: Int = 0) throws -> Dashboard.OpenTotals {
    let json = #"{"totalOpen":\#(open),"overdue":\#(overdue),"overdueCount":\#(count)}"#
    return try JSONDecoder().decode(Dashboard.OpenTotals.self, from: Data(json.utf8))
}

private let trend = BalanceTrend(points: [
    .init(month: "2026-09", balance: 1000),
    .init(month: "2026-08", balance: 1040),   // out of order: sorted
    .init(month: "2026-10", balance: 1120),
])

// MARK: Rahatilanne

@Test func balanceTrendNeedsTwoMonths() {
    #expect(!BalanceTrend(points: [.init(month: "2026-10", balance: 5)]).canDraw)
    #expect(!BalanceTrend(nil).canDraw)
    #expect(BalanceTrend(points: []).latestChange == nil)
    #expect(trend.points.map(\.month) == ["2026-08", "2026-09", "2026-10"])
    #expect(BalanceTrend.emptyText == "Saldon kehitys näkyy, kun tapahtumia on kahdelta kuukaudelta.")
}

@Test func balanceTrendSaysTheChangeSinceLastMonth() {
    #expect(trend.latestChange == 120)
    #expect(trend.changeLine(selected: nil) == "+120,00\(nbsp)€ syyskuun lopusta")
    #expect(trend.direction(selected: nil) == .up)
    #expect(trend.hero(selected: nil, total: 1123.5) == Decimal(string: "1123.5"))
    #expect(trend.caption(selected: nil, accountCount: 1, currentMonth: "2026-10") == "Pankkitilien saldo · 1 tili")
    #expect(trend.caption(selected: nil, accountCount: 2, currentMonth: "2026-10") == "Pankkitilien saldo · 2 tiliä")
}

@Test func scrubbingReadsOneMonth() {
    #expect(trend.caption(selected: "2026-09", accountCount: 2, currentMonth: "2026-10") == "Syyskuun lopussa")
    #expect(trend.caption(selected: "2026-10", accountCount: 2, currentMonth: "2026-10") == "Lokakuu tähän mennessä")
    #expect(trend.hero(selected: "2026-09", total: 1123) == 1000)
    #expect(trend.changeLine(selected: "2026-09") == "\u{2212}40,00\(nbsp)€ edellisestä kuusta")
    #expect(trend.direction(selected: "2026-09") == .down)
    // The first month has nothing before it.
    #expect(trend.changeLine(selected: "2026-08") == nil)
    #expect(trend.direction(selected: "2026-08") == nil)
    // A month outside the line reads as today.
    #expect(trend.hero(selected: "2025-01", total: 7) == 7)
}

@Test func flatChangeHasItsOwnSign() {
    let flat = BalanceTrend(points: [.init(month: "2026-09", balance: 50), .init(month: "2026-10", balance: Decimal(string: "50.001")!)])
    #expect(flat.changeLine(selected: nil) == "±0,00\(nbsp)€ syyskuun lopusta")
    #expect(flat.direction(selected: nil) == .flat)
    let level = BalanceTrend(points: [.init(month: "2026-09", balance: 50), .init(month: "2026-10", balance: 50)])
    #expect(level.yDomain == 45.0...55.0)
}

@Test func balanceRangeIsTheDatasOwn() {
    let domain = trend.yDomain!
    #expect(domain.lowerBound < 1000 && domain.lowerBound > 900)
    #expect(domain.upperBound > 1120 && domain.upperBound < 1200)
    #expect(BalanceTrend(points: []).yDomain == nil)
}

@Test func balanceSummaryForVoiceOver() {
    #expect(trend.accessibilitySummary(total: 1120) == "Pankkitilien saldo elokuu–lokakuu: nousi 80,00\(nbsp)€, nyt 1\(nbsp)120,00\(nbsp)€.")
    #expect(BalanceTrend(nil).accessibilitySummary(total: 5) == "Pankkitilien saldo 5,00\(nbsp)€.")
    let down = BalanceTrend(points: [.init(month: "2026-09", balance: 10), .init(month: "2026-10", balance: 4)])
    #expect(down.accessibilitySummary(total: 4) == "Pankkitilien saldo syyskuu–lokakuu: laski 6,00\(nbsp)€, nyt 4,00\(nbsp)€.")
}

@Test func balanceTrendFromTheDashboard() throws {
    let d = try dashboard(#""bankTrend":{"points":[{"month":"2026-09","balance":1.5},{"month":"2026-10","balance":403.13}]}"#)
    let t = BalanceTrend(d.bankTrend)
    #expect(t.latestChange == Decimal(string: "401.63"))
}

// MARK: Rows under Rahatilanne

@Test func balanceCardOnlyForAConnectedBankWithABalance() throws {
    #expect(Koti.showsBalanceCard(try bank("connected")))
    #expect(!Koti.showsBalanceCard(try bank("connected", hasBalance: false)))
    #expect(!Koti.showsBalanceCard(try bank("reconnect")))
    #expect(!Koti.showsBalanceCard(try bank("connected", count: 0)))
    #expect(!Koti.showsBalanceCard(nil))
}

@Test func bankRowSaysWhatToDo() throws {
    #expect(Koti.bankRow(try bank("connected")) == nil)       // the card instead
    #expect(Koti.bankRow(try bank("none", count: 0)) == nil)  // Käyttöönotto instead
    let reconnect = Koti.bankRow(try bank("reconnect"))!
    #expect(reconnect.secondary == "Yhteys vanhentunut — yhdistä uudelleen")
    #expect(reconnect.tone == .warning && reconnect.fixesBank && reconnect.amount == 1200)
    let unscoped = Koti.bankRow(try bank("unscoped"))!
    #expect(unscoped.amount == nil && unscoped.secondary == "Valitse kirjanpitoon kuuluvat tilit")
    let noBalance = Koti.bankRow(try bank("connected", count: 1, hasBalance: false))!
    #expect(noBalance.secondary == "1 tili · saldo ei vielä haettu")
    #expect(noBalance.accessibilityLabel == "Pankkitilit, 1 tili · saldo ei vielä haettu")
}

@Test func openInvoiceRows() throws {
    #expect(Koti.openRow(try totals(0), kind: .receivables) == nil)
    #expect(Koti.openRow(nil, kind: .payables) == nil)
    let calm = Koti.openRow(try totals(500), kind: .receivables)!
    #expect(calm.title == "Avoimet myyntilaskut" && calm.secondary == "Ei myöhässä olevia" && calm.tone == .normal)
    let late = Koti.openRow(try totals(500, overdue: 120, count: 2), kind: .payables)!
    #expect(late.title == "Avoimet ostolaskut")
    #expect(late.secondary == "2 laskua myöhässä · 120,00\(nbsp)€")
    #expect(late.tone == .danger)
    #expect(Koti.openRow(try totals(500, overdue: 80, count: 1), kind: .receivables)!.secondary == "1 lasku myöhässä · 80,00\(nbsp)€")
    #expect(Koti.openRow(try totals(500, overdue: 80, count: 0), kind: .receivables)!.secondary == "80,00\(nbsp)€ myöhässä")
    #expect(late.accessibilityLabel == "Avoimet ostolaskut, 500,00\(nbsp)€, 2 laskua myöhässä · 120,00\(nbsp)€")
}

@Test func positionRowsLeaveOutFiguresThatDidNotLoad() throws {
    let both = #""receivables":{"totalOpen":10,"overdue":0,"overdueCount":0},"payables":{"totalOpen":20,"overdue":0,"overdueCount":0}"#
    #expect(Koti.positionRows(try dashboard(both)).map(\.kind) == [.receivables, .payables])
    let failed = try dashboard(both + #","sectionErrors":{"position":"Saamisia ja velkoja ei saatu ladattua."}"#)
    #expect(Koti.positionRows(failed).isEmpty)
    let reconnect = try dashboard(#""bank":{"totalBalance":1,"accountCount":1,"needsAttention":1,"state":"reconnect","hasBalance":true}"#)
    #expect(Koti.positionRows(reconnect).map(\.kind) == [.bank])
}

@Test func positionHeadings() {
    #expect(Koti.positionsTitle(hasBalanceCard: true, atCurrentMonth: false) == "Avoimet laskut")
    #expect(Koti.positionsTitle(hasBalanceCard: false, atCurrentMonth: true) == "Rahatilanne")
    #expect(Koti.positionsTitle(hasBalanceCard: false, atCurrentMonth: false) == "Rahatilanne tänään")
    #expect(Koti.vatLine(isRefund: true) == "ALV-arvio · palautusta")
    #expect(Koti.vatLine(isRefund: nil) == "ALV-arvio · maksettavaa")
}

// MARK: Order

@Test func moneyComesRightAfterTheStatus() {
    let all = KotiLayout.sections(.init(setupOpen: true, partialFailure: true, balanceCard: true, hasTasks: true, failedJobs: true,
                                        hasPositions: true, cashflowMoved: true, handled: true))
    #expect(all == [.status, .partialFailure, .balance, .tasks, .failedJobs, .money, .positions, .setup, .cashflow, .handled])
    #expect(KotiLayout.sections(.init()) == [.status, .money])
}

@Test func brandNewAccountStartsWithSetup() {
    let fresh = KotiLayout.sections(.init(brandNew: true, setupOpen: true))
    #expect(fresh == [.setup, .status, .money])
}

@Test func pastMonthsDropThisWeeksParts() {
    let past = KotiLayout.sections(.init(atCurrentMonth: false, brandNew: true, setupOpen: true, balanceCard: true, cashflowMoved: true, handled: true))
    #expect(past == [.status, .balance, .money, .cashflow])
}

@Test func layoutReadsTheDashboard() throws {
    let d = try dashboard(#"""
    "bank":{"totalBalance":1,"accountCount":1,"needsAttention":0,"state":"connected","hasBalance":true},
    "setup":{"receipts":true,"bank":true,"seller":false,"empty":false},
    "cashflow":[{"month":"2026-10","income":0,"expenses":3}],
    "handled":{"count":2,"parts":[{"kind":"email_receipt","count":2,"label":"2 kuittia sähköpostista"}]}
    """#)
    let input = KotiLayout.Input(dashboard: d, atCurrentMonth: true, hasTasks: false, failedJobs: 0)
    #expect(!input.setupOpen)   // only the seller step is open: no card (as before)
    #expect(KotiLayout.sections(input) == [.status, .balance, .money, .cashflow, .handled])
}

// MARK: Hoidettu automaattisesti, Tulot ja menot

@Test func handledWording() {
    #expect(Koti.handledTitle(count: 1) == "1 tapahtuma tällä viikolla")
    #expect(Koti.handledTitle(count: 14) == "14 tapahtumaa tällä viikolla")
    #expect(Koti.handledDetail(labels: []) == "")
    #expect(Koti.handledDetail(labels: ["2 kuittia sähköpostista"]) == "2 kuittia sähköpostista")
    #expect(Koti.handledDetail(labels: ["a", "b", "c"]) == "a, b ja c")
    #expect(Koti.handledTarget(firstKind: "reference_payment") == .bankFeed)
    #expect(Koti.handledTarget(firstKind: "recurring_invoice") == .recurringInvoices)
    #expect(Koti.handledTarget(firstKind: nil) == .receipts)
}

@Test func cashflowMonthsStepAndSpeak() throws {
    let months = ["2026-08", "2026-10", "2026-09"]
    #expect(Koti.adjacentMonth(months, from: "2026-09", step: 1) == "2026-10")
    #expect(Koti.adjacentMonth(months, from: "2026-08", step: -1) == nil)
    #expect(Koti.adjacentMonth(months, from: "2025-01", step: 1) == nil)
    let rows = try dashboard(#""cashflow":[{"month":"2026-09","income":10,"expenses":2.5},{"month":"2026-10","income":0,"expenses":0}]"#).cashflow
    #expect(Koti.cashflowSummary(rows, selected: "2026-09") == "Tulot ja menot, 2 kuukautta. Syyskuu: tulot 10,00\(nbsp)€, menot 2,50\(nbsp)€.")
    #expect(Koti.cashflowSummary(rows, selected: "2026-01") == "Tulot ja menot, 2 kuukautta.")
}

@Test func failedSectionsInASteadyOrder() {
    #expect(Koti.failedSections(nil).isEmpty)
    #expect(Koti.failedSections(["vat": "B", "items": "A"]) == ["A", "B"])
}

// MARK: A brand-new account (TF-06)

private let freshSetup = #""setup":{"receipts":false,"bank":false,"seller":false,"empty":true}"#

private func setup(_ json: String) throws -> Dashboard.Setup {
    try #require(try dashboard(json).setup)
}

@Test func freshAccountIsNothingBookedAndNoBank() throws {
    #expect(Koti.isFreshAccount(try dashboard(freshSetup)))
    // The seller details alone do not start the books.
    #expect(Koti.isFreshAccount(try dashboard(#""setup":{"receipts":false,"bank":false,"seller":true,"empty":true}"#)))
    #expect(!Koti.isFreshAccount(try dashboard(#""setup":{"receipts":true,"bank":false,"seller":false,"empty":false}"#)))
    #expect(!Koti.isFreshAccount(try dashboard(#""setup":{"receipts":false,"bank":true,"seller":false,"empty":true}"#)))
    // An invoice (empty false) is something booked.
    #expect(!Koti.isFreshAccount(try dashboard(#""setup":{"receipts":false,"bank":false,"seller":true,"empty":false}"#)))
    // A setup that did not load is no reason to hide the month.
    #expect(!Koti.isFreshAccount(try dashboard("")))
}

@Test func freshAccountStartsFromTheSetupCardWithoutRingOrZeroCards() throws {
    let input = KotiLayout.Input(dashboard: try dashboard(freshSetup), atCurrentMonth: true, hasTasks: false, failedJobs: 0)
    #expect(input.fresh)
    let sections = KotiLayout.sections(input)
    #expect(sections == [.setup, .firstRunNote])
    #expect(!sections.contains(.status) && !sections.contains(.money))
}

@Test func freshAccountKeepsTheOnboardingCardOnTopAndTheFailures() {
    let all = KotiLayout.sections(.init(brandNew: true, fresh: true, setupOpen: true, partialFailure: true, hasTasks: true, failedJobs: true,
                                        hasPositions: true, cashflowMoved: true, handled: true, onboardingOpen: true, vatThreshold: true))
    #expect(all == [.onboarding, .setup, .partialFailure, .tasks, .failedJobs, .firstRunNote])
}

@Test func freshAccountOnAPastMonthShowsNoZeroFiguresEither() {
    let past = KotiLayout.sections(.init(atCurrentMonth: false, brandNew: true, fresh: true, setupOpen: true))
    #expect(past == [.firstRunNote])
}

@Test func anAccountWithABankLooksAsBefore() throws {
    // Brand-new by its books but with a bank: the old order, setup first.
    let banked = try dashboard(#""setup":{"receipts":false,"bank":true,"seller":false,"empty":true}"#)
    let input = KotiLayout.Input(dashboard: banked, atCurrentMonth: true, hasTasks: false, failedJobs: 0)
    #expect(!input.fresh)
    #expect(KotiLayout.sections(input) == [.setup, .status, .money])
}

@Test func setupProgressCountsAndPicksTheNextStep() throws {
    let none = Koti.setupProgress(try setup(freshSetup))
    #expect(none.rows.map(\.step) == [.receipt, .bank, .seller])
    #expect(none.done == 0 && none.total == 3)
    #expect(none.label == "0/3 valmis")
    #expect(none.next == .receipt)
    #expect(!none.complete)

    let seller = Koti.setupProgress(try setup(#""setup":{"receipts":false,"bank":false,"seller":true,"empty":true}"#))
    #expect(seller.label == "1/3 valmis")
    #expect(seller.accessibilityLabel == "Tehty 1, jäljellä 2")
    #expect(seller.next == .receipt)

    let receipt = Koti.setupProgress(try setup(#""setup":{"receipts":true,"bank":false,"seller":false,"empty":false}"#))
    #expect(receipt.next == .bank)
    #expect(receipt.rowAccessibilityLabel(receipt.rows[1])
            == "Yhdistä pankki, seuraava askel. Tapahtumat tulevat itsestään ja maksut kohdistuvat laskuihin.")
    #expect(receipt.rowAccessibilityLabel(receipt.rows[0]).hasPrefix("Kuvaa ensimmäinen kuitti, valmis."))
    #expect(receipt.rowAccessibilityLabel(receipt.rows[2]).hasPrefix("Täydennä laskuttajan tiedot, tekemättä."))

    let all = Koti.setupProgress(try setup(#""setup":{"receipts":true,"bank":true,"seller":true,"empty":false}"#))
    #expect(all.complete && all.next == nil && all.label == "3/3 valmis")
}

@Test func setupStepsSayWhyAndHaveASymbol() {
    for step in Koti.SetupStep.allCases {
        #expect(!step.benefit.isEmpty && !step.symbol.isEmpty && !step.actionTitle.isEmpty)
    }
    #expect(Koti.SetupStep.receipt.actionTitle == "Kuvaa kuitti")
    #expect(Koti.firstRunTitle == "Aloitetaan")
    #expect(Koti.firstRunLead == "Kolme askelta, niin kirjanpito pyörii itsestään.")
    #expect(!Koti.firstRunNote.contains("0,00"))
}

// MARK: The status ring

@Test func emptyMonthIsNeverAFullRingOrKaikkiKunnossa() {
    let empty = Koti.monthStatus(done: 0, total: 0, blocking: 0)
    #expect(empty.progress == nil)
    #expect(empty.headline == "Ei vielä tapahtumia tässä kuussa")
    #expect(empty.detail == nil)
    // Something to do still says so, without a ring.
    let todo = Koti.monthStatus(done: 0, total: 0, blocking: 2)
    #expect(todo.progress == nil && todo.headline == "2 asiaa ennen kuun loppua")
}

@Test func countedMonthKeepsItsRing() {
    let half = Koti.monthStatus(done: 3, total: 6, blocking: 1)
    #expect(half.progress == 0.5)
    #expect(half.headline == "1 asia ennen kuun loppua")
    #expect(half.detail == "3 / 6 tapahtumaa on kunnossa")
    let all = Koti.monthStatus(done: 4, total: 4, blocking: 0)
    #expect(all.progress == 1 && all.headline == "Kaikki kunnossa")
}

// MARK: Greeting (web lib/koti-greeting.test.ts)

@Test func greetingHasTheWebsHourBoundaries() {
    #expect(Koti.timeOfDayGreeting(hour: 4, firstName: "A") == "Hyvää yötä, A")
    #expect(Koti.timeOfDayGreeting(hour: 5, firstName: "A") == "Hyvää huomenta, A")
    #expect(Koti.timeOfDayGreeting(hour: 9, firstName: "A") == "Hyvää huomenta, A")
    #expect(Koti.timeOfDayGreeting(hour: 10, firstName: "A") == "Hyvää päivää, A")
    #expect(Koti.timeOfDayGreeting(hour: 16, firstName: "A") == "Hyvää päivää, A")
    #expect(Koti.timeOfDayGreeting(hour: 17, firstName: "A") == "Hyvää iltaa, A")
    #expect(Koti.timeOfDayGreeting(hour: 22, firstName: "A") == "Hyvää iltaa, A")
    #expect(Koti.timeOfDayGreeting(hour: 23, firstName: "A") == "Hyvää yötä, A")
    #expect(Koti.timeOfDayGreeting(hour: 0, firstName: "") == "Hyvää yötä")
}

@Test func greetingReadsTheOwnersClock() throws {
    let helsinki = try #require(TimeZone(identifier: "Europe/Helsinki"))
    let iso = ISO8601DateFormatter()
    // The owner's screenshot: 19:16 in October is evening, not "päivää".
    let screenshot = try #require(iso.date(from: "2026-10-03T16:16:00Z"))
    let morning = try #require(iso.date(from: "2026-10-14T05:30:00Z"))   // 08:30
    let day = try #require(iso.date(from: "2026-10-14T10:00:00Z"))       // 13:00
    let night = try #require(iso.date(from: "2026-10-14T21:30:00Z"))     // 00:30
    let winter = try #require(iso.date(from: "2026-10-31T20:30:00Z"))    // 22:30, winter time from 25.10.
    #expect(Koti.greeting(at: screenshot, firstName: "Harun", timeZone: helsinki) == "Hyvää iltaa, Harun")
    #expect(Koti.greeting(at: morning, firstName: "Liisa", timeZone: helsinki) == "Hyvää huomenta, Liisa")
    #expect(Koti.greeting(at: day, firstName: "Liisa", timeZone: helsinki) == "Hyvää päivää, Liisa")
    #expect(Koti.greeting(at: night, firstName: "Liisa", timeZone: helsinki) == "Hyvää yötä, Liisa")
    #expect(Koti.greeting(at: winter, firstName: "Liisa", timeZone: helsinki) == "Hyvää iltaa, Liisa")
}

@Test func greetingSaysNothingWithoutAName() throws {
    let utc = try #require(TimeZone(identifier: "UTC"))
    #expect(Koti.greeting(at: Date(), firstName: nil) == nil)
    #expect(Koti.greeting(at: Date(), firstName: " ") == nil)
    #expect(Koti.greeting(at: Date(timeIntervalSince1970: 0), firstName: " Liisa ", timeZone: utc) == "Hyvää yötä, Liisa")
}

// MARK: ALV-ilmoitus before the account existed

@Test func vatReturnBeforeTheAccountIsNotAsked() {
    // Opened in October: August's return (due 12.10.) is not this account's to file.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month",
                        accountCreatedMonth: "2026-10") == nil)
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month",
                        accountCreatedMonth: "2026-09") == nil)
    // Opened in August: the August return is the owner's.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month",
                        accountCreatedMonth: "2026-08")?.key == "2026-08")
    // Opened inside the quarter: Q3 (ends in September) is the owner's.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "quarter",
                        accountCreatedMonth: "2026-08")?.key == "2026-Q3")
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "quarter",
                        accountCreatedMonth: "2026-10") == nil)
    // A past month before the account: nothing.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: false, month: "2026-08", today: "2026-10-03", kind: "month",
                        accountCreatedMonth: "2026-10") == nil)
    // Without the field (an older server): as before.
    #expect(Koti.vatDue(registered: true, atCurrentMonth: true, month: "2026-10", today: "2026-10-03", kind: "month")?.key == "2026-08")
}

@Test func dashboardReadsTheAccountMonth() throws {
    #expect(try dashboard(#""accountCreatedMonth":"2026-10""#).accountCreatedMonth == "2026-10")
    #expect(try dashboard("").accountCreatedMonth == nil)
    #expect(try dashboard(#""accountCreatedMonth":null"#).accountCreatedMonth == nil)
}
