import SwiftUI
import LashKirjaCore

/// Kuitit's "Jonossa N kuittia" (web `QueuedReceiptsCard.tsx`): photos still waiting for a
/// connection, with retry and remove on a failure, and the sent ones folded to one line.
/// A write the phone refused stops the queue and says so here; records that could not be read
/// are reported with a remove. List sections; shows nothing while the offline queue is empty
/// and healthy. The screen showing it starts
/// the queue (`OfflineReceiptQueueModel.start`).
struct QueuedReceiptsCard: View {
    @State private var queue = OfflineReceiptQueueModel.shared
    @State private var connectivity = Connectivity.shared
    @State private var confirmRemove: String?
    @State private var limit = ShowMore()

    var body: some View {
        let waiting = queue.waiting
        let sent = queue.sent
        Group {
            if let storageError = queue.storageError {
                Section {
                    Text(storageError).font(.footnote).foregroundStyle(Theme.danger)
                    Button("Yritä uudelleen") {
                        Haptics.selection()
                        queue.retryStorage()
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
                            Task { @MainActor in queue.removeCorrupt() }
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
                .confirmationDialog("Poista kuva jonosta?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
                                    titleVisibility: .visible) {
                    Button("Poista", role: .destructive) {
                        if let id = confirmRemove {
                            EventLog.shared.log(.action("remove-queued", screen: "receipts"))
                            Task { @MainActor in queue.remove(id) }
                        }
                        confirmRemove = nil
                    }
                } message: {
                    Text("Kuvaa ei lähetetä, jos poistat sen jonosta.")
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
                            Task { @MainActor in queue.clearSent() }
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
                        queue.retry(item.id)
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
    }
}
