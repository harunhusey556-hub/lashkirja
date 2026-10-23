import Testing
import Foundation
@testable import LashKirjaCore

// Owner 2026-10-23 (beta audit S6): deleting a receipt leaves a "Kumoa" for a few seconds, and the
// server is asked only when that has passed.

private func answer(_ json: String) throws -> BatchDeleteResult {
    try JSONDecoder().decode(BatchDeleteResult.self, from: Data(json.utf8))
}

@Suite struct ReceiptDeleteUndoTests {
    @Test func kumoaStaysUpForAboutSixSeconds() {
        #expect(PendingReceiptDelete.window == 6)
    }

    @Test func aDeleteWaitsAndKumoaTakesItBackWithoutSendingAnything() {
        var pending = PendingReceiptDelete()
        #expect(!pending.isWaiting)
        pending.begin(["r1", "r2"])
        #expect(pending.waiting?.ids == ["r1", "r2"])
        let undone = pending.undo()
        #expect(undone == ["r1", "r2"])
        #expect(!pending.isWaiting)
        // Nothing is left for the timer, or for the app going to the background, to send.
        let late = pending.release()
        #expect(late == nil)
        let again = pending.undo()
        #expect(again.isEmpty)
    }

    @Test func theWindowEndingSendsTheBatchOnce() {
        var pending = PendingReceiptDelete()
        pending.begin(["r1"])
        let token = pending.waiting?.token
        let sent = pending.release(token: token)
        #expect(sent?.ids == ["r1"])
        // The background and the timer meeting on the same batch send it once.
        let byBackground = pending.release()
        let byTimer = pending.release(token: token)
        #expect(byBackground == nil)
        #expect(byTimer == nil)
    }

    @Test func theAppGoingToTheBackgroundSendsWhatWaits() {
        var pending = PendingReceiptDelete()
        pending.begin(["r1"])
        let sent = pending.release()
        #expect(sent?.ids == ["r1"])
        #expect(!pending.isWaiting)
    }

    @Test func anEarlierTimerDoesNotSendALaterDelete() {
        var pending = PendingReceiptDelete()
        pending.begin(["r1"])
        let first = pending.waiting?.token
        // Not undone: the second delete hands the first back to be sent now.
        let handedBack = pending.begin(["r2"])
        #expect(handedBack?.ids == ["r1"])
        #expect(pending.waiting?.ids == ["r2"])
        // The first delete's timer fires late: the second keeps its time.
        let late = pending.release(token: first)
        #expect(late == nil)
        #expect(pending.waiting?.ids == ["r2"])
        let sent = pending.release(token: pending.waiting?.token)
        #expect(sent?.ids == ["r2"])
    }

    @Test func kumoaTakesBackOnlyTheNewestDelete() {
        var pending = PendingReceiptDelete()
        pending.begin(["r1"])
        pending.begin(["r2", "r3"])
        let undone = pending.undo()
        #expect(undone == ["r2", "r3"])
    }

    @Test func theToastCountsTheReceipts() {
        #expect(ReceiptDeleteText.toast(1) == "Kuitti poistettu")
        #expect(ReceiptDeleteText.toast(3) == "3 kuittia poistettu")
    }

    @Test func aDeleteThatWentSaysNothing() throws {
        var outcome = ReceiptDeleteOutcome()
        outcome.add(try answer(#"{"ok":true,"succeeded":["r1","r2"],"failed":[]}"#), asked: ["r1", "r2"])
        #expect(outcome.deleted == 2)
        #expect(outcome.refused.isEmpty)
        #expect(outcome.message == nil)
        #expect(ReceiptDeleteOutcome(deleted: 1).message == nil)
    }

    @Test func aClosedMonthBringsTheRowBackAndSaysWhy() throws {
        var outcome = ReceiptDeleteOutcome()
        outcome.add(try answer(#"{"succeeded":[],"failed":[{"id":"r1","error":"Kausi on suljettu."}]}"#), asked: ["r1"])
        #expect(outcome.deleted == 0)
        #expect(outcome.refused == ["r1"])
        #expect(outcome.message == "Kuittia ei poistettu: Kausi on suljettu.")
    }

    @Test func aPartlyRefusedBatchNamesBothHalves() throws {
        var outcome = ReceiptDeleteOutcome()
        outcome.add(try answer(#"{"succeeded":["a"],"failed":[{"id":"b","error":"Kausi on suljettu."}]}"#), asked: ["a", "b"])
        #expect(outcome.deleted == 1)
        #expect(outcome.refused == ["b"])
        #expect(outcome.message == "Poistettiin 1 kuitti. 1 epäonnistui: Kausi on suljettu.")
    }

    @Test func aReceiptTheAnswerDoesNotMentionComesBack() throws {
        var outcome = ReceiptDeleteOutcome()
        outcome.add(try answer(#"{"succeeded":["a"]}"#), asked: ["a", "b"])
        #expect(outcome.refused == ["b"])
        #expect(outcome.message == "Poistettiin 1 kuitti. 1 epäonnistui.")
    }

    @Test func aCallThatFailedAsAWholeBringsEveryRowBack() throws {
        var outcome = ReceiptDeleteOutcome()
        outcome.add(try answer(#"{"succeeded":["a"],"failed":[]}"#), asked: ["a"])
        outcome.fail(["b", "c"], reason: "Ei yhteyttä.")
        #expect(outcome.deleted == 1)
        #expect(outcome.refused == ["b", "c"])
        #expect(outcome.message == "Poistettiin 1 kuitti. 2 epäonnistui: Ei yhteyttä.")
        var none = ReceiptDeleteOutcome()
        none.fail(["b", "c"], reason: "Ei yhteyttä.")
        #expect(none.message == "Kuitteja ei poistettu: Ei yhteyttä.")
    }
}
