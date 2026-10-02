import Testing
import Foundation
@testable import LashKirjaCore

@Test func navFailedJobsAreCountedAndSummarised() throws {
    func job(_ id: String, _ status: String) -> String {
        #"{"id":"\#(id)","kind":"document_analysis","status":"\#(status)","title":"x","createdAt":"2026-10-02T10:00:00.000Z"}"#
    }
    let body = "{\"jobs\":[\(job("a", "failed")),\(job("b", "done")),\(job("c", "failed")),\(job("d", "running"))]}"
    let jobs = try JSONDecoder().decode(JobsList.self, from: Data(body.utf8)).jobs
    #expect(JobsQueue.failedCount(jobs) == 2)
    #expect(JobsQueue.failedCount([]) == 0)
    #expect(JobsQueue.failedSummary(1) == "1 tuonti tai haku epäonnistui")
    #expect(JobsQueue.failedSummary(3) == "3 tuontia tai hakua epäonnistui")
}

@Test func navMonthCloseOpensOnAskedMonthClampedToNow() {
    #expect(PeriodClose.startMonth(nil, current: "2026-10") == "2026-09")
    #expect(PeriodClose.startMonth("", current: "2026-10") == "2026-09")
    #expect(PeriodClose.startMonth("2026-08", current: "2026-10") == "2026-08")
    #expect(PeriodClose.startMonth("2026-10", current: "2026-10") == "2026-10")
    #expect(PeriodClose.startMonth("2027-01", current: "2026-10") == "2026-10")
    #expect(PeriodClose.startMonth("syys", current: "2026-10") == "2026-09")
}

@Test func navBankFeedBulkLabelNamesWhatItDoes() {
    #expect(BankFeed.confirmAllLabel(4) == "Hyväksy kuittiehdotukset (4)")
}
