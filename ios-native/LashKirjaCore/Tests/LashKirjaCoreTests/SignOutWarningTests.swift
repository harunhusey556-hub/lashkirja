import Testing
import Foundation
@testable import LashKirjaCore

// X122 (P0): signing out deleted the receipts still on the phone without a word. The question now
// says how many, in the web's words (useSignOut.tsx).
@Suite struct SignOutWarningTests {
    private func item(_ id: String, _ status: QueuedReceipt.Status) -> QueuedReceipt {
        QueuedReceipt(id: id, userId: "u", createdAt: Date(timeIntervalSince1970: 0), capturedAt: "x", fileName: "a.jpg",
                      mimeType: "image/jpeg", size: 1, status: status, attempts: 0, nextAttemptAt: Date(timeIntervalSince1970: 0))
    }

    @Test func nothingWaitingAsksNothingMore() {
        #expect(SignOutWarning.message(waiting: [], unsavedReadings: 0) == nil)
    }

    @Test func oneWaitingReceiptIsNamedInTheSingular() {
        #expect(SignOutWarning.message(waiting: [item("a", .queued)], unsavedReadings: 0)
            == "1 kuitti odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
    }

    @Test func severalWaitingReceiptsAreCounted() {
        let rows = [item("a", .queued), item("b", .sending), item("c", .failed)]
        #expect(SignOutWarning.message(waiting: rows, unsavedReadings: 0)
            == "3 kuittia odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
    }

    @Test func deliveredRowsAreNotCounted() {
        #expect(SignOutWarning.message(waiting: [item("a", .done), item("b", .done)], unsavedReadings: 0) == nil)
        #expect(SignOutWarning.message(waiting: [item("a", .queued), item("b", .done)], unsavedReadings: 0)
            == "1 kuitti odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
    }

    @Test func unsavedReadingsLeaveWithTheSignOutToo() {
        #expect(SignOutWarning.message(waiting: [], unsavedReadings: 2)
            == "2 kuittia odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
        #expect(SignOutWarning.message(waiting: [item("a", .queued)], unsavedReadings: 1)
            == "2 kuittia odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta.")
    }
}
