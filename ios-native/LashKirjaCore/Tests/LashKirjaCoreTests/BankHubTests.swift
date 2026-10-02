import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func row(_ id: String, _ date: String?, _ amount: Double, type: String = "meno") -> String {
    let d = date.map { "\"\($0)T00:00:00.000Z\"" } ?? "null"
    return #"{"id":"\#(id)","statementId":"s","date":\#(d),"type":"\#(type)","amount":\#(amount),"matchStatus":"unmatched"}"#
}

private func list(_ statements: [(month: String?, account: String?, rows: [String])]) throws -> [Statement] {
    let items = statements.enumerated().map { i, s in
        let month = s.month.map { "\"\($0)\"" } ?? "null"
        let account = s.account.map { #"{"id":"\#($0)","name":"Tili"}"# } ?? "null"
        return #"{"id":"s\#(i)","fileName":"f.csv","periodMonth":\#(month),"uploadedAt":"u","bankAccount":\#(account),"transactions":[\#(s.rows.joined(separator: ","))]}"#
    }
    return try decode(StatementList.self, #"{"statements":[\#(items.joined(separator: ","))]}"#).statements
}

@Test func bankHubMonthTotalsSplitByTypeLikeTheServer() throws {
    let statements = try list([
        ("2026-10", nil, [row("a", "2026-10-01", 100, type: "tulo"), row("b", "2026-10-02", -40.5), row("c", "2026-10-02", -1000, type: "palkka")]),
        ("2026-09", nil, [row("d", "2026-09-30", -7)]),
        // Undated statement: its rows fall to their own date's month.
        (nil, nil, [row("e", "2026-10-03", -2.5)]),
    ])
    let october = BankHub.totals(statements, month: "2026-10")
    #expect(october.income == 100)
    #expect(october.expenses == 43)
    #expect(october.transfers == -1000)
    #expect(october.net == 57)
    #expect(october.count == 4)
    #expect(BankHub.totals(statements, month: "2026-08") == BankHub.MonthTotals())
}

@Test func bankHubRecentRowsNewestFirstWithTheirMonth() throws {
    let statements = try list([
        ("2026-09", nil, [row("old", "2026-09-01", -1), row("undated", nil, 5, type: "tulo")]),
        ("2026-10", nil, [row("new", "2026-10-02", 20, type: "tulo"), row("mid", "2026-09-30", -3)]),
    ])
    let all = BankHub.recent(statements, filter: .all)
    #expect(all.map(\.id) == ["new", "mid", "old", "undated"])
    // The row is filed under its statement's month, as the feed's ?month= shows it.
    #expect(all.first { $0.id == "mid" }?.month == "2026-10")
    #expect(BankHub.recent(statements, filter: .expenses).map(\.id) == ["mid", "old"])
    #expect(BankHub.recent(statements, filter: .income).map(\.id) == ["new", "undated"])
    #expect(BankHub.recent(statements, filter: .all, limit: 2).count == 2)
}

@Test func bankHubMonthStepperStopsAtDataAndToday() throws {
    let statements = try list([("2026-07", nil, [row("a", "2026-07-03", -1)]), ("2026-10", nil, [row("b", "2026-10-01", -1)])])
    let oldest = BankHub.oldestMonth(statements)
    #expect(oldest == "2026-07")
    #expect(BankHub.canStepBack("2026-08", oldest: oldest))
    #expect(!BankHub.canStepBack("2026-07", oldest: oldest))
    #expect(!BankHub.canStepBack("2026-10", oldest: nil))
    #expect(BankHub.canStepForward("2026-09", current: "2026-10"))
    #expect(!BankHub.canStepForward("2026-10", current: "2026-10"))
}

@Test func bankHubPositionUsesTheCombinedTotalAndConnectedAccounts() throws {
    let position = try decode(BankHubPosition.self, #"""
    {"accounts":[
      {"id":"a1","name":"Käyttötili","bankName":"Nordea","currentBalance":1200.5,"archivedAt":null,"mismatchCount":1},
      {"id":"a2","name":"Vanha","currentBalance":3,"archivedAt":"2026-01-01T00:00:00.000Z"}],
     "totalBalance":1200.5,"needsAttention":1,
     "connected":{"accountCount":1,"accounts":[{"id":"c1","connectionId":"x","iban":"FI2112345600000785","label":null,"aspspName":"OP","currency":"EUR","balance":99.9,"balanceAt":"2026-10-02T05:05:00.000Z"}]},
     "combined":{"state":"connected","accountCount":2,"totalBalance":1300.4,"excludedCurrencies":[],"reconnectBank":null}}
    """#)
    #expect(BankHub.total(position) == Decimal(string: "1300.4"))
    let statements = try list([("2026-09", "a1", [row("t1", "2026-09-28", -1), row("t2", "2026-09-30", -1)])])
    let lines = BankHub.accountLines(position, statements: statements)
    #expect(lines.map(\.name) == ["Käyttötili", BankIBAN.mask("FI2112345600000785")])
    #expect(lines[0].bank == "Nordea")
    #expect(lines[0].asOf == "Viimeisin tapahtuma 30.9.2026")
    #expect(lines[0].needsCheck)
    #expect(lines[1].balance == Decimal(string: "99.9"))
    #expect(lines[1].asOf == "Pankin saldo 2.10.2026 klo 8.05")
    #expect(!BankHub.isEmpty(position, statements: []))
    #expect(BankHub.connectionNotice(position) == nil)
}

@Test func bankHubEmptyAndConnectionStates() throws {
    let fixture = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/bank-accounts.json"))
    let none = try JSONDecoder().decode(BankHubPosition.self, from: fixture)
    #expect(BankHub.isEmpty(none, statements: []))
    #expect(BankHub.isEmpty(nil, statements: []))
    #expect(!BankHub.isEmpty(none, statements: try list([("2026-10", nil, [row("a", "2026-10-01", -1)])])))

    let ended = try decode(BankHubPosition.self, #"{"accounts":[],"totalBalance":0,"needsAttention":0,"combined":{"state":"reconnect","accountCount":0,"totalBalance":0,"reconnectBank":"S-Pankki"}}"#)
    #expect(!BankHub.isEmpty(ended, statements: []))
    #expect(BankHub.connectionNotice(ended) == "Pankkiyhteys (S-Pankki) on vanhentunut. Yhdistä pankki uudelleen.")

    // An older server without `combined`: the ledger total stands.
    let older = try decode(BankHubPosition.self, #"{"accounts":[],"totalBalance":42,"needsAttention":0}"#)
    #expect(BankHub.total(older) == 42)
    #expect(older.connectedAccounts.isEmpty)
}

@Test func bankHubOpensOnTheCurrentMonthOnlyWhenItHasRows() throws {
    let statements = try list([
        ("2026-08", nil, [row("a", "2026-08-10", -5)]),
        ("2026-09", nil, [row("b", "2026-09-10", -5)]),
    ])
    // Early in October nothing is in yet: the hub opens on September, not on zeros.
    #expect(BankHub.startMonth(statements, current: "2026-10") == "2026-09")
    let withOctober = try list([("2026-10", nil, [row("c", "2026-10-01", -5)])])
    #expect(BankHub.startMonth(withOctober, current: "2026-10") == "2026-10")
    #expect(BankHub.startMonth([], current: "2026-10") == "2026-10")
}

@Test func bankHubChipsFollowTheRowTypeLikeTheMonthTotals() throws {
    let statements = try list([
        ("2026-10", nil, [
            row("rent", "2026-10-01", -800),
            row("sale", "2026-10-02", 120, type: "tulo"),
            row("salary", "2026-10-03", -2000, type: "palkka"),
            row("own", "2026-10-04", 500, type: "oma_siirto"),
        ]),
    ])
    // A salary or a transfer is neither an expense nor income: it has its own chip.
    #expect(BankHub.recent(statements, filter: .expenses).map(\.id) == ["rent"])
    #expect(BankHub.recent(statements, filter: .income).map(\.id) == ["sale"])
    #expect(BankHub.recent(statements, filter: .transfers).map(\.id) == ["own", "salary"])
    #expect(BankHub.Filter.allCases.map(\.title) == ["Kaikki", "Menot", "Tulot", "Siirrot ja palkat"])
}
