import Testing
import Foundation
@testable import LashKirjaCore

@Test func emailFoldersAskForMailReceiptsByStatus() {
    #expect(EmailInboxFolder.allCases.map(\.title) == ["Odottaa", "Hyväksytyt", "Arkisto"])
    #expect(EmailInboxFolder.rejected.countsQuery() == ["source": "email_sync", "reviewStatus": "rejected"])
    #expect(EmailInboxFolder.pending.listQuery() == ["source": "email_sync", "reviewStatus": "pending", "sort": "created_desc"])
    #expect(EmailInboxFolder.approved.listQuery(offset: 200)["offset"] == "200")
}

@Test func emailCountsReadAndWriteByFolder() {
    var counts = EmailInboxCounts(pending: 3)
    #expect(counts[.pending] == 3)
    #expect(counts[.rejected] == nil)
    counts[.rejected] = 7
    #expect(counts.rejected == 7)
}

@Test func reviewBodyAndArchiveResult() throws {
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ReceiptReviewBody(.rejected))) as! [String: Any]
    #expect(json["reviewStatus"] as? String == "rejected")
    let result = try JSONDecoder().decode(EmailArchiveResult.self, from: Data(#"{"archived":4}"#.utf8))
    #expect(result.archived == 4)
}

@Test func syncAndCleanupNotices() {
    #expect(EmailInboxText.syncNotice(bills: 0, archived: nil) == "Ei uusia laskuja.")
    #expect(EmailInboxText.syncNotice(bills: 1, archived: 0) == "1 uusi lasku.")
    #expect(EmailInboxText.syncNotice(bills: 3, archived: 1) == "3 uutta laskua. 1 muu liite arkistoitiin.")
    #expect(EmailInboxText.syncNotice(bills: 2, archived: 5) == "2 uutta laskua. 5 muuta liitettä arkistoitiin.")
    #expect(EmailInboxText.cleanupNotice(0) == "Ei arkistoitavaa.")
    #expect(EmailInboxText.cleanupNotice(2) == "Arkistoitiin 2 liitettä, joissa ei ollut summaa.")
}

@Test func cleanupCountsWaitingRowsWithoutAmount() throws {
    func r(_ id: String, _ status: String, _ amount: String?) throws -> Receipt {
        let total = amount.map { #","totalAmount":\#($0)"# } ?? ""
        return try JSONDecoder().decode(Receipt.self, from: Data(#"{"id":"\#(id)","createdAt":"a","updatedAt":"b","reviewStatus":"\#(status)"\#(total)}"#.utf8))
    }
    let rows = [try r("a", "pending", nil), try r("b", "pending", "0"), try r("c", "pending", "12.5"), try r("d", "approved", nil)]
    #expect(EmailInboxText.cleanupCandidates(rows) == 2)
}

@Test func checkedTimeInHelsinki() throws {
    // 2026-10-02 09:05 in Helsinki (UTC+3).
    let morning = try #require(ISO8601DateFormatter().date(from: "2026-10-02T06:05:00Z"))
    #expect(EmailInboxText.checked(morning, now: morning.addingTimeInterval(20)) == "Tarkistettu juuri nyt")
    #expect(EmailInboxText.checked(morning, now: morning.addingTimeInterval(3600)) == "Tarkistettu tänään klo 9.05")
    #expect(EmailInboxText.checked(morning, now: morning.addingTimeInterval(86_400)) == "Tarkistettu 2.10.2026 klo 9.05")
}

@Test func emailInboxLastCheckIsTheNewestOfServerAndDevice() throws {
    let json = #"[{"id":"a","email":"a@x.fi","lastCheckedAt":"2026-10-02T18:30:00.000Z"},{"id":"b","email":"b@x.fi","lastCheckedAt":null},{"id":"c","email":"c@x.fi"}]"#
    let accounts = try JSONDecoder().decode([ImapAccount].self, from: Data(json.utf8))
    let server = Date(timeIntervalSince1970: 1_790_965_800) // 2026-10-02T18:30:00Z
    #expect(EmailInboxText.lastCheck(accounts, device: nil) == server)
    // A later "Tarkista nyt" on this phone wins; an older one does not.
    #expect(EmailInboxText.lastCheck(accounts, device: server.addingTimeInterval(60)) == server.addingTimeInterval(60))
    #expect(EmailInboxText.lastCheck(accounts, device: server.addingTimeInterval(-60)) == server)
    #expect(EmailInboxText.lastCheck([], device: nil) == nil)
}
