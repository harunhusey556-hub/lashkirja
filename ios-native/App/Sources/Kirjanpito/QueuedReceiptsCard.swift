import SwiftUI
import LashKirjaCore

/// Kuitit's "Jonossa N kuittia" (web `QueuedReceiptsCard.tsx`): photos still waiting for a
/// connection, with retry and remove on a failure, and the sent ones folded to one line.
/// A write the phone refused stops the queue and says so here; records that could not be read
/// are reported with a remove. List sections; shows nothing while the offline queue is empty
/// and healthy. The screen showing it starts
/// the queue (`OfflineReceiptQueueModel.start`).
///
/// Above it, "Kesken: N kuittia": files of "Lisää kuitti" still on their way, or read and not
/// saved, after its screen was closed (`CaptureQueueModel`); "Jatka" opens the screen on them.
///
/// While "Lisää kuitti" covers Kuitit the card takes each change at once, so it is already in place
/// when the cover goes down; on screen its sections fade in and out and the rows below glide
/// (W39: a section that came or went in one frame made the list below it jump).
struct QueuedReceiptsCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.listMotion) private var listMotion
    @State private var queue = OfflineReceiptQueueModel.shared
    @State private var capture = CaptureQueueModel.shared
    @State private var connectivity = Connectivity.shared
    @State private var confirmRemove: String?
    @State private var limit = ShowMore()

    /// Which sections are shown and how many rows each has: what moves the rows below.
    private struct SectionsKey: Equatable {
        let unfinished: Bool
        let storageError: Bool
        let corrupt: Bool
        let waiting: [String]
        let failed: Int
        let sent: Bool
    }

    private var sectionsKey: SectionsKey {
        SectionsKey(unfinished: capture.unfinishedCount > 0, storageError: queue.storageError != nil, corrupt: !queue.corrupt.isEmpty,
              waiting: queue.waiting.map(\.id), failed: queue.waiting.filter { $0.status == .failed }.count, sent: !queue.sent.isEmpty)
    }

    var body: some View {
        let waiting = queue.waiting
        let sent = queue.sent
        Group {
            if capture.unfinishedCount > 0 {
                Section {
                    HStack(spacing: 12) {
                        Text(capture.queue.isWorking ? "Lähetetään ja luetaan…" : "Luettu, odottaa tarkistusta ja tallennusta")
                            .font(.caption)
                            .foregroundStyle(Theme.ink2)
                        Spacer(minLength: 0)
                        Button("Jatka") {
                            Haptics.selection()
                            EventLog.shared.log(.action("resume-capture", screen: "receipts"))
                            capture.resuming = true
                            app.pendingCapture = PendingCapture(transactionId: nil)
                        }
                        .font(.caption.bold())
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                    }
                } header: {
                    Text(ReceiptUploadQueue.unfinishedTitle(capture.unfinishedCount))
                }
            }
            if let storageError = queue.storageError {
                Section {
                    Text(storageError).font(.footnote).foregroundStyle(Theme.danger)
                    Button("Yritä uudelleen") {
                        Haptics.selection()
                        quietly { queue.retryStorage() }
                    }
                    .font(.caption.bold())
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
                }
            }
            if !queue.corrupt.isEmpty {
                Section {
                    HStack(spacing: 12) {
                        Text(OfflineReceiptRules.corruptText(queue.corrupt.count)).font(.caption).foregroundStyle(Theme.ink2)
                        Spacer(minLength: 0)
                        Button("Poista", role: .destructive) {
                            Haptics.selection()
                            EventLog.shared.log(.action("remove-corrupt", screen: "receipts"))
                            Task { @MainActor in quietly { queue.removeCorrupt() } }
                        }
                        .font(.caption.bold())
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.danger)
                    }
                }
            }
            if !waiting.isEmpty {
                Section {
                    if !connectivity.online {
                        Text(OfflineReceiptRules.offlineNotice).font(.footnote).foregroundStyle(Theme.ink)
                            .listRowBackground(Theme.accentSoft)
                    }
                    ForEach(waiting.prefix(limit.visible(waiting.count))) { item in row(item) }
                    ShowMoreButton(limit: $limit, total: waiting.count)
                } header: {
                    Text(OfflineReceiptRules.waitingTitle(waiting.count))
                }
            }
            if !sent.isEmpty {
                Section {
                    HStack(spacing: 12) {
                        Text(OfflineReceiptRules.sentText(sent.count)).font(.caption).foregroundStyle(Theme.ink2)
                        Spacer(minLength: 0)
                        Button("Poista listalta") {
                            Haptics.selection()
                            EventLog.shared.log(.action("clear-sent", screen: "receipts"))
                            // After the tap has finished, and without an animation: removing the
                            // section that holds the button while its gesture is still running
                            // froze the list on a device (2026-10-08).
                            Task { @MainActor in quietly { queue.clearSent() } }
                        }
                        .font(.caption.bold())
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                    }
                } header: {
                    Text("Lähetetyt kuvat")
                }
            }
        }
        .transition(.opacity)
        .motion(capture.visible ? nil : listMotion.animation(.snappy), value: sectionsKey)
    }

    /// The owner's own taps change the card in one frame, as before: removing the section that holds
    /// the button with an animation froze the list on a device (2026-10-08).
    private func quietly(_ change: () -> Void) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction, change)
    }

    private func row(_ item: QueuedReceipt) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(OfflineReceiptRules.title(createdAt: item.createdAt)).lineLimitUnlessLarge()
                Spacer()
                if item.status == .sending { ProgressView().controlSize(.small) }
            }
            Text(OfflineReceiptRules.statusText(item))
                .font(.caption)
                .foregroundStyle(item.status == .failed ? Theme.danger : Theme.ink2)
            if item.status == .failed {
                HStack(spacing: 20) {
                    Button("Yritä uudelleen") {
                        Haptics.selection()
                        quietly { queue.retry(item.id) }
                    }
                    .foregroundStyle(Theme.accent)
                    Button("Poista", role: .destructive) { confirmRemove = item.id }
                        .foregroundStyle(Theme.danger)
                }
                .font(.caption.bold())
                .buttonStyle(.borderless)
            }
        }
        .accessibilityElement(children: .contain)
        // On the row, not the List section: a sheet modifier on a Section is copied onto every row,
        // and only the row whose photo was chosen may present it. The message names the photo by the
        // day it was taken, as the row does.
        .confirmSheet(
            isPresented: Binding(get: { confirmRemove == item.id }, set: { if !$0 { confirmRemove = nil } }),
            title: "Poista kuva jonosta?",
            message: "\(OfflineReceiptRules.title(createdAt: item.createdAt)): kuvaa ei lähetetä, jos poistat sen jonosta.",
            confirmTitle: "Poista"
        ) {
            EventLog.shared.log(.action("remove-queued", screen: "receipts"))
            Task { @MainActor in quietly { queue.remove(item.id) } }
        }
    }
}

