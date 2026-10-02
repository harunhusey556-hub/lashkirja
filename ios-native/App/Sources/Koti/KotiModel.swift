import SwiftUI
import Observation
import LashKirjaCore

@MainActor
@Observable
final class KotiModel {
    private let api: APIClient
    var month: String = MonthKey.current()
    private(set) var state: Loadable<Dashboard> = .idle
    /// Rows the owner just acted on: gone from the list at once, back if undone or failed,
    /// and not brought back by a reload while the action is still waiting or on its way.
    private(set) var hidden = KotiHiddenRows()
    /// Only the latest load writes the screen: stepping months quickly, an older month's
    /// slower answer is dropped.
    private var loads = LoadGeneration()
    var toast: Toast?
    private var pendingCommit: (() async -> Void)?
    private var toastTask: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    var visibleItems: [DashboardItem] { state.value?.items.filter { !hidden.contains($0.id) } ?? [] }
    var atCurrentMonth: Bool { month >= MonthKey.current() }

    func load() async {
        let generation = loads.next()
        let month = self.month
        if state.value == nil { state = .loading }
        do {
            let dashboard: Dashboard = try await api.get("/api/dashboard", query: ["month": month])
            guard loads.isCurrent(generation), month == self.month else { return }
            hidden.reloaded(present: dashboard.items.map(\.id), loadGeneration: generation)
            state = .loaded(dashboard)
        } catch is CancellationError {
            return
        } catch {
            guard loads.isCurrent(generation), month == self.month else { return }
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    func step(_ delta: Int) async {
        let next = MonthKey.shift(month, by: delta)
        guard next <= MonthKey.current() else { return }
        month = next
        Haptics.selection()
        await load()
    }

    /// Hyväksy: the row leaves at once; the approval is sent when the toast
    /// closes without "Kumoa" (the web app's undo pattern).
    func approve(_ item: DashboardItem) {
        guard let receiptId = item.receiptId else { return }
        hide(item.id)
        Haptics.success()
        offerUndo("\(item.party) hyväksyttiin", itemId: item.id) { [api] in
            struct Body: Encodable { let reviewStatus = "approved" }
            let _: Ignored = try await api.send("PATCH", "/api/receipts/\(receiptId)/review", body: Body())
        }
    }

    /// Kohdista: books the bank row as the invoice's payment.
    func confirmMatch(_ item: DashboardItem) {
        guard let invoiceId = item.invoiceId, let transactionId = item.transactionId, let amount = item.amount, let paidDate = item.paidDate else { return }
        hide(item.id)
        Haptics.success()
        let key = UUID().uuidString
        offerUndo("Maksu kirjattiin laskulle \(item.number.map(String.init) ?? "")", itemId: item.id) { [api] in
            struct Body: Encodable { let amount: Decimal; let paidDate: String; let transactionId: String }
            let _: Ignored = try await api.send("POST", "/api/invoices/\(invoiceId)/payments",
                                                body: Body(amount: amount, paidDate: paidDate, transactionId: transactionId),
                                                idempotencyKey: key)
        }
    }

    func undo() {
        toastTask?.cancel()
        pendingCommit = nil
        if let id = undoItemId { withAnimation { hidden.unhide(id) } }
        undoItemId = nil
        withAnimation { toast = nil }
    }

    private var undoItemId: String?

    private func hide(_ id: String) {
        withAnimation(.snappy) { hidden.hide(id) }
    }

    private func offerUndo(_ text: String, itemId: String, commit: @escaping () async throws -> Void) {
        flushPending()
        undoItemId = itemId
        pendingCommit = { [weak self] in
            do {
                try await commit()
                await MainActor.run {
                    guard let self else { return }
                    self.hidden.settled(itemId, loadGeneration: self.loads.current)
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    withAnimation { self.hidden.unhide(itemId) }
                    self.toast = Toast(text: error.userMessage, actionLabel: nil)
                }
            }
        }
        withAnimation(.snappy) { toast = Toast(text: text, actionLabel: "Kumoa") }
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.flushPending()
        }
    }

    /// Sends the waiting action now (a new action, or the toast timing out).
    private func flushPending() {
        toastTask?.cancel()
        guard let commit = pendingCommit else { return }
        pendingCommit = nil
        undoItemId = nil
        withAnimation { toast = nil }
        Task { await commit() }
    }
}
