import SwiftUI
import LashKirjaCore

/// Kohdista ostolaskujen maksut (web `/kirjanpito/ostolaskut/kohdistus`): every open ostolasku with the
/// outgoing bank payment the matcher proposes for it, to accept or reject one by one, or all the sure
/// ones at once. Accepting records the same payment the ostolasku sheet records; rejecting means the
/// pair is not proposed again.
struct PurchaseMatchView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<PurchaseMatchData>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    /// The ostolasku whose row is being written; its buttons wait.
    @State private var busyId: String?
    @State private var bulkBusy = false
    @State private var message: String?
    @State private var failure: String?
    /// One key per proposal: tapping "Hyväksy" again after a failure is the same payment.
    @State private var acceptKeys: [String: String] = [:]

    /// The two GETs the screen is made of: the open ostolaskut (the list asks for those alone) and
    /// the proposals. Kirjanpito warms both, and keeps what it got in `app.lastPainted`.
    static let listPath = "/api/purchase-invoices"
    static let openQuery = ["status": PurchaseFilter.open.rawValue]
    static let suggestionsPath = "/api/purchase-invoices/match"

    /// `opening` (`app.purchaseMatchPreview`, what this screen or Kirjanpito's warm-up last got) is on
    /// screen in the first frame. Loaded in `.task` instead, the push showed a spinner page and the rows
    /// came in 0.5 s later (motion kirjanpito-match-open, F011).
    init(opening: PurchaseMatchData? = nil) {
        guard let opening else { return }
        var shown = ScreenLoad<PurchaseMatchData>()
        shown.succeed(opening)
        _state = State(initialValue: shown)
    }

    var body: some View {
        List {
            if let data = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                content(data)
            } else if state.failure != nil {
                ScreenStateView(state: state, retry: load) { (_: PurchaseMatchData) in EmptyView() }
                    .listRowBackground(Color.clear)
            } else {
                placeholder
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        // The greyed rows give way to the real ones eased, as ScreenStateView's swap does: not a cut.
        .motion(.snappy, value: state.value == nil)
        // The banner eases in over the rows, so they do not jump.
        .motion(.snappy, value: state.failure != nil)
        .failureToast($failure)
        .noticeToast($message)
        .navigationTitle("Kohdista ostolaskujen maksut")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load(force: true) }
        .task(id: app.dataVersion) {
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }

    @ViewBuilder
    private func content(_ data: PurchaseMatchData) -> some View {
        if !data.rows.isEmpty {
            Section {
                // Only while a sure pair waits: with none it was the screen's one button and did
                // nothing ("Ei varmoja maksuja kohdistettavaksi."). The footer line stays alone (X168).
                if data.sureCount > 0 {
                    Button { Task { await acceptAllSure() } } label: {
                        if bulkBusy { ProgressView() } else { Text(PurchaseMatch.bulkTitle(sureCount: data.sureCount)) }
                    }
                    .buttonStyle(.primary)
                    .disabled(bulkBusy || busyId != nil)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            } footer: {
                Text("Pankin maksut avoimille ostolaskuille.")
            }
        }
        if data.rows.isEmpty {
            Section {
                ContentUnavailableView {
                    // Takes the lines it needs in a list row, as EmailInboxView's does (M073, G004).
                    Label {
                        Text(PurchaseMatch.emptyTitle)
                            .lineLimit(nil)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "building.columns")
                    }
                } description: {
                    Text(PurchaseMatch.emptyBody)
                }
            }
            .listRowBackground(Color.clear)
        }
        let proposed = data.proposed
        if !proposed.isEmpty {
            Section("Ehdotetut maksut · \(proposed.count)") {
                ForEach(proposed) { row in
                    if let suggestion = row.suggestion { proposedRow(row.invoice, suggestion) }
                }
            }
        }
        let waiting = data.waiting
        if !waiting.isEmpty {
            Section("Ei maksuehdotusta · \(waiting.count)") {
                ForEach(waiting) { row in
                    NavigationLink(value: Route.purchaseInvoice(row.invoice.id)) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(row.invoice.supplierName).foregroundStyle(Theme.ink).lineLimitUnlessLarge()
                                Spacer()
                                MoneyText(amount: row.invoice.open).font(.subheadline.weight(.semibold))
                            }
                            Text(row.invoice.rowSecondary).font(.caption).foregroundStyle(Theme.ink2).lineLimit(2)
                        }
                    }
                }
            }
        }
    }

    private func proposedRow(_ invoice: PurchaseInvoice, _ suggestion: PurchaseMatchResult.Suggestion) -> some View {
        let busy = busyId == invoice.id || bulkBusy
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(invoice.supplierName).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                Spacer()
                MoneyText(amount: invoice.open).font(.subheadline.weight(.semibold))
            }
            Text(invoice.rowSecondary).font(.caption).foregroundStyle(Theme.ink2)
            Text(PurchaseMatch.paymentLine(suggestion)).font(.caption).foregroundStyle(Theme.ink)
            if let reasons = PurchaseMatch.reasonLine(suggestion) {
                Text(reasons).font(.caption).foregroundStyle(Theme.ink2)
            }
            HStack(spacing: 12) {
                // Soft, as the row pills elsewhere: filled, it was a second primary beside "Hyväksy
                // kaikki varmat" for the same payment (M076).
                Button { Task { await accept(suggestion) } } label: {
                    if busyId == invoice.id { ProgressView() } else { Text("Hyväksy").foregroundStyle(Theme.accentDark) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accentSoft)
                .disabled(!suggestion.canAccept || busy)
                .accessibilityLabel("Hyväksy maksu ostolaskulle \(invoice.supplierName)")
                Button("Hylkää") { Task { await reject(suggestion) } }
                    .buttonStyle(.bordered)
                    .disabled(suggestion.transactionId == nil || busy)
                    .accessibilityLabel("Hylkää maksuehdotus ostolaskulle \(invoice.supplierName)")
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    // MARK: Loading

    /// The rows' shape until the first answer (cached or the server's): grey rows where the ostolaskut
    /// will be, so the list fills the space it already had instead of growing out of a spinner.
    @ViewBuilder private var placeholder: some View {
        Section {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Toimittaja Oy").foregroundStyle(Theme.ink)
                        Spacer()
                        Text("124,00 €").font(.subheadline.weight(.semibold))
                    }
                    Text("Eräpäivä 12.10.2026").font(.caption).foregroundStyle(Theme.ink2)
                }
                .redacted(reason: .placeholder)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Ladataan")
            }
        }
    }

    private func load() async { await load(force: false) }

    /// The open ostolaskut and the proposals side by side; a proposal's invoice is one of the open ones.
    /// Through the app's cache: Kirjanpito warmed both, so the page opens on rows and the server's
    /// answer replaces them in place when they are stale; `force` (pull-to-refresh) always asks.
    private func load(force: Bool) async {
        // Painted from the cache only with both answers: one alone makes no row.
        if state.value == nil,
           let cachedList: PurchaseInvoiceList = await app.cachedValue(Self.listPath, query: Self.openQuery),
           let cachedPending: PurchaseSuggestionList = await app.cachedValue(Self.suggestionsPath) {
            state.succeed(app.purchaseMatchData(cachedList, cachedPending))
        }
        state.begin()
        let suggestionsPath = Self.suggestionsPath
        async let proposals: PurchaseSuggestionList = app.cachedGet(suggestionsPath, force: force)
        do {
            let list: PurchaseInvoiceList = try await app.cachedGet(Self.listPath, query: Self.openQuery, force: force)
            let pending = try await proposals
            state.succeed(app.purchaseMatchData(list, pending))
            // The next visit's first frame (`init`).
            app.rememberPainted(list, Self.listPath, query: Self.openQuery)
            app.rememberPainted(pending, Self.suggestionsPath)
        } catch is CancellationError {
            return
        } catch {
            state.fail(error)
        }
    }

    // MARK: Actions

    private func accept(_ suggestion: PurchaseMatchResult.Suggestion) async {
        guard busyId == nil, !bulkBusy, let body = suggestion.acceptBody else { return }
        let key = acceptKeys[suggestion.id] ?? UUID().uuidString
        acceptKeys[suggestion.id] = key
        await act(on: suggestion.invoiceId, done: "Maksu kohdistettiin") {
            let _: PurchaseInvoiceResponse = try await app.api.send(
                "POST", "/api/purchase-invoices/\(suggestion.invoiceId)/payments", body: body, idempotencyKey: key
            )
        }
    }

    private func reject(_ suggestion: PurchaseMatchResult.Suggestion) async {
        guard busyId == nil, !bulkBusy, let transactionId = suggestion.transactionId else { return }
        await act(on: suggestion.invoiceId, done: "Ehdotus hylättiin") {
            let _: Ignored = try await app.api.send(
                "POST", "/api/purchase-invoices/match/reject",
                body: PurchaseSuggestionReject(invoiceId: suggestion.invoiceId, transactionId: transactionId)
            )
        }
    }

    private func act(on invoiceId: String, done: String, _ work: () async throws -> Void) async {
        busyId = invoiceId
        message = nil
        failure = nil
        defer { busyId = nil }
        do {
            try await work()
            Haptics.success()
            message = done
            // The list, the Ostolaskut screen and Koti all read this payment: they reload.
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }

    /// Viite hits first (the server books those itself), then every sure proposal left.
    private func acceptAllSure() async {
        guard !bulkBusy, busyId == nil else { return }
        bulkBusy = true
        message = nil
        failure = nil
        defer { bulkBusy = false }
        var accepted = 0
        var failed = 0
        do {
            let result: PurchaseMatchResult = try await app.api.send("POST", "/api/purchase-invoices/match", body: EmptyBody())
            accepted += result.applied.count
            // One at a time: each payment changes what is still open on its invoice.
            for suggestion in PurchaseMatch.sureSuggestions(result.suggestions) {
                guard let body = suggestion.acceptBody else {
                    failed += 1
                    continue
                }
                let key = acceptKeys[suggestion.id] ?? UUID().uuidString
                acceptKeys[suggestion.id] = key
                do {
                    let _: PurchaseInvoiceResponse = try await app.api.send(
                        "POST", "/api/purchase-invoices/\(suggestion.invoiceId)/payments", body: body, idempotencyKey: key
                    )
                    accepted += 1
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    failed += 1
                }
            }
            if failed > 0 { Haptics.error() } else { Haptics.success() }
            message = PurchaseMatch.bulkSummary(accepted: accepted, failed: failed)
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
        // Whatever went through changes the list, so it is asked again even after a failure.
        if accepted > 0 || failed > 0 { app.dataVersion += 1 }
    }
}

extension AppModel {
    /// The rows as Kohdista (or Kirjanpito's warm-up) last got them; nil unless both answers are known.
    func purchaseMatchPreview() -> PurchaseMatchData? {
        guard let list: PurchaseInvoiceList = lastPainted(PurchaseMatchView.listPath, query: PurchaseMatchView.openQuery),
              let pending: PurchaseSuggestionList = lastPainted(PurchaseMatchView.suggestionsPath) else { return nil }
        return purchaseMatchData(list, pending)
    }

    /// A proposal's invoice is one of the open ones; one deleted but not yet confirmed is left out.
    func purchaseMatchData(_ list: PurchaseInvoiceList, _ pending: PurchaseSuggestionList) -> PurchaseMatchData {
        PurchaseMatchData(invoices: list.invoices.filter { !removedIds.contains($0.id) }, suggestions: pending.suggestions)
    }
}
