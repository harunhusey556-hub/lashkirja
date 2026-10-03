import Testing
import Foundation
@testable import LashKirjaCore

// Codex review items 4, 12, 13, 14: the offline receipt queue's store and drain must not lose,
// duplicate or resurrect rows when the disk or the session lets them down.

private func tempStore() -> OfflineReceiptStore {
    OfflineReceiptStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("oq-\(UUID().uuidString)"))
}

private func names(_ store: OfflineReceiptStore) -> Set<String> {
    Set((try? FileManager.default.contentsOfDirectory(atPath: store.directory.path)) ?? [])
}

private func setWritable(_ store: OfflineReceiptStore, _ writable: Bool) {
    try? FileManager.default.setAttributes([.posixPermissions: writable ? 0o755 : 0o555], ofItemAtPath: store.directory.path)
}

@Suite struct OfflineReceiptStoreSafetyTests {
    @Test func aFailedRecordWriteRemovesItsFile() throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        // A directory where the record should go makes the JSON write fail after the file was written.
        let blocker = store.directory.appendingPathComponent("fixed-id.json", isDirectory: true)
        try FileManager.default.createDirectory(at: blocker, withIntermediateDirectories: true)
        try Data([1]).write(to: blocker.appendingPathComponent("x"))
        #expect(throws: (any Error).self) {
            try store.enqueue(userId: "u", data: Data([1, 2, 3]), fileName: "kuitti.jpg", mimeType: "image/jpeg", id: "fixed-id")
        }
        #expect(!names(store).contains("fixed-id.bin"))
        #expect(store.list(userId: "u").isEmpty)
    }

    @Test func repairRemovesOrphanFilesAndReportsCorruptRecords() throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let kept = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        try Data([9]).write(to: store.directory.appendingPathComponent("orphan.bin"))
        try Data("not json".utf8).write(to: store.directory.appendingPathComponent("broken.json"))
        try Data([7]).write(to: store.directory.appendingPathComponent("broken.bin"))

        let check = store.repair()
        #expect(check.orphansRemoved == ["orphan"])
        #expect(check.corrupt == ["broken"])
        #expect(!names(store).contains("orphan.bin"))
        // A corrupt record's file is not an orphan: it goes only when the owner removes the record.
        #expect(names(store).contains("broken.bin"))
        #expect(store.list(userId: "u").map(\.id) == [kept.id])
        #expect(try store.data(for: kept) == Data([1]))

        store.delete(id: "broken")
        #expect(store.repair() == OfflineReceiptStore.Check(orphansRemoved: [], corrupt: []))
    }

    @Test func removeAllLeavesNothingBehind() throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        try Data([9]).write(to: store.directory.appendingPathComponent("orphan.bin"))
        try Data("x".utf8).write(to: store.directory.appendingPathComponent("broken.json"))
        store.removeAll()
        #expect(names(store).isEmpty)
    }
}

@Suite struct OfflineReceiptCompletedAtTests {
    private func item(_ id: String, status: QueuedReceipt.Status, created: TimeInterval, completed: TimeInterval? = nil) -> QueuedReceipt {
        QueuedReceipt(id: id, userId: "u", createdAt: Date(timeIntervalSince1970: created), capturedAt: "x", fileName: "a.jpg",
                      mimeType: "image/jpeg", size: 1, status: status, attempts: 0, nextAttemptAt: Date(timeIntervalSince1970: 0),
                      completedAt: completed.map { Date(timeIntervalSince1970: $0) })
    }

    @Test func aSendStampsCompletedAt() {
        let now = Date(timeIntervalSince1970: 5000)
        let done = OfflineReceiptRules.afterSend(item("a", status: .sending, created: 0), status: 201, serverError: nil, jobId: nil,
                                                 deviceOffline: false, now: now)
        #expect(done.item.completedAt == now)
        let retry = OfflineReceiptRules.afterSend(item("a", status: .sending, created: 0), status: 503, serverError: nil, jobId: nil,
                                                  deviceOffline: false, now: now)
        #expect(retry.item.completedAt == nil)
    }

