import SwiftUI
import LashKirjaCore

/// The top of Kuitit: receipts waiting for approval, one source at a time (email, sales drafted
/// from the bank, the rest), and the rejected ones with "Palauta" (web `ReviewQueue.tsx`,
/// `RejectedReceipts.tsx`). A receipt without an amount or a vendor gets "Täydennä" and is left
/// out of the bulk approval. List rows; shows nothing when both lists are empty.
struct ReviewQueueSection: View {
    let pending: [Receipt]
    let rejected: [Receipt]
    let rejectedTotal: Int
    let pendingHasMore: Bool
    let rejectedHasMore: Bool
    let loadingPending: Bool
    let loadingRejected: Bool
    let busy: Bool
    let approve: ([String]) async -> Void
    let restore: (String) async -> Void
    let loadMorePending: () async -> Void
    /// Returns the rejected rows loaded after the page arrived.
    let loadMoreRejected: () async -> Int

    @State private var group: ReviewGroup?
    /// The queue shows its first rows only, so the receipts below stay in reach.
    @State private var showAll = false
    @State private var rejectedLimit = ShowMore()
    private static let preview = 3

    var body: some View {
        let groups = ReviewQueue.groups(pending: pending, rejectedCount: rejected.count)
        if let current = GroupChoice.pick(group, available: groups) {
            Section {
                if groups.count > 1 {
                    chips(groups, current: current)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                Text(current.description).font(.caption).foregroundStyle(Theme.ink2)
                if current == .rejected {
                    rejectedRows
                } else {
                    pendingRows(ReviewQueue.split(pending)[current] ?? [])
                }
            } header: {
                Text(current == .rejected ? "Hylätyt kuitit · \(rejectedTotal)" : "Odottaa hyväksyntää · \(pending.count)")
            }
        }
    }

    private func chips(_ groups: [ReviewGroup], current: ReviewGroup) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(groups) { item in
                    let count = item == .rejected ? rejectedTotal : (ReviewQueue.split(pending)[item]?.count ?? 0)
                    SectionChip(title: item.title, count: count, selected: item == current) {
                        withMotion(.snappy) {
                            group = item
                            showAll = false
                            rejectedLimit.reset()
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder private func pendingRows(_ rows: [Receipt]) -> some View {
        ForEach(showAll ? rows : Array(rows.prefix(Self.preview))) { receipt in
            let gaps = ReceiptApproval.gaps(receipt)
            NavigationLink(value: Route.receipt(receipt.id)) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        ReceiptRow(receipt: receipt)
                        if !gaps.isEmpty {
                            Text(ReceiptApproval.gapText(gaps)).font(.caption).foregroundStyle(Theme.warning)
                        }
                    }
                    if gaps.isEmpty {
                        // Its own button: a tap on the pill approves, the rest of the row opens the receipt.
                        Button { Task { await approve([receipt.id]) } } label: { pill("Hyväksy") }
                            .buttonStyle(.borderless)
                            .disabled(busy)
                            .accessibilityLabel("Hyväksy \(receipt.title)")
                    } else {
                        // The row opens the receipt, where the missing fields are filled in.
                        pill("Täydennä")
                    }
                }
            }
            .swipeActions(edge: .trailing) {
                if gaps.isEmpty {
                    Button("Hyväksy") { Task { await approve([receipt.id]) } }
                        .tint(Theme.successFill)
                        .disabled(busy)
                }
            }
        }
        if rows.count > Self.preview {
            Button {
                withMotion(.snappy) { showAll.toggle() }
            } label: {
                Label(showAll ? String("Näytä vähemmän") : String("Näytä kaikki (\(rows.count))"),
                      systemImage: showAll ? "chevron.up" : "chevron.down")
            }
            .foregroundStyle(Theme.ink)
        }
        if let title = ReviewQueue.approveTitle(rows) {
            Button { Task { await approve(ReviewQueue.ready(rows).map(\.id)) } } label: {
                Label(title, systemImage: "checkmark.circle")
            }
            .disabled(busy)
        }
        if let note = ReviewQueue.incompleteNote(rows) {
            Text(note).font(.caption).foregroundStyle(Theme.warning)
        }
        // The server sends the queue 200 at a time; the next page only by this button.
        if pendingHasMore && (showAll || rows.count <= Self.preview) {
            Button {
                Haptics.selection()
                Task { await loadMorePending() }
            } label: {
                HStack {
                    Text(loadingPending ? "Ladataan…" : "Lataa lisää tarkastettavia").font(.subheadline.weight(.semibold))
                    Spacer()
                    if loadingPending { ProgressView() }
                }
                .foregroundStyle(Theme.accent)
            }
            .disabled(loadingPending)
        }
    }

    @ViewBuilder private var rejectedRows: some View {
        ForEach(rejected.prefix(rejectedLimit.visible(rejected.count))) { receipt in
            NavigationLink(value: Route.receipt(receipt.id)) {
                HStack(spacing: 10) {
                    ReceiptRow(receipt: receipt)
                    Button { Task { await restore(receipt.id) } } label: { pill("Palauta") }
                        .buttonStyle(.borderless)
                        .disabled(busy)
                        .accessibilityLabel("Palauta \(receipt.title) tarkastettavaksi")
                }
            }
        }
        PagedShowMoreButton(limit: $rejectedLimit, loaded: rejected.count, total: rejectedTotal,
                            serverHasMore: rejectedHasMore, loading: loadingRejected) {
            await loadMoreRejected()
        }
    }

    private func pill(_ title: String) -> some View {
        Text(title).font(.caption.bold()).padding(.horizontal, 12).padding(.vertical, 5)
            .background(Theme.accentSoft, in: Capsule())
            .foregroundStyle(Theme.accentDark)
    }
}
