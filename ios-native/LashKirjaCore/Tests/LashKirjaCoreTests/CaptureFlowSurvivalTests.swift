import Testing
import Foundation
@testable import LashKirjaCore

// W22 (owner's iPhone test, 2026-10-12): every auto-save failed against the live wave-1 server
// (strict body, 400 to `autoApprove`), going back from the form threw the other files away, and
// nothing kept the readings when the screen closed.

/// Answers saves from a script and remembers each body it was sent.
private final class FakeSaveServer {
    var answers: [Result<ReceiptSaveResult, LKError>]
    private(set) var bodies: [ReceiptDraft] = []
    init(_ answers: [Result<ReceiptSaveResult, LKError>]) { self.answers = answers }

    func post(_ body: ReceiptDraft) throws -> ReceiptSaveResult {
        bodies.append(body)
        guard !answers.isEmpty else { throw LKError(status: 500, message: "script ended") }
        return try answers.removeFirst().get()
    }
}

private func saved(_ id: String, autoApproved: Bool? = nil) -> Result<ReceiptSaveResult, LKError> {
    .success(ReceiptSaveResult(receipt: .init(id: id), autoApproved: autoApproved))
}

/// What the wave-1 server answers to a body with a key its strict schema does not know.
private let unknownKey = LKError(status: 400, code: "VALIDATION_FAILED", message: "Tarkista lomakkeen tiedot",
                                 fields: ["": "Lomakkeella on tuntematon kenttä"])
private let duplicate = LKError(status: 409, message: "Sama kuitti näyttää olevan jo tallennettu", fields: ["isDuplicate": "true"])

private func draft(_ uploadId: String = "u1") -> ReceiptDraft {
    var d = ReceiptDraft(uploadId: uploadId)
    d.vendor = "K-Market"
    d.date = "2026-10-03"
    d.totalAmount = Decimal(string: "12.50")
    return d
}

// MARK: Saving against the old and the new server

