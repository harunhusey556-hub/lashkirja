import SwiftUI
import UIKit
import LashKirjaCore

/// Receipts taken or picked without a connection wait on the phone and go to
/// `POST /api/receipts/inbox` when the network is back (web `useOfflineReceiptQueue.ts`).
/// One shared queue: the Kuitit card shows it, the capture flow adds to it.
///
/// Sends run oldest first, one at a time, when the queue starts, when the network comes back,
/// when the app returns to the foreground, and on a timer for the next backed-off row.
@MainActor
@Observable
final class OfflineReceiptQueueModel {
    static let shared = OfflineReceiptQueueModel()

    private(set) var rows: [QueuedReceipt] = []
    var waiting: [QueuedReceipt] { rows.filter { $0.status != .done } }
    var sent: [QueuedReceipt] { rows.filter { $0.status == .done } }

    private let store = OfflineReceiptStore.standard()
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var userId: String?
    @ObservationIgnored private var draining = false
    /// A 401: the session is gone. Nothing more is tried until the next start after sign-in.
    @ObservationIgnored private var paused = false
    @ObservationIgnored private var releaseAgain = false
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var wired = false

    private init() {}

    /// Binds the queue to the signed-in owner and sends what is due. Safe to call often.
    func start(app: AppModel) {
        guard case .signedIn(let user) = app.phase else { return }
        api = app.api
        // A screen of a signed-in session is showing, so a pause from an earlier 401 is over.
        paused = false
        if userId != user.userId {
            userId = user.userId
            store.removeOtherUsers(keeping: user.userId)
            for item in OfflineReceiptRules.recoverCrashedSends(store.list(userId: user.userId)) where item.status == .queued {
                try? store.save(item)
            }
        }
        wireOnce()
        refresh()
        drain()
    }

    /// Keeps a file for sending later. False when it could not be written (the caller shows an error).
    @discardableResult
    func enqueue(app: AppModel, data: Data, fileName: String, mimeType: String) -> Bool {
        start(app: app)
        guard let userId else { return false }
        do {
            try store.enqueue(userId: userId, data: data, fileName: fileName, mimeType: mimeType)
        } catch {
            return false
        }
        refresh()
        drain()
        return true
    }

    func retry(_ id: String) {
        guard let item = rows.first(where: { $0.id == id }) else { return }
        try? store.save(OfflineReceiptRules.manualRetry(item, now: Date()))
        paused = false
        refresh()
        drain()
    }

    func remove(_ id: String) {
        store.delete(id: id)
        refresh()
    }

    func clearSent() {
        for item in sent { store.delete(id: item.id) }
        refresh()
    }

    /// Sign-out: the photos of the account that left are not kept on the phone (the web wipes its
    /// queue the same way). For `AppModel.logout`.
    func clearForSignOut() {
        timer?.cancel()
        paused = false
        userId = nil
        api = nil
        if let directory = try? FileManager.default.contentsOfDirectory(atPath: store.directory.path) {
            for name in directory where name.hasSuffix(".json") { store.delete(id: String(name.dropLast(5))) }
        }
        rows = []
    }

    // MARK: Driver

    private func refresh() {
        guard let userId else { rows = []; return }
        rows = store.list(userId: userId)
    }

    private func wireOnce() {
        guard !wired else { return }
        wired = true
        observeConnectivity()
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in OfflineReceiptQueueModel.shared.drain(releaseBackoff: true) }
        }
    }

    /// Re-armed after every change: observation tracking fires once per registration.
    private func observeConnectivity() {
        withObservationTracking {
            _ = Connectivity.shared.online
        } onChange: {
            Task { @MainActor in
                let queue = OfflineReceiptQueueModel.shared
                if Connectivity.shared.online { queue.drain(releaseBackoff: true) }
                queue.observeConnectivity()
            }
        }
    }

    func drain(releaseBackoff: Bool = false) {
        guard let userId, let api, !paused else { return }
        if draining {
            if releaseBackoff { releaseAgain = true }
            return
        }
        draining = true
        timer?.cancel()
        Task {
            let now = Date()
            for id in OfflineReceiptRules.expiredDone(store.list(userId: userId), now: now) { store.delete(id: id) }
            var items = store.list(userId: userId)
            if releaseBackoff {
                for (before, after) in zip(items, OfflineReceiptRules.releaseBackoff(items, now: now)) where before != after {
                    try? store.save(after)
                }
                items = store.list(userId: userId)
            }
            rows = items
            while !paused, Connectivity.shared.online, let next = OfflineReceiptRules.pickNext(items, now: Date()) {
                await send(next, api: api)
                items = store.list(userId: userId)
                rows = items
            }
            // Offline there is nothing to wait for: the reconnect starts the next round.
            if Connectivity.shared.online { schedule(items) }
            draining = false
            if releaseAgain {
                releaseAgain = false
                drain(releaseBackoff: true)
            }
        }
    }

    private func schedule(_ items: [QueuedReceipt]) {
        timer?.cancel()
        guard let earliest = OfflineReceiptRules.earliestNextAttempt(items) else { return }
        let delay = max(0, earliest.timeIntervalSinceNow)
        timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            drain()
        }
    }

    private func send(_ item: QueuedReceipt, api: APIClient) async {
        var sending = item
        sending.status = .sending
        try? store.save(sending)
        rows = rows.map { $0.id == item.id ? sending : $0 }

        let store = self.store
        guard let data = try? await Task.detached(priority: .utility, operation: { try store.data(for: item) }).value else {
            // The file itself is gone: another try would read nothing again.
            var failed = item
            failed.status = .failed
            failed.attempts += 1
            failed.lastError = "Kuvaa ei voitu lukea. Kuvaa kuitti uudelleen."
            try? store.save(failed)
            return
        }
        var form = Multipart()
        form.addFile("file", filename: item.fileName, mimeType: item.mimeType, data: data)
        form.addField("capturedAt", item.capturedAt)

        struct Accepted: Decodable { let jobId: String? }
        var status: Int?
        var serverError: String?
        var jobId: String?
        do {
            // The queue id is the Idempotency-Key: a send whose answer was lost is not a second receipt.
            let response = try await api.raw("POST", "/api/receipts/inbox", body: form.finalize(),
                                              contentType: form.contentType, idempotencyKey: item.id)
            status = response.status
            jobId = (try? JSONDecoder().decode(Accepted.self, from: response.body))?.jobId
        } catch let error as LKError {
            status = error.status == 0 ? nil : error.status
            serverError = error.status == 0 ? nil : error.message
        } catch {
            status = nil
        }
        let outcome = OfflineReceiptRules.afterSend(item, status: status, serverError: serverError, jobId: jobId,
                                                    deviceOffline: !Connectivity.shared.online, now: Date())
        if outcome.paused { paused = true }
        try? store.save(outcome.item)
    }
}
