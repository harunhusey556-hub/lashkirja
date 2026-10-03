import SwiftUI
import UIKit
import LashKirjaCore

/// Receipts taken or picked without a connection wait on the phone and go to
/// `POST /api/receipts/inbox` when the network is back (web `useOfflineReceiptQueue.ts`).
/// One shared queue: the Kuitit card shows it, the capture flow adds to it.
///
/// Sends run oldest first, one at a time, when the queue starts, when the network comes back,
/// when the app returns to the foreground, and on a timer for the next backed-off row. Each pass
/// (`OfflineReceiptDrain`) belongs to the account it started for: unbinding cancels it, and a
/// pass that outlives its binding neither sends nor writes nor touches `rows`.
@MainActor
@Observable
final class OfflineReceiptQueueModel {
    static let shared = OfflineReceiptQueueModel()

    private(set) var rows: [QueuedReceipt] = []
    var waiting: [QueuedReceipt] { rows.filter { $0.status != .done } }
    var sent: [QueuedReceipt] { rows.filter { $0.status == .done } }
    /// A state change could not be written to the phone: sending stopped until "Yritä uudelleen".
    private(set) var storageError: String?
    /// Queue records on the phone that could not be read (found when the queue starts).
    private(set) var corrupt: [String] = []

    private let store = OfflineReceiptStore.standard()
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var userId: String?
    /// Bumped on every bind and unbind: a pass compares it to the one it started with.
    @ObservationIgnored private var binding = 0
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    /// A 401: the session is gone. Nothing more is tried until the next start after sign-in.
    @ObservationIgnored private var paused = false
    @ObservationIgnored private var releaseAgain = false
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var wired = false

    private init() {}

    /// Binds the queue to the signed-in owner and sends what is due. Safe to call often; after
    /// `detach()` it binds again.
    func start(app: AppModel) {
        guard case .signedIn(let user) = app.phase else { return }
        if userId != user.userId {
            unbind()
            userId = user.userId
            storageError = nil
            store.removeOtherUsers(keeping: user.userId)
            corrupt = store.repair().corrupt
            recoverCrashedSends()
        }
        api = app.api
        // A screen of a signed-in session is showing, so a pause from an earlier 401 is over.
        paused = false
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
        do {
            try store.save(OfflineReceiptRules.manualRetry(item, now: Date()))
        } catch {
            stopForStorage()
            return
        }
        paused = false
        // A tap on a row is also a go-ahead after a storage stop.
        if storageError != nil { retryStorage() } else { refresh(); drain() }
    }

    /// "Yritä uudelleen" on the storage notice: rows left mid-send go back to the queue (the
    /// Idempotency-Key keeps a resend from becoming a second receipt) and sending resumes.
    func retryStorage() {
        guard userId != nil, drainTask == nil else { return }
        storageError = nil
        recoverCrashedSends()
        refresh()
        drain(releaseBackoff: true)
    }

    func remove(_ id: String) {
        store.delete(id: id)
        refresh()
    }

    func clearSent() {
        for item in sent { store.delete(id: item.id) }
        refresh()
    }

    func removeCorrupt() {
        for id in corrupt { store.delete(id: id) }
        corrupt = []
    }

    /// Sign-out: the photos of the account that left are not kept on the phone (the web wipes its
    /// queue the same way). Stops a send on its way first. For `AppModel.logout`.
    func clearForSignOut() {
        unbind()
        store.removeAll()
        clearShownState()
    }

    /// The session expired: sending stops, but the photos stay for the same owner's next sign-in
    /// (`start(app:)` binds again; another account's start removes them).
    func detach() {
        unbind()
        clearShownState()
    }

    // MARK: Driver

    private func unbind() {
        binding &+= 1
        drainTask?.cancel()
        drainTask = nil
        timer?.cancel()
        timer = nil
        releaseAgain = false
        userId = nil
        api = nil
    }

    private func clearShownState() {
        paused = false
        rows = []
        storageError = nil
        corrupt = []
    }

    /// The app was closed (or the queue stopped) mid-send: those rows go back to the queue.
    private func recoverCrashedSends() {
        guard let userId else { return }
        let items = store.list(userId: userId)
        for (before, after) in zip(items, OfflineReceiptRules.recoverCrashedSends(items)) where before != after {
            do { try store.save(after) } catch { stopForStorage(); return }
        }
    }

    private func stopForStorage() {
        storageError = OfflineReceiptRules.storageFailure
        timer?.cancel()
        refresh()
    }

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
        guard let userId, let api, !paused, storageError == nil else { return }
        if drainTask != nil {
            if releaseBackoff { releaseAgain = true }
            return
        }
        timer?.cancel()
        let mine = binding
        let pass = OfflineReceiptDrain(
            store: store, userId: userId,
            isCurrent: { [weak self] in
                // Asked inside the pass's task, so a cancelled pass reads as stale too.
                guard let self, !Task.isCancelled else { return false }
                return self.binding == mine && self.userId == userId
            },
            isOnline: { Connectivity.shared.online },
            onRows: { [weak self] in self?.rows = $0 },
            upload: { item, data in await Self.upload(item, data, api: api) })
        drainTask = Task {
            let stop = await pass.run(releaseBackoff: releaseBackoff)
            // Unbound meanwhile: the new binding owns `drainTask` and the rows.
            guard binding == mine else { return }
            drainTask = nil
            switch stop {
            case .storage: stopForStorage()
            case .paused: paused = true
            // Offline there is nothing to wait for: the reconnect starts the next round.
            case .idle(let next): schedule(next)
            case .offline, .stale: break
            }
            if releaseAgain {
                releaseAgain = false
                drain(releaseBackoff: true)
            }
        }
    }

    private func schedule(_ earliest: Date?) {
        timer?.cancel()
        guard let earliest else { return }
        let delay = max(0, earliest.timeIntervalSinceNow)
        timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            drain()
        }
    }

    private static func upload(_ item: QueuedReceipt, _ data: Data, api: APIClient) async -> OfflineReceiptDrain.Answer {
        var form = Multipart()
        form.addFile("file", filename: item.fileName, mimeType: item.mimeType, data: data)
        form.addField("capturedAt", item.capturedAt)
        struct Accepted: Decodable { let jobId: String? }
        do {
            // The queue id is the Idempotency-Key: a send whose answer was lost is not a second receipt.
            let response = try await api.raw("POST", "/api/receipts/inbox", body: form.finalize(),
                                              contentType: form.contentType, idempotencyKey: item.id)
            return .init(status: response.status, jobId: (try? JSONDecoder().decode(Accepted.self, from: response.body))?.jobId)
        } catch let error as LKError {
            return error.status == 0 ? .init(status: nil) : .init(status: error.status, serverError: error.message)
        } catch {
            return .init(status: nil)
        }
    }
}
