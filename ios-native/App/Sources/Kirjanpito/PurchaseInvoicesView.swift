import SwiftUI
import LashKirjaCore

/// Ostolaskut: what the business owes and when (web `/kirjanpito/ostolaskut`).
struct PurchaseInvoicesView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("ostolaskut.filter") private var filterRaw = PurchaseFilter.all.rawValue
    @State private var state = ScreenLoad<PurchaseInvoiceList>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var counts: PurchaseStatusCounts?
    /// Invoice id → its recurring template, for the "Toistuva" tag.
    @State private var recurringIds: [String: String] = [:]
    /// Running recurring templates; nil until known, or while the server lacks the feature.
    @State private var recurringCount: Int?
    @State private var message: String?
    @State private var failure: String?
    @State private var busy = false
    @State private var showNew = false
    @State private var payTarget: PurchaseInvoice?
    /// "Liitä kuitti" from the row, without opening the invoice first.
    @State private var receiptTarget: PurchaseInvoice?
    @State private var deleteTarget: PurchaseInvoice?
    @State private var limit = ShowMore()
    /// Bank rows the matcher thinks paid an invoice (`GET /api/purchase-invoices/match`), for "N ehdotusta".
    @State private var suggestions: [PurchaseMatchResult.Suggestion] = []
    @State private var showSuggestions = false
    /// A link's chip (a VAT figure opens every status); the owner's own pick replaces it.
    /// Kept apart from `filterRaw` so a link never overwrites the chip remembered between visits.
    @State private var linked: PurchaseFilter?
    /// "Valitse": invoices picked for a bulk action.
    @State private var selection = BulkSelection()
    @State private var bulkAction: BulkAction?
    /// The reason the server wants when payments do not cover an invoice marked paid.
    @State private var bulkReason = ""

    enum BulkAction: Identifiable {
        case markPaid, delete
        var id: Self { self }
    }

    init(status: PurchaseFilter? = nil) {
        _linked = State(initialValue: status)
    }

    private var filter: PurchaseFilter { linked ?? PurchaseFilter(rawValue: filterRaw) ?? .all }

    var body: some View {
        List {
            if let list = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                content(list)
            } else {
                ScreenStateView(state: state, retry: load) { (_: PurchaseInvoiceList) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Ostolaskut")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if selection.isActive {
                    let ids = shownInvoices.map(\.id)
                    Button(selection.allSelected(ids) ? "Poista valinnat" : "Valitse kaikki") { selection.toggleAll(ids) }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if selection.isActive {
                    Button("Valmis") { selection.end() }
                } else if !shownInvoices.isEmpty {
                    Button("Valitse") { selection.begin() }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.recurringPurchases) { Image(systemName: "repeat") }
                    .accessibilityLabel(RecurringPurchaseText.title)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Uusi ostolasku")
            }
        }
        .safeAreaInset(edge: .bottom) {
            let picked = pickedInvoices
            if selection.isActive && !picked.isEmpty {
                let payable = PurchaseBulk.payable(picked).count
                let deletable = PurchaseBulk.deletable(picked).count
                BulkBar(count: picked.count, busy: busy, onCancel: { selection.end() }) {
                    if payable > 0 {
                        BulkBarButton(title: PurchaseBulk.markPaidLabel(payable)) {
                            bulkReason = ""
                            bulkAction = .markPaid
                        }
                    }
                    if deletable > 0 {
                        BulkBarButton(title: PurchaseBulk.deleteLabel(deletable), destructive: true) { bulkAction = .delete }
                    }
                }
            }
        }
        // A reason to type keeps the alert (text input); every plain yes/no is the confirm sheet.
        .alert(PurchaseBulk.markPaidTitle(PurchaseBulk.payable(pickedInvoices).count),
               isPresented: Binding(get: { bulkAction == .markPaid && bulkNeedsReason },
                                    set: { if !$0 { bulkAction = nil } })) {
            TextField("Perustelu", text: $bulkReason)
            Button("Merkitse maksetuksi") { Task { await markPaidSelected() } }
                .disabled(!PurchaseStatusChange.reasonIsLongEnough(bulkReason))
            Button("Peruuta", role: .cancel) {}
        } message: {
            Text("Osalle laskuista ei ole kirjattu maksuja koko summalle. Kirjoita vähintään kolmen merkin perustelu, esim. maksettu käteisellä.")
        }
        .confirmSheet(presenting: Binding(get: { bulkAction == .markPaid && bulkNeedsReason ? nil : bulkAction },
                                          set: { if $0 == nil { bulkAction = nil } })) { action in
            bulkConfirmRequest(action)
        }
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(key: filter.rawValue, version: app.refreshEverything())
            await load()
        }
        .task(id: "\(filter.rawValue)|\(app.dataVersion)") {
            guard state.value == nil || gate.isDue(key: filter.rawValue, version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: filter.rawValue, version: version) }
        }
        .disabled(busy)
        .sheet(isPresented: $showNew) { PurchaseInvoiceFormView(existing: nil) }
        .sheet(item: $payTarget) { invoice in PurchasePaymentSheet(invoice: invoice) }
        .sheet(item: $receiptTarget) { invoice in PurchaseReceiptLinkSheet(invoice: invoice) }
        .sheet(isPresented: $showSuggestions) { PurchaseSuggestionsSheet(suggestions: suggestions) }
        .confirmSheet(presenting: $deleteTarget) { invoice in
            ConfirmRequest(
                title: "Poistetaanko ostolasku?",
                message: "\(invoice.supplierName) · \(Money.format(invoice.gross))",
                confirmTitle: "Poista",
                onConfirm: { Task { await delete(invoice) } }
            )
        }
        .motion(.snappy, value: filter)
    }

    @ViewBuilder
    private func content(_ list: PurchaseInvoiceList) -> some View {
        // One list, status by status (Myöhässä first): a status chip narrows it instead of stacked sections.
        let rows = PurchaseFilter.groups(list.invoices.filter { !app.removedIds.contains($0.id) }, filter: filter).flatMap(\.items)
        let visibleCount = rows.count
        let noPurchases = visibleCount == 0 && filter == .all

        if let recurringCount {
            Section {
                NavigationLink(value: Route.recurringPurchases) {
                    HStack {
                        Label(RecurringPurchaseText.title, systemImage: "repeat")
                        Spacer()
                        Text(RecurringPurchaseText.countLabel(recurringCount)).font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                }
            }
        }

        if !noPurchases {
            if let aging = list.aging {
                Section { summary(aging) }
            }
            Section {
                Button { Task { await runBankMatch() } } label: {
                    Label("Hae ostolaskujen maksut pankista", systemImage: "arrow.left.arrow.right")
                }
                if !suggestions.isEmpty {
                    Button { showSuggestions = true } label: {
                        HStack {
                            Label("Maksuehdotukset", systemImage: "link")
                            Spacer()
                            Text(PurchaseBankLinkText.suggestionCount(suggestions.count))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
                        }
                    }
                    .accessibilityHint("Hyväksy tai hylkää ehdotetut maksut")
                }
            } footer: {
                Text("Kohdistaa pankin lähtevät maksut ostolaskuihin viitenumerolla. Summan ja toimittajan perusteella löytyneet ovat ehdotuksia.")
            }
        }

        if let message {
            Section {
                Text(message).font(.subheadline).foregroundStyle(Theme.ink)
            }
            .listRowBackground(Theme.accentSoft)
        }
        if let failure {
            Section { Text(failure).font(.subheadline).foregroundStyle(Theme.danger) }
        }

        if !noPurchases {
            Section {
                chips.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
        }

        if !rows.isEmpty {
            Section {
                ForEach(rows.prefix(limit.visible(rows.count))) { invoice in row(invoice) }
                ShowMoreButton(limit: $limit, total: rows.count)
            } header: {
                Text("\(filter.label) · \(rows.count)")
            }
        }

        if visibleCount == 0 {
            Section {
                if filter == .all {
                    ContentUnavailableView {
                        Label("Ei ostolaskuja vielä", systemImage: "doc.text")
                    } description: {
                        Text("Tähän ilmestyvät saamasi ostolaskut ja niiden eräpäivät.")
                    } actions: {
                        Button("Uusi ostolasku") { showNew = true }.buttonStyle(.primary)
                    }
                } else {
                    ContentUnavailableView {
                        Label("Ei ostolaskuja tällä suodattimella", systemImage: "line.3.horizontal.decrease.circle")
                    } description: {
                        Text("Kokeile toista suodatinta.")
                    } actions: {
                        Button("Tyhjennä suodatin") {
                            pick(.all)
                        }
                    }
                }
            }
            .listRowBackground(Color.clear)
        }

        if list.invoices.count == PurchaseInvoiceList.limit {
            Section {
                Text("Näytetään \(PurchaseInvoiceList.limit) vanhinta erääntyvää laskua. Valitse suodatin nähdäksesi kaikki.")
                    .font(.caption).foregroundStyle(Theme.ink2)
            }
            .listRowBackground(Color.clear)
        }
    }

    @ViewBuilder private func row(_ invoice: PurchaseInvoice) -> some View {
        if selection.isActive {
            Button { selection.toggle(invoice.id) } label: {
                HStack(spacing: 12) {
                    BulkCheckmark(selected: selection.contains(invoice.id))
                    PurchaseInvoiceRow(invoice: invoice, recurring: recurringIds[invoice.id] != nil)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityAddTraits(selection.contains(invoice.id) ? .isSelected : [])
        } else {
            linkRow(invoice)
        }
    }

    private func linkRow(_ invoice: PurchaseInvoice) -> some View {
        NavigationLink(value: Route.purchaseInvoice(invoice.id)) {
            PurchaseInvoiceRow(invoice: invoice, recurring: recurringIds[invoice.id] != nil)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if invoice.canDelete {
                Button(role: .destructive) { deleteTarget = invoice } label: { Label("Poista", systemImage: "trash") }
            }
        }
        .swipeActions(edge: .leading) {
            if invoice.canRecordPayment {
                Button { payTarget = invoice } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
                    .tint(Theme.successFill)
            }
            if invoice.canLinkReceipt {
                Button { receiptTarget = invoice } label: { Label("Liitä kuitti", systemImage: "paperclip") }
                    .tint(Theme.accent)
            }
        }
        .contextMenu {
            if invoice.canLinkReceipt {
                Button { receiptTarget = invoice } label: { Label("Liitä kuitti", systemImage: "paperclip") }
            }
            if invoice.canRecordPayment {
                Button { payTarget = invoice } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
            }
        }
    }

    private var chips: some View {
        let items: [PurchaseFilter.Chip] = counts.map { PurchaseFilter.chips($0) } ?? []
        let fallback: [PurchaseFilter] = [.all, .overdue, .open, .paid]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if items.isEmpty {
                    ForEach(fallback) { option in chip(option, label: option.label) }
                } else {
                    ForEach(items) { item in chip(item.filter, label: "\(item.label) \(item.count)") }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func chip(_ option: PurchaseFilter, label: String) -> some View {
        let selected = option == filter
        return Button {
            Haptics.selection()
            pick(option)
        } label: {
            Text(label)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? Theme.onInk : Theme.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(selected ? Theme.ink : Theme.surface, in: Capsule())
                .overlay(Capsule().stroke(Theme.line, lineWidth: selected ? 0 : 1))
        }
        .buttonStyle(.pressable)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func pick(_ option: PurchaseFilter) {
        linked = nil
        filterRaw = option.rawValue
        limit.reset()
    }

    private func summary(_ aging: PurchaseInvoiceList.Aging) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Avoinna").font(.caption).foregroundStyle(Theme.ink2)
                    MoneyText(amount: aging.totalOpen).font(.title2.weight(.semibold))
                }
                Spacer()
                if aging.overdueCount > 0 {
                    // The late figure narrows the list to the late bills; a second tap shows them all again.
                    Button {
                        Haptics.selection()
                        pick(filter == .overdue ? .all : .overdue)
                    } label: {
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("Myöhässä").font(.caption).foregroundStyle(Theme.danger)
                            HStack(spacing: 4) {
                                MoneyText(amount: aging.overdue).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.danger)
                                Image(systemName: filter == .overdue ? "xmark.circle.fill" : "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.danger)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Myöhässä \(aging.overdueCount) ostolaskua, \(Money.format(aging.overdue))")
                    .accessibilityHint(filter == .overdue ? "Näytä kaikki ostolaskut" : "Näytä myöhässä olevat ostolaskut")
                }
            }
            HStack(spacing: 0) {
                ForEach(PurchaseInvoiceList.Aging.overdueBuckets, id: \.self) { bucket in
                    VStack(spacing: 2) {
                        Text("\(bucket) pv").font(.caption2).foregroundStyle(Theme.ink2)
                        MoneyText(amount: aging.bucket(bucket)).font(.caption.weight(.medium)).foregroundStyle(Theme.ink)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// Through the app's cache: the last list for this chip at once, then the server's when stale.
    private func load() async {
        let timing = ScreenTiming("Ostolaskut")
        var query: [String: String] = [:]
        if let status = filter.queryValue { query["status"] = status }
        // The cached list when it could not be painted with its rows: still better than an error offline.
        var unpainted: PurchaseInvoiceTaggedList?
        if state.value == nil, let cached: PurchaseInvoiceTaggedList = await app.cachedValue("/api/purchase-invoices", query: query) {
            let cachedCounts: PurchaseInvoiceCountsResponse? = await app.cachedValue("/api/purchase-invoices/counts")
            let cachedRecurring: RecurringPurchaseList? = await app.cachedValue("/api/recurring-purchases")
            let cachedPending: PurchaseSuggestionList? = await app.cachedValue("/api/purchase-invoices/match")
            // Painted from the cache only with the rows above the list and the chips' counts: a
            // list cached without them got them from the server a beat later, which pushed it
            // down (motion audit kirjanpito-purchases-open, CI 2026-10-17). Then the server's
            // answer is the first paint.
            if let cachedCounts, let cachedRecurring, let cachedPending {
                state.succeed(cached.list)
                recurringIds = cached.recurringIds
                counts = cachedCounts.counts
                recurringCount = cachedRecurring.activeCount
                suggestions = cachedPending.suggestions.filter(\.canAccept)
                timing.painted(fromCache: true)
            } else {
                unpainted = cached
            }
        }
        state.begin()
        // Counts load alongside the list (one round trip instead of two).
        async let freshCounts: PurchaseInvoiceCountsResponse? = try? app.cachedGet("/api/purchase-invoices/counts")
        // Optional: a server without recurring purchases (404) simply hides the row.
        async let recurring: RecurringPurchaseList? = try? app.cachedGet("/api/recurring-purchases")
        // Optional too: an older server without the suggestion list simply shows none.
        async let pending: PurchaseSuggestionList? = try? app.cachedGet("/api/purchase-invoices/match")
        do {
            let tagged: PurchaseInvoiceTaggedList = try await app.cachedGet("/api/purchase-invoices", query: query, persist: query.isEmpty)
            // The list and the rows above it (Toistuvat, suggestions) land in one update: shown
            // apart, the recurring row arrived a beat later and pushed the list down 18 pt
            // (motion audit kirjanpito-purchases-open). They load side by side, so this waits
            // only for the slowest.
            let fresh = (counts: await freshCounts, recurring: await recurring, pending: await pending)
            state.succeed(tagged.list)
            recurringIds = tagged.recurringIds
            failure = nil
            if let response = fresh.counts { counts = response.counts }
            recurringCount = fresh.recurring.map { $0.activeCount }
            if let list = fresh.pending { suggestions = list.suggestions.filter(\.canAccept) }
            timing.dataReady()
        } catch is CancellationError {
            return
        } catch {
            if state.value == nil, let unpainted {
                state.succeed(unpainted.list)
                recurringIds = unpainted.recurringIds
            }
            state.fail(error)
            if let response = await freshCounts { counts = response.counts }
            recurringCount = await recurring.map { $0.activeCount }
            if let list = await pending { suggestions = list.suggestions.filter(\.canAccept) }
        }
    }

    private func runBankMatch() async {
        busy = true
        message = nil
        failure = nil
        defer { busy = false }
        do {
            let result: PurchaseMatchResult = try await app.api.send("POST", "/api/purchase-invoices/match", body: EmptyBody())
            Haptics.success()
            withMotion {
                message = result.summary
                suggestions = result.suggestions.filter(\.canAccept)
            }
            if !result.applied.isEmpty { app.dataVersion += 1 }
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }

    private func delete(_ invoice: PurchaseInvoice) async {
        failure = nil
        let api = app.api, id = invoice.id
        withMotion {
            app.removeInBackground([id]) {
                let _: Ignored = try await api.send("DELETE", "/api/purchase-invoices/\(id)", body: Optional<EmptyBody>.none)
            }
        }
    }

    // MARK: Bulk actions

    /// The rows on screen: the chip's list as far as "Näytä lisää" has opened it. Bulk actions
    /// take only these, never rows a filter or a fold hides.
    private var shownInvoices: [PurchaseInvoice] {
        guard let list = state.value else { return [] }
        let rows = PurchaseFilter.groups(list.invoices.filter { !app.removedIds.contains($0.id) }, filter: filter).flatMap(\.items)
        return Array(rows.prefix(limit.visible(rows.count)))
    }

    private var pickedInvoices: [PurchaseInvoice] {
        guard selection.isActive else { return [] }
        return shownInvoices.filter { selection.contains($0.id) }
    }

    /// "Merkitse maksetuksi": `PATCH /api/purchase-invoices/[id]` with `status: paid` for each open
    /// picked invoice, with the reason when one is needed. No batch route exists for purchases.
    private var bulkNeedsReason: Bool { PurchaseBulk.needsReason(pickedInvoices) }

    private func bulkConfirmRequest(_ action: BulkAction) -> ConfirmRequest {
        switch action {
        case .markPaid:
            return ConfirmRequest(title: PurchaseBulk.markPaidTitle(PurchaseBulk.payable(pickedInvoices).count),
                                  message: "Kirjatut maksut kattavat laskujen summat.",
                                  confirmTitle: "Merkitse maksetuksi", isDestructive: false,
                                  onConfirm: { Task { await markPaidSelected() } })
        case .delete:
            return ConfirmRequest(title: PurchaseBulk.deleteTitle(PurchaseBulk.deletable(pickedInvoices).count),
                                  message: "Laskut, joilla on maksuja tai hyvityksiä, jäävät paikalleen.",
                                  confirmTitle: "Poista",
                                  onConfirm: { Task { await deleteSelected() } })
        }
    }

    private func markPaidSelected() async {
        let invoices = PurchaseBulk.payable(pickedInvoices)
        let reason = bulkReason.trimmingCharacters(in: .whitespacesAndNewlines)
        let change = PurchaseStatusChange(status: .paid, closeReason: reason.isEmpty ? nil : reason)
        await runEach("Merkittiin maksetuksi", invoices.map(\.id)) { id in
            let _: PurchaseInvoiceResponse = try await app.api.send("PATCH", "/api/purchase-invoices/\(id)", body: change)
        }
    }

    /// "Poista": `DELETE /api/purchase-invoices/[id]` for each picked invoice that can go. The rows
    /// leave the list at once; the refused ones come back.
    private func deleteSelected() async {
        let ids = PurchaseBulk.deletable(pickedInvoices).map(\.id)
        withMotion { app.hide(ids) }
        await runEach("Poistettiin", ids) { id in
            let _: Ignored = try await app.api.send("DELETE", "/api/purchase-invoices/\(id)", body: Optional<EmptyBody>.none)
        }
        // What failed stays picked and is shown again.
        withMotion { app.unhide(Array(selection.ids)) }
    }

    /// One call per invoice, one after another; what failed stays picked, named by its first reason.
    private func runEach(_ verb: String, _ ids: [String], _ work: (String) async throws -> Void) async {
        guard !ids.isEmpty, !busy else { return }
        busy = true
        message = nil
        failure = nil
        defer { busy = false }
        var done = 0
        var failed: [String] = []
        var reasons: [String] = []
        for (index, id) in ids.enumerated() {
            do {
                try await work(id)
                done += 1
            } catch is CancellationError {
                // Not sent: they stay picked (and, for a delete, come back to the list).
                let rest = Array(ids[index...])
                failed += rest
                reasons += rest.map { _ in "" }
                break
            } catch {
                failed.append(id)
                reasons.append(error.userMessage)
            }
        }
        let outcome = BulkBatch.outcome(verb, done: done, failures: reasons)
        if failed.isEmpty {
            message = outcome
            Haptics.success()
        } else {
            failure = outcome
            Haptics.error()
        }
        selection.finish(failed: failed)
        if done > 0 { app.dataVersion += 1 }
    }
}

/// One purchase invoice: amounts, receipt link, payments and the status actions.
struct PurchaseInvoiceDetailView: View {
    let purchaseInvoiceId: String

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var state = ScreenLoad<PurchaseInvoice>()
    @State private var links: PurchaseReceiptLinks?
    /// The recurring template that made this invoice, when one did.
    @State private var recurringPurchaseId: String?
    @State private var openTemplate: String?
    @State private var notice: String?
    @State private var sheet: SheetKind?
    @State private var confirm: ConfirmKind?
    @State private var busy = false
    @State private var failure: String?

    enum SheetKind: String, Identifiable {
        case edit, payment, bankLink, markPaid, makeRecurring, credit
        var id: String { rawValue }
    }

    enum ConfirmKind: Identifiable {
        case delete, cancel, reopen, markPaid
        case removePayment(PurchaseInvoice.Payment)
        /// A payment that holds a bank row: removing it frees the row.
        case unlinkPayment(PurchaseInvoice.Payment)

        var id: String {
            switch self {
            case .delete: "delete"
            case .cancel: "cancel"
            case .reopen: "reopen"
            case .markPaid: "markPaid"
            case .removePayment(let payment): "payment-\(payment.id)"
            case .unlinkPayment(let payment): "unlink-\(payment.id)"
            }
        }
    }

    var body: some View {
        List {
            if let invoice = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    header(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                if let failure {
                    Section { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
                }
                if let notice {
                    Section { Text(notice).font(.subheadline) }
                        .listRowBackground(Theme.accentSoft)
                }
                details(invoice)
                receiptSection(invoice)
                if !invoice.isCreditNote { paymentsSection(invoice) }
                PurchaseCreditLinksSection(invoice: invoice)
                if let notes = invoice.notes, !notes.isEmpty {
                    Section("Lisätiedot") { Text(notes) }
                }
                if let reason = invoice.closedReason, !reason.isEmpty {
                    Section("Perustelu") { Text(reason) }
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: PurchaseInvoice) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(state.value?.supplierName ?? "Ostolasku")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let invoice = state.value {
                ToolbarItem(placement: .topBarTrailing) { actions(invoice) }
            }
        }
        .safeAreaInset(edge: .bottom) {
            ZStack {
                if state.value?.canRecordPayment == true { primaryBar }
            }
            // Nil counts as open: the bar comes with the bill's first loaded frame, unanimated, and
            // only fades when the bill itself changes (a payment closes it, a reopen brings it back).
            .motion(.easeOut(duration: 0.2), value: state.value?.canRecordPayment ?? true)
        }
        .refreshable { await load(force: true) }
        .task { await load() }
        .disabled(busy)
        .navigationDestination(item: $openTemplate) { id in RecurringPurchaseDetailView(recurringId: id) }
        .sheet(item: $sheet) { kind in
            if let invoice = state.value {
                switch kind {
                case .edit: PurchaseInvoiceFormView(existing: invoice) { updated in apply(updated) }
                case .payment: PurchasePaymentSheet(invoice: invoice) { updated in apply(updated) }
                case .bankLink: PurchaseBankLinkSheet(invoice: invoice) { updated in apply(updated) }
                case .markPaid: PurchaseMarkPaidSheet(invoice: invoice) { updated in apply(updated) }
                case .credit:
                    PurchaseCreditSheet(invoice: invoice) { updated in
                        apply(updated)
                        notice = PurchaseCreditForm.createdMessage
                    }
                case .makeRecurring:
                    RecurringPurchaseFormSheet(existing: nil, prefill: RecurringPurchaseForm(from: invoice)) { message in
                        notice = message
                        // The invoice now belongs to the template: show its tag.
                        Task { await load() }
                    }
                }
            }
        }
        .confirmSheet(presenting: $confirm) { kind in confirmRequest(kind) }
    }

    private func confirmRequest(_ kind: ConfirmKind) -> ConfirmRequest {
        let title = confirmTitle(kind)
        let message = confirmMessage(kind)
        switch kind {
        case .delete:
            return ConfirmRequest(title: title, message: message, confirmTitle: "Poista",
                                  onConfirm: { Task { await deleteInvoice() } })
        case .cancel:
            return ConfirmRequest(title: title, message: message, confirmTitle: "Mitätöi",
                                  onConfirm: { Task { await setStatus(PurchaseStatusChange(status: .cancelled)) } })
        case .reopen:
            return ConfirmRequest(title: title, message: message, confirmTitle: "Palauta avoimeksi", isDestructive: false,
                                  onConfirm: { Task { await setStatus(PurchaseStatusChange(status: .open)) } })
        case .markPaid:
            return ConfirmRequest(title: title, message: message, confirmTitle: "Merkitse maksetuksi", isDestructive: false,
                                  onConfirm: { Task { await setStatus(PurchaseStatusChange(status: .paid)) } })
        case .removePayment(let payment):
            return ConfirmRequest(title: title, message: message, confirmTitle: "Poista maksu",
                                  onConfirm: { Task { await removePayment(payment) } })
        case .unlinkPayment(let payment):
            return ConfirmRequest(title: title, message: message, confirmTitle: "Irrota",
                                  onConfirm: { Task { await removePayment(payment) } })
        }
    }

    // MARK: Sections

    private func header(_ invoice: PurchaseInvoice) -> some View {
        VStack(spacing: 6) {
            MoneyText(amount: invoice.gross).scaledFont(size: 36, weight: .bold, design: .rounded, relativeTo: .largeTitle).moneyHero()
            Text(invoice.supplierName).font(.headline).foregroundStyle(Theme.ink)
            HStack(spacing: 6) {
                PurchaseStatusBadge(status: invoice.displayStatus, tag: invoice.creditTag)
                if let recurringPurchaseId {
                    Button { openTemplate = recurringPurchaseId } label: {
                        RecurringBadge(chevron: true)
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Toistuva ostolasku")
                    .accessibilityHint("Avaa toistuva ostolasku")
                }
            }
            if invoice.open > 0 && invoice.paid > 0 && invoice.credited == 0 {
                Text("Avoinna \(Money.format(invoice.open))").font(.caption).foregroundStyle(Theme.ink2)
            }
            if invoice.credited > 0 && invoice.displayStatus != .credited && !invoice.isCreditNote {
                Text("Avoinna \(Money.format(invoice.open)), hyvitetty \(Money.format(invoice.credited))")
                    .font(.caption).foregroundStyle(Theme.ink2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func details(_ invoice: PurchaseInvoice) -> some View {
        Section {
            LabeledContent("Laskun päivä", value: APIDate.displayDay(invoice.issueDate))
            // A credit note is not payable: its due date is just its own date.
            if !invoice.isCreditNote {
                LabeledContent("Eräpäivä", value: APIDate.displayDay(invoice.dueDate))
            }
            if let number = invoice.invoiceNumber, !number.isEmpty {
                LabeledContent("Laskun numero", value: number)
            }
            if let reference = invoice.reference, !reference.isEmpty {
                LabeledContent("Viite", value: reference)
                    .contextMenu {
                        Button { UIPasteboard.general.string = reference } label: {
                            Label("Kopioi viitenumero", systemImage: "doc.on.doc")
                        }
                    }
            }
            if let businessId = invoice.supplierBusinessId, !businessId.isEmpty {
                LabeledContent("Y-tunnus", value: businessId)
            }
            if let iban = invoice.supplierIban, !iban.isEmpty {
                LabeledContent("IBAN", value: iban)
            }
            if let category = invoice.category, !category.isEmpty {
                LabeledContent("Kategoria", value: ReceiptCategory.label(for: category))
            }
        }
        Section {
            LabeledContent("Veroton") { MoneyText(amount: invoice.net) }
            LabeledContent("ALV") { MoneyText(amount: invoice.vat) }
            LabeledContent("Yhteensä") { MoneyText(amount: invoice.gross).fontWeight(.semibold) }
            if !invoice.payments.isEmpty {
                LabeledContent("Maksettu") { MoneyText(amount: invoice.paid) }
            }
            if invoice.credited > 0 {
                LabeledContent("Hyvitetty") { MoneyText(amount: invoice.credited) }
            }
            if invoice.status == .open {
                LabeledContent("Avoinna") { MoneyText(amount: invoice.open).fontWeight(.semibold) }
            }
        } footer: {
            if invoice.status != .cancelled && invoice.vat > 0 {
                Text(invoice.receiptId != nil
                     ? "Kuitti on liitetty: ALV lasketaan kuitin kautta, kun kuitti on hyväksytty ja siinä on ALV-erittely."
                     : "ALV on mukana ALV-ilmoituksen vähennettävässä verossa.")
            }
        }
    }

    @ViewBuilder
    private func receiptSection(_ invoice: PurchaseInvoice) -> some View {
        if invoice.status != .cancelled, let links {
            if let linked = links.linked {
                Section("Liitetty kuitti") {
                    NavigationLink(value: Route.receipt(linked.id)) {
                        Label(linked.text, systemImage: "doc.text.image")
                    }
                    Button("Poista liitos", role: .destructive) { Task { await setReceipt(nil) } }
                }
            } else if !links.candidates.isEmpty {
                Section {
                    ForEach(links.candidates) { receipt in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(receipt.text).font(.subheadline).lineLimit(2)
                                if receipt.sameAmount {
                                    Text("Sama summa").font(.caption).foregroundStyle(Theme.success)
                                }
                            }
                            Spacer()
                            Button("Liitä kuitti") { Task { await setReceipt(receipt.id) } }
                                .buttonStyle(.bordered)
                                .tint(Theme.accent)
                                .accessibilityLabel("Liitä kuitti \(receipt.text)")
                        }
                    }
                } header: {
                    Text("Kuitti")
                } footer: {
                    Text("Onko tämä osto jo kuittina? Liitä kuitti, niin ALV ei lasketa kahdesti.")
                }
            }
        }
    }

    @ViewBuilder
    private func paymentsSection(_ invoice: PurchaseInvoice) -> some View {
        Section {
            if invoice.payments.isEmpty {
                Text("Ei maksuja.").foregroundStyle(Theme.ink2)
            }
            ForEach(invoice.payments) { payment in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(APIDate.displayDay(payment.paidDate))
                        let detail = PurchaseBankLinkText.paymentDetail(payment)
                        if !detail.isEmpty {
                            Text(detail).font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    Spacer()
                    MoneyText(amount: payment.amount)
                    if payment.isLinkedToBank {
                        Button("Irrota") { confirm = .unlinkPayment(payment) }
                            .buttonStyle(.borderless)
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                            .padding(.leading, 8)
                            .accessibilityLabel("Irrota pankkitapahtuma \(Money.format(payment.amount))")
                    }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        confirm = payment.isLinkedToBank ? .unlinkPayment(payment) : .removePayment(payment)
                    } label: {
                        Label(payment.isLinkedToBank ? "Irrota" : "Poista maksu", systemImage: payment.isLinkedToBank ? "link" : "trash")
                    }
                }
            }
        } header: {
            Text("Maksut")
        } footer: {
            if !invoice.payments.isEmpty {
                Text("Pyyhkäise maksua vasemmalle poistaaksesi sen. Irrotettu pankkitapahtuma vapautuu kohdistettavaksi uudelleen.")
            } else if invoice.canRecordPayment {
                Text("Maksoitko laskun pankista? Kohdista pankkitapahtuma, niin maksu kirjautuu pankin päivällä ja summalla.")
            }
        }
    }

    /// An open bill's one next step, above the tab bar (X165): linking the bank row books the
    /// bank's date and amount. Kirjaa maksu and the rest stay in Toiminnot.
    private var primaryBar: some View {
        Button { sheet = .bankLink } label: {
            Text("Kohdista pankkiin").font(.headline).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.primary)
        .accessibilityIdentifier("ostolasku-primary")
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        // Canvas from the bar down to the screen's edge: rows scrolling under the bar do not show
        // through around the button or behind the floating tab bar (X065).
        .background(Theme.canvas, ignoresSafeAreaEdges: .bottom)
        .transition(.opacity)
    }

    private func actions(_ invoice: PurchaseInvoice) -> some View {
        Menu {
            // A credit note's amounts are locked on the server; it is only deleted.
            if !invoice.isCreditNote {
                Button { sheet = .edit } label: { Label("Muokkaa", systemImage: "pencil") }
            }
            if invoice.canCredit {
                Button { sheet = .credit } label: { Label("Hyvitä", systemImage: "arrow.uturn.backward.circle") }
            }
            if invoice.canRecordPayment {
                Button { sheet = .bankLink } label: { Label("Kohdista pankkiin", systemImage: "building.columns") }
                Button { sheet = .payment } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
            }
            if invoice.canMarkPaid {
                Button {
                    if invoice.markPaidNeedsReason { sheet = .markPaid } else { confirm = .markPaid }
                } label: {
                    Label("Merkitse maksetuksi", systemImage: "checkmark.circle")
                }
            }
            if let reference = invoice.reference, !reference.isEmpty {
                Button { UIPasteboard.general.string = reference } label: {
                    Label("Kopioi viitenumero", systemImage: "doc.on.doc")
                }
            }
            if let recurringPurchaseId {
                Button { openTemplate = recurringPurchaseId } label: { Label("Avaa toistuva ostolasku", systemImage: "repeat") }
            } else if invoice.status != .cancelled && !invoice.isCreditNote {
                Button { sheet = .makeRecurring } label: { Label("Tee toistuvaksi", systemImage: "repeat") }
            }
            if invoice.canReopen {
                Button { confirm = .reopen } label: { Label("Palauta avoimeksi", systemImage: "arrow.uturn.backward") }
            }
            if invoice.canCancel {
                Button(role: .destructive) { confirm = .cancel } label: { Label("Mitätöi", systemImage: "xmark.circle") }
            }
            if invoice.canDelete {
                Button(role: .destructive) { confirm = .delete } label: { Label(invoice.isCreditNote ? "Poista hyvityslasku" : "Poista ostolasku", systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Toiminnot")
    }

    private func confirmTitle(_ kind: ConfirmKind) -> String {
        switch kind {
        case .delete: state.value?.isCreditNote == true ? "Poistetaanko hyvityslasku?" : "Poistetaanko ostolasku?"
        case .cancel: "Mitätöidäänkö ostolasku?"
        case .reopen: "Palautetaanko ostolasku avoimeksi?"
        case .markPaid: "Merkitäänkö ostolasku maksetuksi?"
        case .removePayment: "Poistetaanko maksu?"
        case .unlinkPayment: "Irrotetaanko pankkitapahtuma?"
        }
    }

    private func confirmMessage(_ kind: ConfirmKind) -> String {
        guard let invoice = state.value else { return "" }
        switch kind {
        case .delete: return "\(invoice.supplierName) · \(Money.format(invoice.gross))"
        case .cancel: return "Mitätöity lasku ei ole enää avoinna eikä mukana ALV-laskelmassa."
        case .reopen: return "Lasku palaa odottamaan maksua."
        case .markPaid: return "Kirjatut maksut kattavat laskun summan."
        case .removePayment(let payment):
            return "\(Money.format(payment.amount)) poistetaan ostolaskulta. Ostolasku palaa avoimeksi, jos se ei ole sen jälkeen kokonaan maksettu."
        case .unlinkPayment(let payment):
            return "Maksu \(Money.format(payment.amount)) poistetaan ostolaskulta ja pankkitapahtuma vapautuu kohdistettavaksi uudelleen. Ostolasku palaa avoimeksi, jos se ei ole sen jälkeen kokonaan maksettu."
        }
    }

    // MARK: Actions

    private func apply(_ invoice: PurchaseInvoice) {
        state.succeed(invoice)
        Task { await loadLinks() }
    }

    private func load() async { await load(force: false) }

    /// The cached ostolasku at once (opened before, nothing changed since), then the server's
    /// when stale; `force` (pull-to-refresh) always asks.
    private func load(force: Bool) async {
        let timing = ScreenTiming("Ostolasku")
        let path = "/api/purchase-invoices/\(purchaseInvoiceId)"
        if state.value == nil, let cached: PurchaseInvoiceTaggedResponse = await app.cachedValue(path) {
            state.succeed(cached.invoice)
            recurringPurchaseId = cached.recurringPurchaseId
            timing.painted(fromCache: true)
        }
        state.begin()
        do {
            let response: PurchaseInvoiceTaggedResponse = try await app.cachedGet(path, force: force)
            state.succeed(response.invoice)
            recurringPurchaseId = response.recurringPurchaseId
            timing.dataReady()
        } catch is CancellationError {
            return
        } catch {
            state.fail(error)
            return
        }
        await loadLinks()
    }

    /// The receipt link is a convenience: the screen works without it.
    private func loadLinks() async {
        let result: PurchaseReceiptLinks? = try? await app.api.get("/api/purchase-invoices/\(purchaseInvoiceId)/receipts")
        links = result
    }

    private func run(_ work: () async throws -> Void) async {
        // A second tap while the first request runs must not send it again.
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await work()
            Haptics.success()
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func setStatus(_ change: PurchaseStatusChange) async {
        await run {
            let response: PurchaseInvoiceResponse = try await app.api.send("PATCH", "/api/purchase-invoices/\(purchaseInvoiceId)", body: change)
            state.succeed(response.invoice)
        }
    }

    private func setReceipt(_ receiptId: String?) async {
        await run {
            let response: PurchaseInvoiceResponse = try await app.api.send("PATCH", "/api/purchase-invoices/\(purchaseInvoiceId)", body: PurchaseReceiptLink(receiptId: receiptId))
            state.succeed(response.invoice)
        }
        await loadLinks()
    }

    private func removePayment(_ payment: PurchaseInvoice.Payment) async {
        await run {
            let response: PurchaseInvoiceResponse = try await app.api.send("DELETE", "/api/purchase-invoices/\(purchaseInvoiceId)/payments", query: ["paymentId": payment.id], body: Optional<EmptyBody>.none)
            state.succeed(response.invoice)
        }
    }

    private func deleteInvoice() async {
        let api = app.api, id = purchaseInvoiceId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/purchase-invoices/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }
}