@Suite struct ReceiptSavingFallbackTests {
    @Test func aNewServerGetsTheFlagAndItsAnswerCounts() async throws {
        let server = FakeSaveServer([saved("r1", autoApproved: true)])
        let outcome = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: true) { try server.post($0) }
        #expect(server.bodies.map(\.autoApprove) == [true])
        // A plain receipt saved is a kuitti: the upload row offers "Kuitti ⇄ Ostolasku" for it.
        #expect(outcome == .init(receiptId: "r1", approved: true, duplicate: false, support: .supported, kind: .receipt))
    }

    @Test func aWave1RefusalIsSavedAgainWithoutTheFlagAndRemembered() async throws {
        let server = FakeSaveServer([.failure(unknownKey), saved("r1")])
        let outcome = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: true) { try server.post($0) }
        #expect(server.bodies.map(\.autoApprove) == [true, false])
        // Same receipt both times: only the flag differs.
        #expect(server.bodies[1].uploadId == "u1" && server.bodies[1].vendor == "K-Market")
        // Saved, approval unknown (the old server approves by default): not "needs review".
        #expect(outcome.approved == nil)
        #expect(outcome.support == .unsupported)
    }

    @Test func onceKnownTheFlagIsNotSentAtAll() async throws {
        let server = FakeSaveServer([saved("r1")])
        let outcome = try await ReceiptSaving.save(draft(), support: .unsupported, saveDuplicateAnyway: true) { try server.post($0) }
        #expect(server.bodies.count == 1)
        #expect(server.bodies[0].autoApprove == false)
        #expect(outcome.approved == nil)
        #expect(outcome.support == .unsupported)
    }

    @Test func theEncodedBodyOfTheRetryHasNoFlag() async throws {
        let server = FakeSaveServer([.failure(unknownKey), saved("r1")])
        _ = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: false) { try server.post($0) }
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(server.bodies[1])) as? [String: Any]
        #expect(json?["autoApprove"] == nil)
        let first = try JSONSerialization.jsonObject(with: JSONEncoder().encode(server.bodies[0])) as? [String: Any]
        #expect(first?["autoApprove"] as? Bool == true)
    }

    @Test func aSecond400IsARealValidationErrorAndIsThrown() async {
        let server = FakeSaveServer([.failure(unknownKey), .failure(unknownKey)])
        await #expect(throws: LKError.self) {
            _ = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: true) { try server.post($0) }
        }
        #expect(server.bodies.count == 2)
    }

    @Test func a400WithoutTheFlagIsNotRetried() async {
        let server = FakeSaveServer([.failure(unknownKey), saved("r1")])
        await #expect(throws: LKError.self) {
            _ = try await ReceiptSaving.save(draft(), support: .unsupported, saveDuplicateAnyway: true) { try server.post($0) }
        }
        #expect(server.bodies.count == 1)
    }

    @Test func otherErrorsAreNotRetried() async {
        for error in [LKError(status: 500, message: "x"), LKError(status: 0, message: LKError.offlineMessage),
                      LKError(status: 409, message: "Latausta ei löytynyt tai se on jo käytetty")] {
            let server = FakeSaveServer([.failure(error), saved("r1")])
            await #expect(throws: LKError.self) {
                _ = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: true) { try server.post($0) }
            }
            #expect(server.bodies.count == 1)
        }
    }

    @Test func theQueueSavesALookAlikeAnywayAfterTheFlagFallback() async throws {
        let server = FakeSaveServer([.failure(unknownKey), .failure(duplicate), saved("r1")])
        let outcome = try await ReceiptSaving.save(draft(), support: .unknown, saveDuplicateAnyway: true) { try server.post($0) }
        #expect(server.bodies.map(\.autoApprove) == [true, false, false])
        #expect(server.bodies.map(\.forceDuplicate) == [false, false, true])
        #expect(outcome.duplicate)
        #expect(outcome.support == .unsupported)
    }

    @Test func theFormAsksAboutALookAlikeInstead() async {
        let server = FakeSaveServer([.failure(duplicate)])
        do {
            _ = try await ReceiptSaving.save(draft(), support: .supported, saveDuplicateAnyway: false) { try server.post($0) }
            Issue.record("a duplicate must reach the form")
        } catch let error as LKError {
            #expect(error.isDuplicate)
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test func aNewServerThatDidNotApproveSaysSo() async throws {
        let server = FakeSaveServer([saved("r1", autoApproved: false)])
        let outcome = try await ReceiptSaving.save(draft(), support: .supported, saveDuplicateAnyway: true) { try server.post($0) }
        #expect(outcome.approved == false)
    }

    @Test func theRetryDecision() {
        #expect(ReceiptSaving.retriesWithoutFlag(unknownKey, flagSent: true))
        #expect(!ReceiptSaving.retriesWithoutFlag(unknownKey, flagSent: false))
        #expect(!ReceiptSaving.retriesWithoutFlag(duplicate, flagSent: true))
        #expect(!ReceiptSaving.retriesWithoutFlag(CancellationError(), flagSent: true))
        #expect(ReceiptSaving.sendsFlag(.unknown) && ReceiptSaving.sendsFlag(.supported) && !ReceiptSaving.sendsFlag(.unsupported))
    }
}

// MARK: The queue after a save the server said nothing about

@Suite struct UnknownApprovalQueueTests {
    @Test func anUnknownApprovalIsSavedNotWaitingForReview() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1), .init(name: "c.jpg", size: 1)])
        queue.markSaved(ids[0], autoApproved: nil)
        queue.markSaved(ids[1], autoApproved: true)
        queue.markSaved(ids[2], autoApproved: false)
        #expect(queue.reviewCount == 1)
        #expect(queue.row(ids[0])?.outcomeText == nil)
        #expect(queue.row(ids[0])?.approvalKnown == false)
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 1 · Tallennettiin 1 · 1 odottaa tarkistusta")
        #expect(queue.reviewButtonTitle == "Näytä tarkistettavat (1)")
    }

    @Test func onlyUnknownApprovalsShowNoReviewButton() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1)])
        for id in ids { queue.markSaved(id, autoApproved: nil) }
        #expect(queue.summaryLine == "Tallennettiin 2")
        #expect(queue.reviewButtonTitle == nil)
        #expect(queue.savedCount == 2)
    }

    @Test func aKnownSaveStillDefaultsToWaiting() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "a.jpg", size: 1)])[0]
        queue.markSaved(id)
        #expect(queue.row(id)?.approvalKnown == true)
        #expect(queue.row(id)?.outcomeText == "Odottaa tarkistusta")
    }
}

