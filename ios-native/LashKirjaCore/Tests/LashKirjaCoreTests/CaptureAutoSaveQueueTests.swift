import Testing
import Foundation
@testable import LashKirjaCore

// The queue side of the auto-save (web useReceiptUploadQueue.ts saveRead): a finished reading waits
// for a save slot, is saved with at most three in flight, and ends saved, failed or back in the form.

@Suite struct AutoSaveQueueTests {
    private func makeQueue(_ count: Int) -> (ReceiptUploadQueue, [String]) {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue((0..<count).map { ReceiptUploadQueue.Pick(name: "kuitti-\($0).jpg", size: 1) })
        return (queue, ids)
    }

    private func queuedForSave(_ count: Int) -> (ReceiptUploadQueue, [String]) {
        var (queue, ids) = makeQueue(count)
        for id in ids { queue.markSaveQueued(id, draft: ReceiptDraft(uploadId: "u-\(id)")) }
        return (queue, ids)
    }

    @Test func theSaveLimitIsThree() {
        #expect(ReceiptUploadQueue.saveConcurrency == 3)
    }

    @Test func claimNextSaveHandsOutAtMostThreeAtOnce() {
        var (queue, ids) = queuedForSave(5)
        let claimed = (0..<5).compactMap { _ in queue.claimNextSave() }
        #expect(claimed.map(\.id) == Array(ids.prefix(3)))
        #expect(claimed.allSatisfy { $0.status == .saving })
        #expect(queue.savingCount == 3)
        #expect(queue.claimNextSave() == nil)
    }

    @Test func aFinishedSaveFreesASlot() {
        var (queue, ids) = queuedForSave(4)
        for _ in 0..<3 { _ = queue.claimNextSave() }
        queue.markSaved(ids[0], autoApproved: true)
        #expect(queue.claimNextSave()?.id == ids[3])
        #expect(queue.claimNextSave() == nil)
    }

    @Test func aFailedSaveFreesASlotToo() {
        var (queue, ids) = queuedForSave(4)
        for _ in 0..<3 { _ = queue.claimNextSave() }
        queue.markFailed(ids[1], "Tallennus epäonnistui")
        #expect(queue.claimNextSave()?.id == ids[3])
    }

    @Test func aRowIsNeverClaimedForSavingTwice() {
        var (queue, ids) = queuedForSave(1)
        #expect(queue.claimNextSave()?.id == ids[0])
        #expect(queue.claimNextSave() == nil)
    }

    @Test func savesAndUploadsHaveSeparateLimits() {
        var (queue, ids) = makeQueue(6)
        queue.markSaveQueued(ids[0], draft: ReceiptDraft(uploadId: "u0"))
        for _ in 0..<3 { _ = queue.claimNext() }
        #expect(queue.uploadingCount == 3)
        #expect(queue.claimNextSave()?.id == ids[0])
    }

    @Test func aSavingRowKeepsItsReadingUntilSaved() {
        var (queue, ids) = queuedForSave(1)
        _ = queue.claimNextSave()
        #expect(queue.row(ids[0])?.draft?.uploadId == "u-\(ids[0])")
        #expect(queue.row(ids[0])?.progress == "Tallennetaan…")
        queue.markSaved(ids[0], autoApproved: false)
        #expect(queue.row(ids[0])?.draft == nil)
    }

    @Test func queuedAndSavingRowsAreWorkTheScreenMustNotLose() {
        var (queue, ids) = queuedForSave(2)
        #expect(queue.isWorking)
        #expect(queue.holdsWork)
        #expect(!queue.isFinished)
        _ = queue.claimNextSave()
        queue.markSaved(ids[0], autoApproved: true)
        #expect(!queue.isFinished)
        _ = queue.claimNextSave()
        queue.markSaved(ids[1], autoApproved: true)
        #expect(queue.isFinished)
        #expect(!queue.holdsWork)
        #expect(!queue.isWorking)
    }

    // MARK: Failed saves

    @Test func aFailedSaveKeepsItsReadingAndOffersTheForm() {
        var (queue, ids) = queuedForSave(1)
        _ = queue.claimNextSave()
        queue.markFailed(ids[0], "Tallennus epäonnistui")
        let row = queue.row(ids[0])
        #expect(row?.status == .failed)
        #expect(row?.error == "Tallennus epäonnistui")
        #expect(row?.draft?.uploadId == "u-\(ids[0])")
        #expect(row?.canOpenForm == true)
        #expect(queue.holdsWork)
    }

