import Testing
import Foundation
@testable import LashKirjaCore

private func jobs(_ rows: [(id: String, kind: String, status: String, resource: String?, error: String?)]) throws -> [BackgroundJob] {
    let items = rows.map { r in
        let resource = r.resource.map { "\"\($0)\"" } ?? "null"
        let error = r.error.map { "\"\($0)\"" } ?? "null"
        return #"{"id":"\#(r.id)","kind":"\#(r.kind)","status":"\#(r.status)","title":"T","resourceType":"bank_connection","resourceId":\#(resource),"error":\#(error),"createdAt":"2026-10-02T21:40:00.000Z"}"#
    }
    return try JSONDecoder().decode(JobsList.self, from: Data(#"{"jobs":[\#(items.joined(separator: ","))]}"#.utf8)).jobs
}

@Test func aFailureLaterFollowedBySuccessIsNoLongerOpen() throws {
    // Newest first, as GET /api/jobs sends them.
    let list = try jobs([
        ("new", "bank_sync", "done", "c1", nil),
        ("old", "bank_sync", "failed", "c1", "Valitse ainakin yksi tili ennen hakua."),
        ("other", "bank_sync", "failed", "c2", "Valitse ainakin yksi tili ennen hakua."),
    ])
    #expect(JobsQueue.openFailures(list).map(\.id) == ["other"])
    #expect(JobsQueue.failedCount(list) == 1)
}

@Test func aBankFailureWithoutAccountsSaysWhatToDo() throws {
    let list = try jobs([("a", "bank_sync", "failed", "c1", "Valitse ainakin yksi tili ennen hakua.")])
    let help = JobsQueue.help(for: list[0])
    #expect(help.action == .chooseAccounts)
    #expect(help.actionTitle == "Valitse tilit")
    #expect(help.explanation.contains("yhtään tiliä"))
}

@Test func otherFailuresGetTheirOwnPath() throws {
    let list = try jobs([
        ("b", "bank_sync", "failed", "c1", "Pankin suostumus on vanhentunut."),
        ("m", "email_scan", "failed", "i1", "Kirjautuminen epäonnistui"),
        ("d", "document_analysis", "failed", "u1", "OCR"),
    ])
    #expect(JobsQueue.help(for: list[0]).action == .bankConnection)
    #expect(JobsQueue.help(for: list[1]).action == .emailSettings)
    // A failed read has its retry in Korjattavat; it is not listed twice.
    #expect(JobsQueue.listedFailures(list).map(\.id) == ["b", "m"])
}

@Test func aBankFailureClosesWhenItsConnectionIsGoneOrHasFetchedSince() throws {
    let list = try jobs([
        ("gone", "bank_sync", "failed", "old-connection", "Valitse ainakin yksi tili ennen hakua."),
        ("fixed", "bank_sync", "failed", "c1", "Valitse ainakin yksi tili ennen hakua."),
        ("still", "bank_sync", "failed", "c2", "Valitse ainakin yksi tili ennen hakua."),
    ])
    // Failures were at 2026-10-02T21:40Z; c1 fetched after that, c2 only before.
    let connections = [
        JobsQueue.ConnectionState(id: "c1", lastSuccessAt: "2026-10-03T08:00:00.000Z"),
        JobsQueue.ConnectionState(id: "c2", lastSuccessAt: "2026-10-01T08:00:00.000Z"),
    ]
    #expect(JobsQueue.openFailures(list, connections: connections).map(\.id) == ["still"])
    // Without the connection list (it failed to load) nothing is guessed away.
    #expect(JobsQueue.openFailures(list, connections: nil).map(\.id) == ["gone", "fixed", "still"])
}

@Test func aDismissedFailureIsNoLongerOpen() throws {
    let list = try jobs([
        ("a", "bank_sync", "dismissed", "c1", "x"),
        ("b", "email_scan", "failed", "i1", "x"),
    ])
    #expect(JobsQueue.openFailures(list).map(\.id) == ["b"])
    #expect(JobsQueue.openFailures(list, dismissedLocally: ["b"]).isEmpty)
}

@Test func connectionStatesComeFromTheConnectionList() throws {
    let json = #"{"enabled":true,"ready":true,"connections":[{"id":"c1","aspspName":"Nordea","aspspCountry":"FI","psuType":"business","status":"active","lastSuccessAt":"2026-10-03T08:00:00.000Z","accounts":[]},{"id":"c0","aspspName":"Nordea","aspspCountry":"FI","psuType":"business","status":"revoked","accounts":[]}]}"#
    let list = try JSONDecoder().decode(BankConnections.self, from: Data(json.utf8))
    #expect(JobsQueue.connectionStates(list) == [
        JobsQueue.ConnectionState(id: "c1", lastSuccessAt: "2026-10-03T08:00:00.000Z"),
        JobsQueue.ConnectionState(id: "c0", lastSuccessAt: nil, retired: true),
    ])
}