    @Test func sentRowsArePrunedADayAfterSendingNotAfterTaking() {
        let day: TimeInterval = 24 * 60 * 60
        let now = Date(timeIntervalSince1970: 10 * day)
        let rows = [
            // Taken a week ago, sent an hour ago: kept.
            item("lateSend", status: .done, created: 3 * day, completed: 10 * day - 3600),
            // Sent two days ago: dropped.
            item("old", status: .done, created: 7 * day, completed: 8 * day),
            // A record from before completedAt: its createdAt stands in.
            item("legacyOld", status: .done, created: 8 * day),
            item("legacyNew", status: .done, created: 10 * day - 60),
        ]
        #expect(OfflineReceiptRules.expiredDone(rows, now: now).sorted() == ["legacyOld", "old"])
    }

    @Test func recordsWithoutCompletedAtStillDecode() throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try FileManager.default.createDirectory(at: store.directory, withIntermediateDirectories: true)
        // As written by the version before completedAt (JSONEncoder's default date = seconds since 2001).
        let legacy = #"{"id":"old","userId":"u","createdAt":0,"capturedAt":"2001-01-01T00:00:00.000Z","fileName":"a.jpg","mimeType":"image/jpeg","size":1,"status":"done","attempts":1,"nextAttemptAt":0}"#
        try Data(legacy.utf8).write(to: store.directory.appendingPathComponent("old.json"))
        let rows = store.list(userId: "u")
        #expect(rows.map(\.id) == ["old"])
        #expect(rows.first?.completedAt == nil)
        #expect(OfflineReceiptRules.expiredDone(rows, now: Date(timeIntervalSinceReferenceDate: 2 * 24 * 3600)) == ["old"])
        #expect(store.repair().corrupt.isEmpty)
    }
}

@MainActor
@Suite struct OfflineReceiptDrainTests {
    /// Counts what the drain did, and lets a test change "the signed-in account" mid-pass.
    final class Probe {
        var current = true
        var uploads: [String] = []
        var rowUpdates = 0
        var rowsAfterStale = 0
    }

    private func drain(_ store: OfflineReceiptStore, _ probe: Probe, online: Bool = true,
                       loadFile: ((QueuedReceipt) async -> Data?)? = nil,
                       answer: @escaping (QueuedReceipt) -> OfflineReceiptDrain.Answer = { _ in .init(status: 201) }) -> OfflineReceiptDrain {
        OfflineReceiptDrain(store: store, userId: "u",
                            isCurrent: { probe.current },
                            isOnline: { online },
                            onRows: { _ in
                                probe.rowUpdates += 1
                                if !probe.current { probe.rowsAfterStale += 1 }
                            },
                            loadFile: loadFile,
                            upload: { item, _ in
                                probe.uploads.append(item.id)
                                return answer(item)
                            })
    }

