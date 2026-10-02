import Testing
import Foundation
@testable import LashKirjaCore

// MARK: Upload queue (web components/useReceiptUploadQueue.ts, lib/upload-queue.ts)

@Suite struct ReceiptUploadQueueTests {
    @Test func validatesLikeTheWeb() {
        #expect(ReceiptUploadQueue.validate(name: "a.pdf", size: 0) == "Tiedosto on tyhjä")
        #expect(ReceiptUploadQueue.validate(name: "a.pdf", size: 15 * 1024 * 1024 + 1) == "Tiedosto on liian suuri (enintään 15 Mt)")
        #expect(ReceiptUploadQueue.validate(name: "a.docx", size: 10) == "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja")
        #expect(ReceiptUploadQueue.validate(name: "Kuitti.PDF", size: 10) == nil)
        #expect(ReceiptUploadQueue.validate(name: "kuva.heic", size: nil) == nil)
    }

    @Test func enqueueMarksInvalidFilesFailedAndValidOnesPending() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.pdf", size: 100), .init(name: "b.txt", size: 100)])
        #expect(ids.count == 2)
        #expect(queue.rows.map(\.status) == [.pending, .failed])
        #expect(queue.rows[1].error == "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja")
        #expect(queue.nextPending?.id == ids[0])
    }

    @Test func rowsWalkThroughTheWebPhases() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "a.jpg", size: 1)])[0]
        queue.markUploading(id)
        #expect(queue.row(id)?.status == .uploading)
        #expect(queue.row(id)?.progress == "Lähetetään")
        #expect(queue.holdsWork)
        queue.markProcessing(id)
        #expect(queue.row(id)?.progress == "Käsitellään")
        queue.markReady(id, draft: ReceiptDraft(uploadId: "u1"))
        #expect(queue.row(id)?.status == .ready)
        #expect(queue.row(id)?.progress == "Odottaa tarkistusta")
        #expect(queue.row(id)?.draft?.uploadId == "u1")
        #expect(!queue.isFinished)
        queue.markSaved(id)
        #expect(queue.isFinished)
        #expect(queue.closesAfterSave)
        #expect(!queue.holdsWork)
    }

    @Test func aFailedFileKeepsTheScreenOpenAfterASave() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1)])
        queue.markReady(ids[0], draft: ReceiptDraft(uploadId: "u1"))
        queue.markFailed(ids[1], "Tiedostomuotoa ei tueta")
        queue.markSaved(ids[0])
        #expect(queue.isFinished)
        #expect(!queue.closesAfterSave)
    }

    @Test func firstReadyOpensOnceOnly() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1)])
        queue.markReady(ids[0], draft: ReceiptDraft(uploadId: "u1"))
        #expect(queue.takeAutoOpen()?.draft?.uploadId == "u1")
        queue.markReady(ids[1], draft: ReceiptDraft(uploadId: "u2"))
        #expect(queue.takeAutoOpen() == nil)
    }

    @Test func cancelStopsUnfinishedWorkAndRetryOnlyFailed() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1), .init(name: "c.jpg", size: 1), .init(name: "d.jpg", size: 1)])
        queue.markReady(ids[0], draft: ReceiptDraft(uploadId: "u1"))
        queue.markFailed(ids[1], "Lataus epäonnistui")
        queue.markUploading(ids[2])
        queue.cancelPending()
        #expect(queue.rows.map(\.status) == [.ready, .failed, .cancelled, .cancelled])
        #expect(queue.hasFailed)
        queue.retryFailed()
        #expect(queue.rows.map(\.status) == [.ready, .pending, .cancelled, .cancelled])
        #expect(queue.rows[1].error == nil)
    }

    @Test func offlineRowsAreDoneForThisScreen() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "a.jpg", size: 1)])[0]
        queue.markOffline(id)
        #expect(queue.row(id)?.status.label == "Odottaa yhteyttä")
        #expect(queue.isFinished)
        #expect(queue.offlineCount == 1)
    }

    @Test func statusLabels() {
        #expect(UploadQueueStatus.pending.label == "Jonossa")
        #expect(UploadQueueStatus.uploading.label == "Lähetetään")
        #expect(UploadQueueStatus.processing.label == "Käsitellään")
        #expect(UploadQueueStatus.ready.label == "Valmis")
        #expect(UploadQueueStatus.failed.label == "Epäonnistui")
        #expect(UploadQueueStatus.cancelled.label == "Peruttu")
        #expect(UploadQueueStatus.background.label == "Taustalla")
        #expect(UploadQueueStatus.saved.label == "Tallennettu")
    }

    @Test func fileNamesAndTypes() {
        #expect(ReceiptUploadFile.mimeType(forName: "x.PDF") == "application/pdf")
        #expect(ReceiptUploadFile.mimeType(forName: "x.jpeg") == "image/jpeg")
        #expect(ReceiptUploadFile.mimeType(forName: "x.png") == "image/png")
        #expect(ReceiptUploadFile.mimeType(forName: "x.heif") == "image/heic")
        #expect(ReceiptUploadFile.mimeType(forName: "x.zip") == nil)
        #expect(ReceiptUploadFile.isPDF(name: "Lasku.pdf"))
        #expect(ReceiptUploadFile.jpegName(for: "IMG_0001.HEIC") == "IMG_0001.jpg")
        #expect(ReceiptUploadFile.jpegName(for: "") == "kuitti.jpg")
        #expect(ReceiptUploadFile.photoName(index: 2) == "kuitti-3.jpg")
    }

    @Test func networkFailuresAreToldApartFromRefusals() {
        #expect(ReceiptUploadFile.isNetworkFailure(LKError(status: 0, code: "NETWORK", message: LKError.unreachable)))
        #expect(ReceiptUploadFile.isNetworkFailure(LKError.offline()))
        #expect(ReceiptUploadFile.isNetworkFailure(LKError(status: 503, message: LKError.unreachable)))
        #expect(!ReceiptUploadFile.isNetworkFailure(LKError(status: 415, message: "Tiedostomuotoa ei tueta")))
        #expect(!ReceiptUploadFile.isNetworkFailure(LKError(status: 409, message: "Tämä kuitti on jo tallennettu")))
        #expect(!ReceiptUploadFile.isNetworkFailure(CancellationError()))
    }
}