// MARK: A single complete reading saves itself (web takesAutoSavePath)

@Suite struct SingleFileAutoSaveTests {
    private func reading(_ json: String) throws -> Extracted {
        try JSONDecoder().decode(Extracted.self, from: Data(json.utf8))
    }

    @Test func aSingleCompleteReadingTakesTheSavePath() throws {
        let r = try reading(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.9,"confidence":0.9,"source":"ai"}"#)
        #expect(AutoAccept.takesAutoSavePath(several: false, reading: r))
    }

    @Test func aSingleIncompleteReadingOpensTheForm() throws {
        let r = try reading(#"{"vendor":"K-Market","date":"2026-10-03","confidence":0.9}"#)
        #expect(!AutoAccept.takesAutoSavePath(several: false, reading: r))
    }

    /// Web `confident()`: a null score is not confident; the wave-1 server always sends one
    /// (`upload.confidence ?? 0.25` for a staged file, the extractor's score for a job).
    @Test func aMissingConfidenceIsNotConfidentAsOnTheWeb() throws {
        let r = try reading(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":12.9}"#)
        #expect(AutoAccept.block(r) == .lowConfidence)
    }

    /// The shape the wave-1 job route answers with (no fieldConfidence, documentType null).
    @Test func aWave1ReadingDecodesWithItsScore() throws {
        let r = try reading(#"{"vendor":"Lidl","date":"2026-10-01","totalAmount":5.2,"vatDetails":[],"category":null,"notes":null,"type":"meno","reference":null,"invoiceNumber":null,"currency":"EUR","documentType":null,"source":"ai","provenance":"openai-compatible","confidence":0.82,"rawText":"x"}"#)
        #expect(r.confidence == 0.82)
        #expect(r.fieldConfidence == nil)
        #expect(AutoAccept.isComplete(r))
    }
}

// MARK: The queue survives the form, the screen and the app

@Suite struct QueueSurvivalTests {
    @Test func discardingKeepsSavedAndInFlightRows() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue((0..<5).map { .init(name: "k\($0).jpg", size: 1) })
        queue.markReady(ids[0], draft: draft("u0"))
        queue.markSaveQueued(ids[1], draft: draft("u1"))
        queue.markSaved(ids[2], autoApproved: true)
        queue.markSaveQueued(ids[3], draft: draft("u3"))
        _ = queue.claimNextSave() // ids[1] is on its way
        // ids[4] is still pending upload
        let removed = queue.discardUnsaved()
        #expect(Set(removed) == [ids[0], ids[3]])
        #expect(queue.rows.map(\.id) == [ids[1], ids[2], ids[4]])
    }

    @Test func unsavedReadingsAreTheOnesWithADraftNotSaved() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue((0..<5).map { .init(name: "k\($0).jpg", size: 1) })
        queue.markReady(ids[0], draft: draft("u0"))
        queue.markSaveQueued(ids[1], draft: draft("u1"))
        queue.markSaved(ids[2])
        queue.markSaveQueued(ids[3], draft: draft("u3"))
        queue.markFailed(ids[3], "Tallennus epäonnistui")
        queue.markFailed(ids[4], "Tiedosto on liian suuri")
        #expect(queue.unsavedReadings.map(\.id) == [ids[0], ids[1], ids[3]])
        #expect(queue.unfinishedCount == 3)
    }

    @Test func restoredReadingsComeBackReadyUnderTheirIdsAndDoNotOpenTheForm() {
        var queue = ReceiptUploadQueue()
        let kept = [UnfinishedReading(id: "a", name: "kuitti-1.jpg", draft: draft("u0"), readAt: Date(), previewName: "a.jpg")]
        queue.restore(kept)
        queue.restore(kept)
        #expect(queue.rows.count == 1)
        #expect(queue.row("a")?.status == .ready)
        #expect(queue.row("a")?.draft == draft("u0"))
        // A file read after the restore does not jump into the form by itself.
        let id = queue.enqueue([.init(name: "b.jpg", size: 1)])[0]
        queue.markReady(id, draft: draft("u1"))
        #expect(queue.takeAutoOpen() == nil)
    }

    @Test func theUnfinishedTitleCountsInFinnish() {
        #expect(ReceiptUploadQueue.unfinishedTitle(1) == "Kesken: 1 kuitti")
        #expect(ReceiptUploadQueue.unfinishedTitle(4) == "Kesken: 4 kuittia")
    }

    @Test func resetStartsClean() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "b.jpg", size: 1)])[0]
        queue.markReady(id, draft: draft())
        queue.reset()
        #expect(queue.rows.isEmpty)
        let next = queue.enqueue([.init(name: "c.jpg", size: 1)])[0]
        queue.markReady(next, draft: draft())
        #expect(queue.takeAutoOpen()?.id == next)
    }

    @Test func aDraftRoundTripsThroughJSON() throws {
        var d = draft()
        d.vatDetails = [VatDetail(rate: Decimal(string: "25.5")!, amount: Decimal(string: "2.5")!)]
        d.category = "Ruoka"
        d.type = "tulo"
        d.reference = "RF18"
        d.invoiceNumber = "123"
        d.notes = "Kahvi"
        let back = try JSONDecoder().decode(ReceiptDraft.self, from: JSONEncoder().encode(d))
        #expect(back == d)
        let empty = try JSONDecoder().decode(ReceiptDraft.self, from: JSONEncoder().encode(ReceiptDraft(uploadId: "u9")))
        #expect(empty == ReceiptDraft(uploadId: "u9"))
    }

    @Test func theStoreRoundTripsPerAccountAndDropsExpired() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cq-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = UnfinishedReadingStore(directory: dir)
        let now = Date(timeIntervalSince1970: 1_000_000)
        let preview = try store.writePreview(id: "a", data: Data([1, 2, 3]), isPDF: false)
        #expect(preview == "a.jpg")
        let pdf = try store.writePreview(id: "b", data: Data([4]), isPDF: true)
        let fresh = UnfinishedReading(id: "a", name: "kuitti-1.jpg", draft: draft("u0"), readAt: now.addingTimeInterval(-60), previewName: preview)
        let old = UnfinishedReading(id: "b", name: "lasku.pdf", draft: draft("u1"), readAt: now.addingTimeInterval(-UnfinishedReadingStore.lifetime - 1), previewName: pdf)
        try store.save(userId: "owner", readings: [fresh, old])
        #expect(store.load(userId: "owner", now: now) == [fresh])
        #expect(try Data(contentsOf: store.previewURL(preview)) == Data([1, 2, 3]))
        // Saving only the fresh one removes the old one's picture.
        try store.save(userId: "owner", readings: [fresh])
        #expect(!FileManager.default.fileExists(atPath: store.previewURL(pdf).path))
        // Another account never sees them, and they are gone afterwards.
        #expect(store.load(userId: "someone-else", now: now).isEmpty)
        #expect(store.load(userId: "owner", now: now).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: store.previewURL(preview).path))
    }

    @Test func savingNothingRemovesTheRecordAndPictures() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cq-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = UnfinishedReadingStore(directory: dir)
        let name = try store.writePreview(id: "a", data: Data([1]), isPDF: false)
        try store.save(userId: "owner", readings: [UnfinishedReading(id: "a", name: "a.jpg", draft: draft(), readAt: Date(), previewName: name)])
        try store.save(userId: "owner", readings: [])
        #expect(store.load(userId: "owner").isEmpty)
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).isEmpty)
    }
}