    @Test func sendsDueRowsOldestFirstAndStampsThem() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let first = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -20))
        let second = try store.enqueue(userId: "u", data: Data([2]), fileName: "b.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -10))
        let probe = Probe()
        let stop = await drain(store, probe).run(releaseBackoff: false)
        #expect(stop == .idle(next: nil))
        #expect(probe.uploads == [first.id, second.id])
        #expect(store.list(userId: "u").allSatisfy { $0.status == .done && $0.completedAt != nil })
    }

    @Test func noSendWhenTheAccountChangedWhileTheFileWasRead() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let row = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        let probe = Probe()
        let stop = await drain(store, probe, loadFile: { item in
            // Signed out (or another account in) while the photo was being read.
            probe.current = false
            return try? store.data(for: item)
        }).run(releaseBackoff: false)
        #expect(stop == .stale)
        #expect(probe.uploads.isEmpty)
        #expect(probe.rowsAfterStale == 0)
        // Left as the crash-recovery state: the next start for this account queues it again.
        #expect(store.list(userId: "u").map(\.status) == [.sending])
        #expect(store.list(userId: "u").first?.id == row.id)
    }

    @Test func aStaleAnswerIsNotWrittenBack() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        _ = try store.enqueue(userId: "u", data: Data([2]), fileName: "b.jpg", mimeType: "image/jpeg")
        let probe = Probe()
        let stop = await drain(store, probe, answer: { _ in
            probe.current = false
            return .init(status: 201)
        }).run(releaseBackoff: false)
        #expect(stop == .stale)
        #expect(probe.uploads.count == 1)
        #expect(probe.rowsAfterStale == 0)
        #expect(!store.list(userId: "u").contains { $0.status == .done })
    }

    @Test func aStaleDrainDoesNothingAtAll() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        let probe = Probe()
        probe.current = false
        #expect(await drain(store, probe).run(releaseBackoff: true) == .stale)
        #expect(probe.uploads.isEmpty)
        #expect(probe.rowUpdates == 0)
    }

    @Test func aFailedSendingWriteStopsBeforeAnyUpload() async throws {
        let store = tempStore()
        defer { setWritable(store, true); try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        _ = try store.enqueue(userId: "u", data: Data([2]), fileName: "b.jpg", mimeType: "image/jpeg")
        setWritable(store, false)
        let probe = Probe()
        let stop = await drain(store, probe).run(releaseBackoff: false)
        #expect(stop == .storage)
        #expect(probe.uploads.isEmpty)
        #expect(store.list(userId: "u").map(\.status) == [.queued, .queued])
    }

    @Test func aFailedOutcomeWriteStopsTheDrainInsteadOfRepicking() async throws {
        let store = tempStore()
        defer { setWritable(store, true); try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -20))
        _ = try store.enqueue(userId: "u", data: Data([2]), fileName: "b.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -10))
        let probe = Probe()
        let stop = await drain(store, probe, answer: { _ in
            // The disk fills up while the first photo is on its way.
            setWritable(store, false)
            return .init(status: 201)
        }).run(releaseBackoff: false)
        #expect(stop == .storage)
        #expect(probe.uploads.count == 1)
        // The sent row stays "sending" on disk: never picked again in this session, and a later
        // start resends it under the same Idempotency-Key.
        #expect(store.list(userId: "u").map(\.status) == [.sending, .queued])
    }

    @Test func aFailedReleaseWriteStopsTheDrain() async throws {
        let store = tempStore()
        defer { setWritable(store, true); try? FileManager.default.removeItem(at: store.directory) }
        var row = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        row.nextAttemptAt = Date(timeIntervalSinceNow: 600)
        try store.save(row)
        setWritable(store, false)
        let probe = Probe()
        #expect(await drain(store, probe).run(releaseBackoff: true) == .storage)
        #expect(probe.uploads.isEmpty)
    }

    @Test func pausedOfflineAndBackoffStops() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        _ = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg")
        let offline = Probe()
        #expect(await drain(store, offline, online: false).run(releaseBackoff: false) == .offline)
        #expect(offline.uploads.isEmpty)

        let expired = Probe()
        #expect(await drain(store, expired, answer: { _ in .init(status: 401) }).run(releaseBackoff: false) == .paused)
        #expect(store.list(userId: "u").map(\.status) == [.queued])

        let busy = Probe()
        let stop = await drain(store, busy, answer: { _ in .init(status: 503) }).run(releaseBackoff: false)
        guard case .idle(let next?) = stop else { Issue.record("expected a backoff, got \(stop)"); return }
        #expect(next > Date())
        #expect(busy.uploads.count == 1)
    }

    @Test func anUnreadableFileFailsItsRowAndTheDrainGoesOn() async throws {
        let store = tempStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let gone = try store.enqueue(userId: "u", data: Data([1]), fileName: "a.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -20))
        let fine = try store.enqueue(userId: "u", data: Data([2]), fileName: "b.jpg", mimeType: "image/jpeg", now: Date(timeIntervalSinceNow: -10))
        try FileManager.default.removeItem(at: store.directory.appendingPathComponent("\(gone.id).bin"))
        let probe = Probe()
        #expect(await drain(store, probe).run(releaseBackoff: false) == .idle(next: nil))
        #expect(probe.uploads == [fine.id])
        let rows = store.list(userId: "u")
        #expect(rows.first { $0.id == gone.id }?.status == .failed)
        #expect(rows.first { $0.id == fine.id }?.status == .done)
    }

    @Test func noticeWording() {
        #expect(OfflineReceiptRules.corruptText(1) == "Yhtä jonossa ollutta kuvaa ei voitu lukea puhelimesta.")
        #expect(OfflineReceiptRules.corruptText(3) == "3 jonossa ollutta kuvaa ei voitu lukea puhelimesta.")
        #expect(OfflineReceiptRules.storageFailure.hasPrefix("Kuvan tilaa ei voitu tallentaa puhelimeen"))
    }
}