    @Test func aFailedUploadHasNoFormToOpen() {
        var (queue, ids) = makeQueue(1)
        queue.markFailed(ids[0], "Tiedosto on tyhjä")
        #expect(queue.row(ids[0])?.canOpenForm == false)
        #expect(!queue.holdsWork)
    }

    @Test func retryingASaveSavesTheReadingAgainAndNeverReuploads() {
        var (queue, ids) = makeQueue(2)
        queue.markSaveQueued(ids[0], draft: ReceiptDraft(uploadId: "u0"))
        _ = queue.claimNextSave()
        queue.markFailed(ids[0], "Tallennus epäonnistui")
        queue.markFailed(ids[1], "Kuvaa ei voitu lukea.")
        queue.retryFailed()
        #expect(queue.rows.map(\.status) == [.saveQueued, .pending])
        #expect(queue.rows.map(\.error) == [nil, nil])
        #expect(queue.claimNextSave()?.id == ids[0])
    }

    @Test func cancelKeepsAReadingThatWasWaitingForASlot() {
        var (queue, ids) = queuedForSave(4)
        for _ in 0..<3 { _ = queue.claimNextSave() }
        queue.cancelPending()
        // The three saves already sent finish; the fourth reading is not lost, it waits for the form.
        #expect(queue.rows.map(\.status) == [.saving, .saving, .saving, .ready])
        #expect(queue.row(ids[3])?.draft != nil)
        #expect(queue.row(ids[3])?.canOpenForm == false)
        #expect(queue.nextSaveQueued == nil)
    }

    // MARK: Summary, outcome text and the buttons after the queue settles

    @Test func approvedSavesAreCountedFromTheServersAnswerOnly() {
        var (queue, ids) = queuedForSave(4)
        for _ in 0..<3 { _ = queue.claimNextSave() }
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1], autoApproved: false)
        queue.markSaved(ids[2], autoApproved: false, duplicate: true)
        _ = queue.claimNextSave()
        queue.markFailed(ids[3], "Tallennus epäonnistui")
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 1 · 2 odottaa tarkistusta · 1 epäonnistui")
    }

    @Test func noSummaryWhileSavesAreStillGoing() {
        var (queue, ids) = queuedForSave(2)
        _ = queue.claimNextSave()
        queue.markSaved(ids[0], autoApproved: true)
        #expect(queue.summaryLine == nil)
    }

    @Test func savedRowsSayWhatBecameOfThem() {
        var (queue, ids) = makeQueue(4)
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1])
        queue.markSaved(ids[2], autoApproved: false, duplicate: true)
        #expect(queue.row(ids[0])?.outcomeText == "Hyväksytty automaattisesti")
        #expect(queue.row(ids[1])?.outcomeText == "Odottaa tarkistusta")
        #expect(queue.row(ids[2])?.outcomeText == "Samanlainen kuitti on jo tallennettu – odottaa tarkistusta")
        #expect(queue.row(ids[3])?.outcomeText == nil)
    }

    @Test func reviewButtonCountsWhatWaitsInKuitit() {
        var (queue, ids) = queuedForSave(3)
        for _ in 0..<3 { _ = queue.claimNextSave() }
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1], autoApproved: false)
        #expect(queue.reviewButtonTitle == nil)
        queue.markSaved(ids[2], autoApproved: false)
        #expect(queue.reviewCount == 2)
        #expect(queue.savedCount == 3)
        #expect(queue.reviewButtonTitle == "Näytä tarkistettavat (2)")
        #expect(ReceiptUploadQueue.receiptsButtonTitle == "Siirry kuitteihin")
    }

    @Test func noReviewButtonWhenEverythingWasApproved() {
        var (queue, ids) = queuedForSave(2)
        for _ in 0..<2 { _ = queue.claimNextSave() }
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1], autoApproved: true)
        #expect(queue.reviewButtonTitle == nil)
        #expect(queue.savedCount == 2)
    }

    @Test func statusLabelsOfTheSavePhases() {
        #expect(UploadQueueStatus.saveQueued.label == "Odottaa tallennusta")
        #expect(UploadQueueStatus.saving.label == "Tallennetaan")
    }
}
