import SwiftUI
import LashKirjaCore

/// The top of Kuitit: receipts waiting for approval, one source at a time (email, sales drafted
/// from the bank, the rest), and the rejected ones with "Palauta" (web `ReviewQueue.tsx`,
/// `RejectedReceipts.tsx`). A receipt without an amount or a vendor gets "Täydennä" and is left
/// out of the bulk approval. List rows; shows nothing when both lists are empty.
struct ReviewQueueSection: View {
    @Environment(\.listMotion) private var listMotion
    let pending: [Receipt]
    let rejected: [Receipt]
    let rejectedTotal: Int
    let pendingHasMore: Bool
    let rejectedHasMore: Bool
    let loadingPending: Bool
    let loadingRejected: Bool
    let busy: Bool
    /// Kuitit is picking rows: the card stays where it is, dimmed and not tappable.
    let dimmed: Bool
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
                if let caption = current.caption(chipsShown: groups.count > 1) {
                    Text(caption).font(.caption).foregroundStyle(Theme.ink2)
                }
                if current == .rejected {
                    rejectedRows
                } else {
                    pendingRows(ReviewQueue.split(pending)[current] ?? [])
                }
            } header: {
                Text(current == .rejected ? "Hylätyt kuitit · \(rejectedTotal)" : "Odottaa hyväksyntää · \(pending.count)")
            }
            // The last page arriving removes "Lataa lisää" at the foot of the list: it fades out
            // instead of vanishing, and the rows below don't jump.
            .motion(listMotion.animation(.snappy), value: pendingHasMore)
            .disabled(dimmed)
            .opacity(dimmed ? 0.4 : 1)
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
                VStack(alignment: .leading, spacing: 2) {
                    // The pill under the amount, as on Koti's task rows: beside it, the pill cut a
                    // vendor to 'Audit Hyvitys Odott…' and wrapped the line under it (X037).
                    ReceiptRow(receipt: receipt, wrapsTitle: true) {
                        if gaps.isEmpty {
                            // Not a button of its own: approving from the queue meant approving a receipt
                            // nobody had seen. The row opens the receipt, whose picture sits above "Hyväksy".
                            pill("Tarkista")
                        } else {
                            // The row opens the receipt, where the missing fields are filled in.
                            pill("Täydennä")
                        }
                    }
                    if !gaps.isEmpty {
                        Text(ReceiptApproval.gapText(gaps)).font(.caption).foregroundStyle(Theme.warning)
                    }
                }
            }
            .swipeActions(edge: .trailing) {
                if gaps.isEmpty && !dimmed {
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
        // No "N kuittia vaatii täydennyksen." under it: each such row says what it lacks beside its
        // Täydennä, and "Hyväksy valmiit" counts only the ready ones (M010).
        if let title = ReviewQueue.approveTitle(rows) {
            Button { Task { await approve(ReviewQueue.ready(rows).map(\.id)) } } label: {
                Label(title, systemImage: "checkmark.circle")
            }
            .disabled(busy)
        }
        // The server sends the queue 200 at a time; the next page only by this button.
        if pendingHasMore && (showAll || rows.count <= Self.preview) {
            Button {
                Haptics.selection()
                Task { await loadMorePending() }
            } label: {
                HStack {
                    Text(loadingPending ? "Ladataan…" : "Lataa lisää tarkastettavia").font(.subheadline.weight(.semibold))
                        .contentTransition(.opacity)
                    Spacer()
                    // Always laid out, only faded: the row never changes height or width
                    // when the next page starts or finishes loading.
                    ProgressView()
                        .opacity(loadingPending ? 1 : 0)
                        .accessibilityHidden(!loadingPending)
                }
                .foregroundStyle(Theme.accent)
                .motion(listMotion.animation(.snappy), value: loadingPending)
            }
            .disabled(loadingPending)
            .transition(.opacity)
        }
    }

    @ViewBuilder private var rejectedRows: some View {
        ForEach(rejected.prefix(rejectedLimit.visible(rejected.count))) { receipt in
            NavigationLink(value: Route.receipt(receipt.id)) {
                ReceiptRow(receipt: receipt, wrapsTitle: true) {
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