// MARK: Offline queue (web lib/offline/receipt-queue.ts, useOfflineReceiptQueue.ts)

@Suite struct OfflineReceiptQueueTests {
    private func item(_ id: String, status: QueuedReceipt.Status = .queued, created: TimeInterval = 0, next: TimeInterval = 0, attempts: Int = 0) -> QueuedReceipt {
        QueuedReceipt(id: id, userId: "u", createdAt: Date(timeIntervalSince1970: created), capturedAt: "2026-10-03T10:00:00.000Z",
                      fileName: "kuitti.jpg", mimeType: "image/jpeg", size: 10, status: status, attempts: attempts,
                      nextAttemptAt: Date(timeIntervalSince1970: next))
    }

    @Test func backoffSteps() {
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 1) == 5)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 2) == 30)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 3) == 120)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 4) == 600)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 5) == 1800)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 50) == 1800)
        #expect(OfflineReceiptRules.nextAttemptDelay(attempts: 0) == 5)
    }

    @Test func classifiesLikeTheWeb() {
        #expect(OfflineReceiptRules.classify(status: nil) == .retry)
        #expect(OfflineReceiptRules.classify(status: 201) == .done)
        #expect(OfflineReceiptRules.classify(status: 200) == .done)
        #expect(OfflineReceiptRules.classify(status: 401) == .paused)
        #expect(OfflineReceiptRules.classify(status: 408) == .retry)
        #expect(OfflineReceiptRules.classify(status: 429) == .retry)
        #expect(OfflineReceiptRules.classify(status: 503) == .retry)
        #expect(OfflineReceiptRules.classify(status: 415) == .failed)
        #expect(OfflineReceiptRules.classify(status: 400) == .failed)
    }

    @Test func picksOldestDueQueuedRowOnly() {
        let rows = [item("b", created: 20), item("a", created: 10, next: 500), item("c", status: .failed, created: 1), item("d", created: 15)]
        #expect(OfflineReceiptRules.pickNext(rows, now: Date(timeIntervalSince1970: 100))?.id == "d")
        #expect(OfflineReceiptRules.pickNext(rows, now: Date(timeIntervalSince1970: 600))?.id == "a")
        #expect(OfflineReceiptRules.earliestNextAttempt(rows) == Date(timeIntervalSince1970: 0))
        #expect(OfflineReceiptRules.earliestNextAttempt([item("x", status: .failed)]) == nil)
    }

    @Test func reconnectReleasesBackoffAndCrashRecovers() {
        let now = Date(timeIntervalSince1970: 100)
        let released = OfflineReceiptRules.releaseBackoff([item("a", next: 500, attempts: 3), item("b", status: .failed, next: 900)], now: now)
        #expect(released[0].nextAttemptAt == now)
        #expect(released[0].attempts == 3)
        #expect(released[1].nextAttemptAt == Date(timeIntervalSince1970: 900))
        let recovered = OfflineReceiptRules.recoverCrashedSends([item("a", status: .sending), item("b", status: .done)])
        #expect(recovered.map(\.status) == [.queued, .done])
    }

    @Test func doneRowsArePrunedAfterADay() {
        let now = Date(timeIntervalSince1970: 200_000)
        let rows = [item("old", status: .done, created: 0), item("new", status: .done, created: 199_000), item("q", status: .queued, created: 0)]
        #expect(OfflineReceiptRules.expiredDone(rows, now: now) == ["old"])
    }

    @Test func sendOutcomes() {
        let now = Date(timeIntervalSince1970: 1000)
        let base = item("a", status: .sending, attempts: 1)
        // 2xx
        let done = OfflineReceiptRules.afterSend(base, status: 201, serverError: nil, jobId: "j1", deviceOffline: false, now: now)
        #expect(done.item.status == .done)
        #expect(done.item.jobId == "j1")
        #expect(!done.paused)
        // 401
        let paused = OfflineReceiptRules.afterSend(base, status: 401, serverError: nil, jobId: nil, deviceOffline: false, now: now)
        #expect(paused.paused)
        #expect(paused.item.status == .queued)
        #expect(paused.item.attempts == 1)
        // network while offline: nothing spent
        let offline = OfflineReceiptRules.afterSend(base, status: nil, serverError: nil, jobId: nil, deviceOffline: true, now: now)
        #expect(offline.item.status == .queued)
        #expect(offline.item.attempts == 1)
        #expect(offline.item.lastError == "Odottaa yhteyttä.")
        // network while online: backoff
        let online = OfflineReceiptRules.afterSend(base, status: nil, serverError: nil, jobId: nil, deviceOffline: false, now: now)
        #expect(online.item.attempts == 2)
        #expect(online.item.nextAttemptAt == now.addingTimeInterval(30))
        #expect(online.item.lastError == "Ei yhteyttä. Lähetetään uudelleen automaattisesti.")
        // 5xx: backoff with the same notice
        let server = OfflineReceiptRules.afterSend(base, status: 500, serverError: "x", jobId: nil, deviceOffline: false, now: now)
        #expect(server.item.status == .queued)
        #expect(server.item.attempts == 2)
        // permanent 4xx
        let refused = OfflineReceiptRules.afterSend(base, status: 415, serverError: "Tiedostomuotoa ei tueta", jobId: nil, deviceOffline: false, now: now)
        #expect(refused.item.status == .failed)
        #expect(refused.item.lastError == "Tiedostomuotoa ei tueta")
        let refusedNoText = OfflineReceiptRules.afterSend(base, status: 400, serverError: nil, jobId: nil, deviceOffline: false, now: now)
        #expect(refusedNoText.item.lastError == "Lähetys epäonnistui.")
        // past the cap
        let capped = OfflineReceiptRules.afterSend(item("a", status: .sending, attempts: 7), status: nil, serverError: nil, jobId: nil, deviceOffline: false, now: now)
        #expect(capped.item.status == .failed)
        #expect(capped.item.lastError == "Ei yhteyttä usean yrityksen jälkeen. Yritä myöhemmin uudelleen.")
        let cappedServer = OfflineReceiptRules.afterSend(item("a", status: .sending, attempts: 7), status: 502, serverError: nil, jobId: nil, deviceOffline: false, now: now)
        #expect(cappedServer.item.lastError == "Lähetys epäonnistui usean yrityksen jälkeen. Yritä myöhemmin uudelleen.")
    }

    @Test func manualRetryResetsTheBudget() {
        let now = Date(timeIntervalSince1970: 50)
        let retried = OfflineReceiptRules.manualRetry(item("a", status: .failed, attempts: 8), now: now)
        #expect(retried.status == .queued)
        #expect(retried.attempts == 0)
        #expect(retried.nextAttemptAt == now)
        #expect(retried.lastError == nil)
    }

    @Test func cardWording() {
        var failed = item("a", status: .failed)
        failed.lastError = "Tiedostomuotoa ei tueta"
        #expect(OfflineReceiptRules.statusText(failed) == "Tiedostomuotoa ei tueta")
        #expect(OfflineReceiptRules.statusText(item("b", status: .sending)) == "Lähetetään…")
        #expect(OfflineReceiptRules.statusText(item("c")) == "Odottaa yhteyttä")
        #expect(OfflineReceiptRules.sentText(1) == "1 kuva lähetetty. Kuitit näkyvät tarkistettavissa, kun ne on luettu.")
        #expect(OfflineReceiptRules.sentText(3) == "3 kuvaa lähetetty. Kuitit näkyvät tarkistettavissa, kun ne on luettu.")
        #expect(OfflineReceiptRules.waitingTitle(1) == "Jonossa 1 kuitti")
        #expect(OfflineReceiptRules.waitingTitle(4) == "Jonossa 4 kuittia")
        // 2026-09-28 09:00 UTC = 12:00 Helsinki
        #expect(OfflineReceiptRules.title(createdAt: Date(timeIntervalSince1970: 1_790_586_000)) == "Kuitti 28.9.")
    }

    @Test func capturedAtIsISOWithMilliseconds() {
        #expect(OfflineReceiptRules.isoString(Date(timeIntervalSince1970: 0)) == "1970-01-01T00:00:00.000Z")
    }

    @Test func storeKeepsFilesPerUser() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oq-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = OfflineReceiptStore(directory: dir)
        let now = Date(timeIntervalSince1970: 1000)
        let a = try store.enqueue(userId: "u1", data: Data([1, 2, 3]), fileName: "kuitti.jpg", mimeType: "image/jpeg", now: now)
        _ = try store.enqueue(userId: "u2", data: Data([9]), fileName: "x.pdf", mimeType: "application/pdf", now: now.addingTimeInterval(1))
        #expect(a.status == .queued)
        #expect(a.size == 3)
        #expect(a.capturedAt == "1970-01-01T00:16:40.000Z")
        #expect(store.list(userId: "u1").map(\.id) == [a.id])
        #expect(try store.data(for: a) == Data([1, 2, 3]))
        var sent = a
        sent.status = .done
        try store.save(sent)
        #expect(store.list(userId: "u1").first?.status == .done)
        store.removeOtherUsers(keeping: "u1")
        #expect(store.list(userId: "u2").isEmpty)
        store.delete(id: a.id)
        #expect(store.list(userId: "u1").isEmpty)
        #expect((try? store.data(for: a)) == nil)
    }
}

