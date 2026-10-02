import Testing
import Foundation
@testable import LashKirjaCore

@Test func jobsDecodeAndLabel() throws {
    let body = #"{"jobs":[{"id":"j1","kind":"document_analysis","status":"running","title":"Kuitti 2.10.","detail":null,"error":null,"progressLabel":"Luetaan","resourceType":null,"resourceId":null,"createdAt":"2026-10-02T10:00:00.000Z","startedAt":null,"finishedAt":null}]}"#
    let jobs = try JSONDecoder().decode(JobsList.self, from: Data(body.utf8)).jobs
    #expect(jobs[0].isActive)
    #expect(jobs[0].statusLabel == "Käynnissä")
    #expect(jobs[0].kindLabel == "Kuitin lukeminen")
    #expect(jobs[0].secondary == "Kuitin lukeminen · Luetaan")
}

@Test func visibleJobsAreActivePlusThreeFinished() throws {
    func job(_ id: String, _ status: String) -> String {
        #"{"id":"\#(id)","kind":"bank_sync","status":"\#(status)","title":"x","createdAt":"2026-10-02T10:00:00.000Z"}"#
    }
    let body = "{\"jobs\":[\(job("a", "done")),\(job("b", "failed")),\(job("c", "pending")),\(job("d", "done")),\(job("e", "cancelled")),\(job("f", "done"))]}"
    let jobs = try JSONDecoder().decode(JobsList.self, from: Data(body.utf8)).jobs
    #expect(JobsQueue.visibleJobs(jobs).map(\.id) == ["c", "a", "d", "e"])
}

@Test func workItemsDecodeWithRetry() throws {
    let body = #"{"items":[{"id":"corrupt_file:j1","kind":"corrupt_file","title":"Kuitti","detail":"Ei voitu lukea.","href":null,"retryJobId":"j1","retryJobIds":["j1","j2"],"count":2},{"id":"missing_document:t1","kind":"missing_document","title":"Neste","detail":"Tapahtumalla ei ole kuittia.","href":"/pankki/tapahtumat/tiliote?id=s1"}]}"#
    let items = try JSONDecoder().decode(WorkQueueList.self, from: Data(body.utf8)).items
    #expect(items[0].retryIds == ["j1", "j2"])
    #expect(items[1].retryIds.isEmpty)
    #expect(items[1].kindLabel == "Kuitti puuttuu")
    #expect(items[1].href == "/pankki/tapahtumat/tiliote?id=s1")
}

@Test func filterChipsShowOnlyKindsWithRows() throws {
    let body = #"{"items":[{"id":"1","kind":"pending_review","title":"a","detail":"","href":null},{"id":"2","kind":"pending_review","title":"b","detail":"","href":null},{"id":"3","kind":"link_error","title":"c","detail":"","href":null}]}"#
    let items = try JSONDecoder().decode(WorkQueueList.self, from: Data(body.utf8)).items
    let chips = JobsQueue.chips(items, selected: "all")
    #expect(chips.map(\.id) == ["all", "pending_review", "link_error"])
    #expect(chips.map(\.count) == ["3", "2", "1"])
    #expect(chips[1].label == "Odottaa tarkistusta")
    #expect(JobsQueue.chips(items, selected: "amount_mismatch").map(\.id) == ["all", "pending_review", "amount_mismatch", "link_error"])
}

@Test func cappedKindsGetAPlus() throws {
    let rows = (0..<40).map { #"{"id":"\#($0)","kind":"missing_document","title":"t","detail":"","href":null}"# }.joined(separator: ",")
    let items = try JSONDecoder().decode(WorkQueueList.self, from: Data("{\"items\":[\(rows)]}".utf8)).items
    let chips = JobsQueue.chips(items, selected: "all")
    #expect(chips[0].count == "40+")
    #expect(chips[1].count == "40+")
}

@Test func filterItems() throws {
    let body = #"{"items":[{"id":"1","kind":"pending_review","title":"a","detail":"","href":null},{"id":"3","kind":"link_error","title":"c","detail":"","href":null}]}"#
    let items = try JSONDecoder().decode(WorkQueueList.self, from: Data(body.utf8)).items
    #expect(JobsQueue.filter(items, kind: "all").count == 2)
    #expect(JobsQueue.filter(items, kind: "link_error").map(\.id) == ["3"])
}
