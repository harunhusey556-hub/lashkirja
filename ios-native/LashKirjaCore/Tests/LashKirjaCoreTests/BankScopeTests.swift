import Testing
import Foundation
@testable import LashKirjaCore

private func decodeConnections(_ json: String) throws -> BankConnections {
    try JSONDecoder().decode(BankConnections.self, from: Data(json.utf8))
}

private let newServer = #"""
{"enabled":true,"ready":true,"connections":[{"id":"c1","aspspName":"Nordea","aspspCountry":"FI","aspspLogo":null,
"psuType":"business","status":"active","validUntil":null,"lastSyncAt":null,"lastSuccessAt":null,"lastError":null,
"historyFrom":"2026-01-01","historyLimitDays":395,
"accounts":[{"id":"a1","iban":"FI2112345600000785","label":"Käyttötili","currency":"EUR","inScope":false,"balance":401.27,"balanceAt":"2026-10-02T08:05:00.000Z"},
{"id":"a2","iban":"FI5810171000000122","label":null,"currency":"EUR","inScope":false,"balance":null,"balanceAt":null}]}]}
"""#

private let oldServer = #"""
{"enabled":true,"ready":true,"connections":[{"id":"c1","aspspName":"OP","aspspLogo":null,"status":"active",
"accounts":[{"id":"a1","iban":"FI2112345600000785","name":"Tili","inScope":true}]}]}
"""#

private func account(_ id: String, inScope: Bool?) -> BankConnection.Account {
    BankConnection.Account(id: id, name: nil, iban: nil, inScope: inScope)
}

@Test func bankConnectionDecodesScopeAndHistory() throws {
    let c = try decodeConnections(newServer).connections[0]
    #expect(c.historyFrom == "2026-01-01")
    #expect(c.historyLimitDays == 395)
    #expect(c.reportsHistory)
    let a = try #require(c.accounts?.first)
    #expect(a.name == "Käyttötili")
    #expect(a.balance == Decimal(string: "401.27"))
    #expect(BankScope.iban(a) == "FI21 1234 5600 0007 85")
    #expect(BankScope.title(c.accounts![1]) == "Tili")
}

@Test func bankConnectionDecodesOldServerWithoutHistory() throws {
    let c = try decodeConnections(oldServer).connections[0]
    #expect(c.historyFrom == nil)
    #expect(c.historyLimitDays == nil)
    #expect(!c.reportsHistory)
    #expect(!BankHistory.canFetchOlder(c))
    #expect(c.accounts?.first?.name == "Tili")
    #expect(c.accounts?.first?.inScope == true)
}

@Test func bankScopeUnscopedNeedsAnActiveConnectionWithAccounts() throws {
    let c = try decodeConnections(newServer).connections[0]
    #expect(BankScope.isUnscoped(c))
    #expect(BankScope.shouldAskAfterConnect(c))
    #expect(BankScope.summary(c) == "Yhtään tiliä ei ole valittu kirjanpitoon")

    let partly = BankConnection(id: "c", aspspName: "N", accounts: [account("a", inScope: true), account("b", inScope: false)])
    #expect(!BankScope.isUnscoped(partly))
    #expect(BankScope.shouldAskAfterConnect(partly))
    #expect(BankScope.summary(partly) == "1/2 tiliä kirjanpidossa")

    let all = BankConnection(id: "c", aspspName: "N", accounts: [account("a", inScope: true), account("b", inScope: true)])
    #expect(!BankScope.shouldAskAfterConnect(all))
    #expect(BankScope.summary(all) == "Kaikki 2 tiliä kirjanpidossa")

    let empty = BankConnection(id: "c", aspspName: "N", accounts: [])
    #expect(!BankScope.isUnscoped(empty))
    #expect(!BankScope.shouldAskAfterConnect(empty))

    let expired = BankConnection(id: "c", aspspName: "N", status: "expired", accounts: [account("a", inScope: false)])
    #expect(!BankScope.isUnscoped(expired))
    #expect(BankScope.unscoped([c, partly, expired]).map(\.id) == ["c1"])
}

@Test func bankScopeNeedsOneAccountAndSendsEveryChoice() {
    let c = BankConnection(id: "c", aspspName: "N", accounts: [account("a", inScope: true), account("b", inScope: false)])
    #expect(BankScope.problem(selected: [], in: c) == BankScope.atLeastOneMessage)
    #expect(BankScope.problem(selected: ["zzz"], in: c) == BankScope.atLeastOneMessage)
    #expect(BankScope.problem(selected: ["b"], in: c) == nil)
    #expect(BankScope.body(selected: ["b"], in: c).accounts == [
        BankScope.Change(id: "a", inScope: false),
        BankScope.Change(id: "b", inScope: true),
    ])
    #expect(BankScope.inScopeIDs(c) == ["a"])
}

@Test func bankSyncSummaryCountsInFinnish() throws {
    let r = try JSONDecoder().decode(BankSyncResult.self, from: Data(#"{"ok":true,"imported":12,"skipped":3,"statementId":"s"}"#.utf8))
    #expect(r.summary == "Haettiin 12 tapahtumaa.")
    #expect(BankSyncResult(imported: 1).summary == "Haettiin 1 tapahtuma.")
    #expect(BankSyncResult(imported: 0).summary == "Ei uusia tapahtumia.")
    #expect(BankSyncResult(imported: 2, notice: "Osa tapahtumista odottaa.").summary == "Haettiin 2 tapahtumaa. Osa tapahtumista odottaa.")
}

@Test func bankHistoryConnectChoicesMatchTheWeb() {
    let choices = BankHistory.connectChoices(today: "2026-10-03")
    #expect(choices.map(\.key) == ["month", "year", "12m", "all"])
    #expect(choices.map(\.from) == ["2026-10-01", "2026-01-01", "2025-11-01", nil])
    #expect(choices[1].label == "Vuoden 2026 alusta")
    #expect(choices.contains { $0.key == BankHistory.defaultKey })
    // January: twelve months back crosses the year.
    #expect(BankHistory.connectChoices(today: "2026-01-15")[2].from == "2025-02-01")
}

@Test func bankHistoryRangeLabel() {
    #expect(BankHistory.rangeLabel("2026-01-01") == "Hakuväli: 1.1.2026 alkaen")
    #expect(BankHistory.rangeLabel(nil) == "Hakuväli: kaikki, mitä pankki antaa")
}

@Test func bankHistoryBackfillRespectsCurrentStartAndBankLimit() {
    // Limit 395 days from 2026-10-03: earliest 2025-09-04.
    #expect(BankHistory.earliest(limitDays: 395, today: "2026-10-03") == "2025-09-04")
    let choices = BankHistory.backfillChoices(current: "2026-01-01", limitDays: 395, today: "2026-10-03")
    #expect(choices.map(\.from) == ["2025-11-01", "2025-09-04"])
    #expect(choices.last?.label == "Kaikki, mitä pankki antaa")
    #expect(choices.last?.hint == "Enintään 13 kuukauden ajalta")

    // Limit unknown: the fixed choices only, no "everything".
    let open = BankHistory.backfillChoices(current: "2026-06-01", limitDays: nil, today: "2026-10-03")
    #expect(open.map(\.from) == ["2026-01-01", "2025-11-01", "2025-01-01"])
    #expect(BankHistory.backfillChoices(current: nil, limitDays: 395, today: "2026-10-03").isEmpty)
}

@Test func bankHistoryBackfillProblems() {
    let today = "2026-10-03"
    #expect(BankHistory.backfillProblem(from: "2025-10-01", current: "2026-01-01", limitDays: 395, today: today) == nil)
    #expect(BankHistory.backfillProblem(from: "2026-10-04", current: nil, limitDays: nil, today: today) == "Päivä ei voi olla tulevaisuudessa.")
    #expect(BankHistory.backfillProblem(from: "2026-02-01", current: "2026-01-01", limitDays: nil, today: today)
            == "Valitse aiempi päivä kuin nykyinen alku (1.1.2026).")
    #expect(BankHistory.backfillProblem(from: "2025-01-01", current: "2026-01-01", limitDays: 395, today: today)
            == "Pankki antaa tapahtumat enintään 13 kuukauden ajalta.")
    #expect(BankHistory.backfillProblem(from: "2026-13-01", current: nil, limitDays: nil, today: today) == "Virheellinen päivä.")
    #expect(BankHistory.limitText(30) == "30 päivän")
}

@Test func bankHistoryCanFetchOlderOnlyOnActiveReportedWindow() {
    let a = [account("a", inScope: true)]
    #expect(BankHistory.canFetchOlder(BankConnection(id: "c", aspspName: "N", accounts: a, historyFrom: "2026-01-01")))
    #expect(!BankHistory.canFetchOlder(BankConnection(id: "c", aspspName: "N", accounts: a, historyFrom: nil)))
    #expect(!BankHistory.canFetchOlder(BankConnection(id: "c", aspspName: "N", status: "expired", accounts: a, historyFrom: "2026-01-01")))
}