// MARK: Review queue (web ReviewQueue.tsx, RejectedReceipts.tsx, lib/review-queue.ts)

@Suite struct ReviewQueueTests {
    private func receipt(_ id: String, source: String? = nil, vendor: String? = "K-Market", total: String? = "12.5") throws -> Receipt {
        var json = #"{"id":"\#(id)","createdAt":"a","updatedAt":"b","reviewStatus":"pending""#
        if let source { json += #","source":"\#(source)""# }
        if let vendor { json += #","vendor":"\#(vendor)""# }
        if let total { json += #","totalAmount":\#(total)"# }
        json += "}"
        return try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
    }

    @Test func splitsBySourceLikeTheWeb() throws {
        let rows = [try receipt("e", source: "email_sync"), try receipt("s", source: "auto_income"), try receipt("o", source: "app_capture"), try receipt("n")]
        let split = ReviewQueue.split(rows)
        #expect(split[.email]?.map(\.id) == ["e"])
        #expect(split[.bankSales]?.map(\.id) == ["s"])
        #expect(split[.other]?.map(\.id) == ["o", "n"])
        #expect(ReviewQueue.groups(pending: rows, rejectedCount: 0) == [.email, .bankSales, .other])
        #expect(ReviewQueue.groups(pending: [try receipt("o")], rejectedCount: 2) == [.other, .rejected])
        #expect(ReviewQueue.groups(pending: [], rejectedCount: 0).isEmpty)
    }

    @Test func groupWording() {
        #expect(ReviewGroup.email.title == "Sähköposti")
        #expect(ReviewGroup.bankSales.title == "Myynnit pankista")
        #expect(ReviewGroup.other.title == "Muut")
        #expect(ReviewGroup.rejected.title == "Hylätyt")
        #expect(ReviewGroup.email.description == "Sähköpostista tuodut kuitit odottavat hyväksyntää ennen kirjanpitoon siirtymistä.")
        #expect(ReviewGroup.bankSales.description == "Tiliotteen tuloista tehdyt myyntikirjaukset odottavat hyväksyntää.")
        #expect(ReviewGroup.other.description == "Odottavat hyväksyntää ennen kirjanpitoon siirtymistä.")
        #expect(ReviewGroup.rejected.description == "Eivät ole kirjanpidossa. Voit palauttaa kuitin tarkastettavaksi.")
    }

    @Test func approvalGaps() throws {
        #expect(ReceiptApproval.gaps(try receipt("a")).isEmpty)
        #expect(ReceiptApproval.gaps(try receipt("a", total: nil)) == [.amount])
        #expect(ReceiptApproval.gaps(try receipt("a", vendor: "  ")) == [.vendor])
        #expect(ReceiptApproval.gaps(try receipt("a", vendor: nil, total: nil)) == [.amount, .vendor])
        #expect(ReceiptApproval.gapText([.amount, .vendor]) == "Lisää summa ja myyjä")
        #expect(ReceiptApproval.gapText([.amount]) == "Lisää summa")
        #expect(ReceiptApproval.gapText([.vendor]) == "Lisää myyjä")
        #expect(ReceiptApproval.gapText([]) == "")
    }

    @Test func bulkApprovalCarriesOnlyReadyOnes() throws {
        let rows = [try receipt("a"), try receipt("b", total: nil), try receipt("c")]
        #expect(ReviewQueue.ready(rows).map(\.id) == ["a", "c"])
        #expect(ReviewQueue.approveTitle(rows) == "Hyväksy valmiit (2)")
        #expect(ReviewQueue.approveTitle([try receipt("a")]) == "Hyväksy kaikki (1)")
        #expect(ReviewQueue.approveTitle([try receipt("b", total: nil)]) == nil)
        #expect(ReviewQueue.incompleteNote(rows) == "1 kuitti vaatii täydennyksen.")
        #expect(ReviewQueue.incompleteNote([try receipt("b", total: nil), try receipt("d", vendor: nil)]) == "2 kuittia vaatii täydennyksen.")
        #expect(ReviewQueue.incompleteNote([try receipt("a")]) == nil)
    }

    @Test func approvalOutcomeNamesTheRefusal() {
        #expect(ReviewQueue.approvalOutcome(approved: 3, failures: []) == "Hyväksyttiin 3.")
        #expect(ReviewQueue.approvalOutcome(approved: 2, failures: ["Kuitin kuukausi on suljettu."]) == "Hyväksyttiin 2. Yhtä kuittia ei voitu hyväksyä: Kuitin kuukausi on suljettu.")
        #expect(ReviewQueue.approvalOutcome(approved: 0, failures: ["A.", "A.", ""]) == "3 kuittia ei voitu hyväksyä: A.")
        #expect(ReviewQueue.approvalOutcome(approved: 0, failures: [""]) == "Yhtä kuittia ei voitu hyväksyä.")
    }

    @Test func restoreBody() throws {
        let body = try JSONEncoder().encode(ReviewStatusBody.restore)
        #expect(String(data: body, encoding: .utf8) == #"{"reviewStatus":"pending"}"#)
    }
}