/// The same offline queue inside "Lisää kuitti" (W39): the card above sits under the cover, so a
/// photo kept for later, being sent, refused or sent was seen only once the cover went down. One
/// compact block from the same model (`OfflineReceiptQueueModel.shared`: nothing polled here), with
/// "Yritä uudelleen"; removing a photo stays on the card. Shows nothing for an empty, healthy queue.
struct QueuedReceiptsStatus: View {
    @State private var queue = OfflineReceiptQueueModel.shared

    /// What the capture screen asks before laying out a place for the block.
    static var shows: Bool {
        let queue = OfflineReceiptQueueModel.shared
        return !queue.rows.isEmpty || queue.storageError != nil
    }

    var body: some View {
        let waiting = queue.waiting
        let failed = waiting.filter { $0.status == .failed }
        VStack(alignment: .leading, spacing: 4) {
            if let glance = OfflineReceiptRules.glance(queue.rows) {
                HStack(spacing: 8) {
                    Text(waiting.isEmpty ? "Lähetetyt kuvat" : OfflineReceiptRules.waitingTitle(waiting.count))
                        .font(.subheadline.bold())
                    Spacer(minLength: 0)
                    // A fixed slot, as on the queue's rows: the title keeps its width when a send starts.
                    ZStack {
                        if waiting.contains(where: { $0.status == .sending }) {
                            ProgressView().controlSize(.small).transition(.opacity)
                        }
                    }
                    .frame(width: 20, height: 20)
                }
                Text(glance)
                    .font(.caption)
                    .foregroundStyle(failed.isEmpty ? Theme.ink2 : Theme.danger)
                    .contentTransition(.opacity)
            }
            if let storageError = queue.storageError {
                Text(storageError).font(.footnote).foregroundStyle(Theme.danger)
            }
            if !failed.isEmpty || queue.storageError != nil {
                Button("Yritä uudelleen") {
                    Haptics.selection()
                    EventLog.shared.log(.action("retry-queued", screen: "capture"))
                    if queue.storageError != nil { queue.retryStorage() }
                    for item in failed { queue.retry(item.id) }
                }
                .font(.caption.bold())
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .motion(.snappy, value: failed.isEmpty)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("capture-queued-status")
    }
}
