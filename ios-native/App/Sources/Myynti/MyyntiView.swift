import SwiftUI
import LashKirjaCore

struct MyyntiView: View {
    @Environment(AppModel.self) private var app
    /// Asiakkaat, Toistuvat laskut and a created invoice open on the stack's path (M024).
    @Environment(\.openRoute) private var openRoute
    /// Opens the new-invoice form once on appear (the assistant's "/laskut/uusi" link).
    var openNewInvoice = false
    /// A report link's period or customer (`/laskut?month=…`); empty for the Myynti tab itself.
    var scope = InvoiceScope()
    @State private var state = ScreenLoad<InvoiceList>()
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var counts: [String: Int]?
    @State private var filter: SalesFilter
    @State private var search = ""
    /// The search as sent to the server: settles 250 ms after the last keystroke (as on the web).
    @State private var query = ""
    /// A days-late figure narrows the late invoices to its bucket (on top of the Myöhässä chip).
    @State private var lateBucket: AgingBucket?
    /// The new-invoice sheet, one request per tap (`SheetRequest`).
    @State private var newInvoice: SheetRequest?
    @State private var showMatch = false
    @State private var notice: String?
    @State private var openedNew = false
    /// A just-created invoice, opened when the form's sheet has closed.
    @State private var createdId: String?
    @State private var limit = ShowMore()
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var tileIconWidth: CGFloat = 24

    /// A link opens exactly the list it names: its status chip, or Kaikki when it names none.
    /// `preview` (the app's `salesPreview` for the same scope and chip) is on screen in the first
    /// frame: painted from `load` instead, after an await on the cache, the tab showed a spinner and
    /// then the list (motion audit offline-tab-myynti), and a tap could land on that late swap.
    init(openNewInvoice: Bool = false, scope: InvoiceScope = InvoiceScope(), status: SalesFilter = .all,
         preview: SalesPreview? = nil) {
        self.openNewInvoice = openNewInvoice
        self.scope = scope
        _filter = State(initialValue: status)
        guard let preview else { return }
        var shown = ScreenLoad<InvoiceList>()
        shown.succeed(preview.list)
        _state = State(initialValue: shown)
        _counts = State(initialValue: preview.counts)
    }

    var body: some View {
        List {
            if let list = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    ReceivablesCard(aging: list.aging, filter: filter, lateBucket: lateBucket) { segment in
                        filter = filter == segment ? .all : segment
                        lateBucket = nil
                        Haptics.selection()
                    } onBucket: { bucket in
                        lateBucket = lateBucket == bucket ? nil : bucket
                        if lateBucket != nil { filter = .overdue }
                        Haptics.selection()
                    }
                    .listRowBackground(Theme.surface)
                }
                Section {
                    // A drilled list is about its rows; the registers stay on the Myynti tab.
                    // The section runs to the screen's edges for the chips: these rows keep the cards' margin.
                    if let title = scope.title {
                        Label(title, systemImage: "line.3.horizontal.decrease.circle")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: 4 + ChipRow.inset, bottom: 0, trailing: ChipRow.inset))
                            .listRowSeparator(.hidden)
                    } else {
                        shortcuts
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: ChipRow.inset, bottom: 0, trailing: ChipRow.inset))
                            .listRowSeparator(.hidden)
                    }
                    chips
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))
                        .listRowSeparator(.hidden)
                }
                .chipRowSection()
                let rows = visible(list.invoices)
                Section {
                    if rows.isEmpty {
                        Text(search.isEmpty ? "Ei laskuja tässä näkymässä." : "Ei osumia.")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(rows.prefix(limit.visible(rows.count))) { invoice in
                        NavigationLink(value: Route.invoice(invoice.id)) { InvoiceRow(invoice: invoice) }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                } header: {
                    HStack {
                        if !rows.isEmpty { Text("\(rows.count) laskua") }
                        Spacer()
                        if let lateBucket {
                            Button { self.lateBucket = nil } label: {
                                Label("\(lateBucket.label) myöhässä", systemImage: "xmark.circle.fill")
                            }
                            .buttonStyle(.borderless)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.danger)
                            .accessibilityHint("Näytä kaikki myöhässä olevat")
                        }
                    }
                } footer: {
                    if let note = SalesListQuery.limitNote(rowCount: list.invoices.count) { Text(note) }
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: InvoiceList) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .noticeToast($notice)
        .searchable(text: $search, prompt: "Hae asiakasta tai numeroa")
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(key: listKey, version: app.refreshEverything())
            await load()
        }
        .navigationTitle(scope.isEmpty ? "Myynti" : "Laskut")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                // The rest in Toiminnot (M035): the bank's payments were a full-width card under the list.
                if scope.isEmpty {
                    Menu {
                        Button { showMatch = true } label: {
                            Label("Hae asiakkaiden maksut pankista", systemImage: "building.columns")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Toiminnot")
                }
                // The one primary, in words: as "+" it was an icon of the same weight as those beside it.
                Button("Uusi lasku") { Perf.beginOpen("laskuUusi"); newInvoice = SheetRequest() }
            }
        }
        .sheet(item: $newInvoice, onDismiss: openCreated) { _ in
            InvoiceFormView(existing: nil, preview: app.invoiceFormPreview(), onCreated: { id in createdId = id })
        }
        .sheet(isPresented: $showMatch) {
            BankMatchSheet { message in notice = message }
        }
        .onAppear {
            guard openNewInvoice, !openedNew else { return }
            openedNew = true
            newInvoice = SheetRequest()
        }
        .perfReady("myynti", state.value != nil)
        .task(id: "\(app.dataVersion)|\(listKey)") {
            guard state.value == nil || gate.isDue(key: listKey, version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion, key = listKey
            await load()
            if !Task.isCancelled { gate.mark(key: key, version: version) }
        }
        .task(id: search) {
            let text = search.trimmingCharacters(in: .whitespaces)
            // Cleared at once; typed text waits for a pause, one request per pause.
            if !text.isEmpty { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard !Task.isCancelled else { return }
            query = text
        }
        .motion(.snappy, value: filter)
        .motion(.snappy, value: lateBucket)
        // Another chip or search shows a different list: it opens on its first rows again.
        .onChange(of: filter) { _, new in
            limit.reset()
            if new != .overdue { lateBucket = nil }
        }
        .onChange(of: search) { _, _ in limit.reset() }
        .onChange(of: lateBucket) { _, _ in limit.reset() }
    }

    private func openCreated() {
        guard let id = createdId else { return }
        createdId = nil
        openRoute(.invoice(id))
    }

    /// Two tiles as wide as the cards around them, so they read as places to go, not filters.
    /// Stacked at accessibility sizes: side by side the titles were cut to 'Asi a…' (U067).
    private var shortcuts: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
        return layout {
            shortcutTile("Asiakkaat", symbol: "person.2", route: .customers)
            shortcutTile("Toistuvat laskut", symbol: "repeat", route: .recurringInvoices)
        }
        // Side by side, both as tall as the taller: 'Toistuvat laskut' wraps on a 402 pt screen,
        // and its tile stood taller than the other, the tops apart (U049).
        .fixedSize(horizontal: false, vertical: true)
    }

    /// A button that pushes its route, not a NavigationLink: two links in one List row make the
    /// row one tap target (as InvoiceDetailView's customer). The route goes through
    /// `appDestinations`, so the screen has the inline title of every pushed screen (M033).
    private func shortcutTile(_ title: String, symbol: String, route: Route) -> some View {
        Button { openRoute(route) } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    // Grows with the glyph: at a fixed 24 pt the large symbol ran into the title (U067).
                    .frame(width: tileIconWidth)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, minHeight: 60, maxHeight: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(.pressable)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SalesFilter.chips(counts)) { chip in
                    let selected = chip.filter == filter
                    Button {
                        filter = chip.filter
                        Haptics.selection()
                    } label: {
                        HStack(spacing: 4) {
                            Text(chip.filter.title)
                            if let count = chip.count {
                                Text("\(count)").monospacedDigit().foregroundStyle(selected ? Theme.onInk.opacity(0.8) : Theme.ink2)
                            }
                        }
                        .chipFont(selected: selected)
                        .foregroundStyle(selected ? Theme.onInk : Theme.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(selected ? Theme.ink : Theme.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: selected ? 0 : 1))
                    }
                    .buttonStyle(.pressable)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, ChipRow.inset)
        }
        .accessibilityIdentifier("sales-chips")
        .chipRowScroll()
        // A chip whose status vanished (credited after a refresh) falls back to "Kaikki".
        .onChange(of: counts) { _, _ in
            if !SalesFilter.chips(counts).contains(where: { $0.filter == filter }) { filter = .all }
        }
    }

    /// What the list asks the server for besides the scope: the chip and the settled search.
    private var listKey: String { "\(filter.rawValue)|\(query)" }

    /// The server already filtered by status and search; the chip's own rule still applies while a
    /// new chip's rows are on their way (and keeps "Odottaa maksua" free of late ones, as on the web).
    private func visible(_ invoices: [Invoice]) -> [Invoice] {
        let today = APIDate.dayString(Date())
        return invoices.filter { invoice in
            !app.removedIds.contains(invoice.id) && filter.matches(invoice)
                && (lateBucket == nil || AgingBucket.of(dueDate: invoice.dueDate, today: today) == lateBucket)
        }
    }

    /// Through the app's cache: the last list for this scope and chip at once, then the server's
    /// when it is stale (pull-to-refresh bumps the version, so it always asks).
    private func load() async {
        let timing = ScreenTiming("Myynti")
        let listQuery = SalesListQuery.query(scope: scope, filter: filter, search: query)
        if state.value != nil { timing.painted(fromCache: true) }
        if state.value == nil, let cached: InvoiceList = await app.cachedValue("/api/invoices", query: listQuery) {
            state.succeed(cached)
            if let cachedCounts: InvoiceCounts = await app.cachedValue("/api/invoices/counts", query: scope.query) { counts = cachedCounts.counts }
            timing.painted(fromCache: true)
        }
        state.begin()
        // The list and the chip counts are independent: one round trip instead of two.
        async let fresh = loadCounts()
        do {
            let list: InvoiceList = try await app.cachedGet("/api/invoices", query: listQuery, persist: listQuery.isEmpty)
            state.succeed(list)
            app.rememberPainted(list, "/api/invoices", query: listQuery)
            timing.dataReady()
            warmDetails(list.invoices)
            app.indexForSpotlight(list.invoices.compactMap {
                SpotlightEntry.invoice(id: $0.id, number: $0.number, customerName: $0.customer.name,
                                       gross: $0.gross, statusLabel: $0.displayStatus.label)
            })
        }
        catch is CancellationError {}
        catch { state.fail(error) }
        if let fresh = await fresh {
            counts = fresh
            app.rememberPainted(fresh, "/api/invoices/counts", query: scope.query)
        }
    }

    /// The first rows' details (and an overdue one's reminder) into the cache and the app's
    /// previews, so opening one paints the invoice at once instead of a spinner the detail then replaces.
    private func warmDetails(_ invoices: [Invoice]) {
        let app = self.app
        let first = Array(visible(invoices).prefix(5))
        Task {
            for invoice in first {
                let detail: InvoiceDetailResponse? = try? await app.cachedGet("/api/invoices/\(invoice.id)")
                var reminder: ReminderPreviewResponse?
                if invoice.displayStatus == .overdue {
                    reminder = try? await app.cachedGet("/api/invoices/\(invoice.id)/reminders")
                }
                if let detail { app.rememberInvoiceDetail(detail, reminder: reminder?.reminder) }
            }
        }
    }

    /// Per-status counts for the chips; counted by the server, so the list's row cap cannot skew them.
    private func loadCounts() async -> [String: Int]? {
        do {
            // Scoped like the list (period, customer), never by status.
            let response: InvoiceCounts = try await app.cachedGet("/api/invoices/counts", query: scope.query)
            return response.counts
        } catch {
            return nil
        }
    }
}

/// What Myynti opens on before its own load: the list and chip counts it last painted.
struct SalesPreview {
    let list: InvoiceList
    let counts: [String: Int]?
}

extension AppModel {
    /// The list (and counts) last painted for this scope and chip with no search; nil when there is none.
    func salesPreview(scope: InvoiceScope = InvoiceScope(), filter: SalesFilter = .all) -> SalesPreview? {
        let query = SalesListQuery.query(scope: scope, filter: filter, search: "")
        guard let list: InvoiceList = lastPainted("/api/invoices", query: query) else { return nil }
        let counts: [String: Int]? = lastPainted("/api/invoices/counts", query: scope.query)
        return SalesPreview(list: list, counts: counts)
    }
}

/// One tap that opens a sheet: a new identity each time, so every tap changes what the sheet is bound
/// to. With a Bool, a presentation SwiftUI did not carry out (the tap landed while the screen was still
/// settling) left it true, and each later tap set true again: no change, so no sheet (P1 01's FAIL-NAV).
struct SheetRequest: Identifiable, Equatable {
    let id = UUID()
}

/// "Saatavat, avoinna": the paid / waiting / late bar (web `receivablesSegments`), each part opening
/// its chip, and under "Erittely" the late money by days late, each figure narrowing the late list.
private struct ReceivablesCard: View {
    let aging: InvoiceList.Aging
    let filter: SalesFilter
    let lateBucket: AgingBucket?
    let onSegment: (SalesFilter) -> Void
    let onBucket: (AgingBucket) -> Void
    @State private var open = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let segments = aging.segments
        let buckets = aging.lateBuckets
        // Erittely under the total at accessibility sizes: beside it the total left its '€' on a
        // line of its own and the button broke to 'Erit-/tely' (U066).
        let header = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .top))
        VStack(alignment: .leading, spacing: 10) {
            header {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saatavat, avoinna").font(.caption).foregroundStyle(Theme.ink2)
                    MoneyText(amount: aging.totalOpen).font(.title2.weight(.semibold))
                        .accessibilityIdentifier("receivables-total")
                }
                if !typeSize.isAccessibilitySize { Spacer() }
                if !buckets.isEmpty {
                    Button { withMotion(.snappy) { open.toggle() } } label: {
                        HStack(spacing: 4) {
                            Text("Erittely")
                            Image(systemName: "chevron.down").rotationEffect(.degrees(open ? 180 : 0)).accessibilityHidden(true)
                        }
                        .font(.caption)
                        .foregroundStyle(Theme.ink2)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(open ? "Piilota erittely" : "Näytä erittely päivien mukaan")
                }
            }
            bar(segments)
            legend(segments)
            if open && !buckets.isEmpty {
                Divider()
                let figures = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 4)) : AnyLayout(HStackLayout(spacing: 0))
                figures {
                    ForEach(buckets) { bucket in bucketButton(bucket) }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func color(_ tone: ReceivablesSegment.Tone) -> Color {
        switch tone {
        case .success: Theme.success
        case .neutral: Theme.ink2.opacity(0.45)
        case .danger: Theme.danger
        }
    }

    /// A segment other than the chosen chip fades, so the bar shows what the list below is.
    private func dimmed(_ segment: ReceivablesSegment) -> Bool {
        filter != .all && filter != segment.filter
    }

    @ViewBuilder
    private func bar(_ segments: [ReceivablesSegment]) -> some View {
        let total = segments.reduce(Decimal(0)) { $0 + max(0, $1.amount) }
        if total <= 0 {
            Text("Ei avoimia laskuja.").font(.caption).foregroundStyle(Theme.ink2)
        } else {
            GeometryReader { geo in
                let shown = segments.filter { $0.amount > 0 }
                let gaps = CGFloat(max(0, shown.count - 1)) * 2
                HStack(spacing: 2) {
                    ForEach(shown) { segment in
                        let share = CGFloat(NSDecimalNumber(decimal: segment.amount / total).doubleValue)
                        Button { onSegment(segment.filter) } label: {
                            Rectangle().fill(color(segment.tone)).opacity(dimmed(segment) ? 0.3 : 1)
                        }
                        .buttonStyle(.pressable)
                        .frame(width: max(4, (geo.size.width - gaps) * share))
                        .accessibilityLabel("\(segment.label) \(Money.format(segment.amount))")
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 10)
        }
    }

    /// One part under another at accessibility sizes: in three columns the labels were cut to
    /// 'Maks…' and the amounts broke after the comma (U065).
    private func legend(_ segments: [ReceivablesSegment]) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
        return layout {
            ForEach(segments) { segment in
                Button { onSegment(segment.filter) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Circle().fill(color(segment.tone)).frame(width: 7, height: 7)
                            Text(segment.label).lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .font(.caption2)
                        .foregroundStyle(Theme.ink2)
                        MoneyText(amount: segment.amount)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(segment.tone == .danger && segment.amount > 0 ? Theme.danger : Theme.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(dimmed(segment) ? 0.5 : 1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityAddTraits(filter == segment.filter ? .isSelected : [])
                .accessibilityHint(filter == segment.filter ? "Näytä kaikki laskut" : "Näytä nämä laskut")
            }
        }
    }

    private func bucketButton(_ bucket: ReceivablesLateBucket) -> some View {
        let selected = lateBucket == bucket.bucket
        return Button { onBucket(bucket.bucket) } label: {
            VStack(spacing: 2) {
                Text(bucket.label).font(.caption2).foregroundStyle(selected ? Theme.danger : Theme.ink2)
                MoneyText(amount: bucket.amount).font(.caption.weight(.medium)).foregroundStyle(Theme.ink)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(selected ? Theme.danger.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(bucket.count == 0 && !selected)
        .accessibilityLabel("\(bucket.label) myöhässä, \(bucket.count) laskua, \(Money.format(bucket.amount))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Reference-number reconciliation: first what a run would book, then the run (`/api/invoices/match`).
struct BankMatchSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onDone: (String) -> Void
    @State private var state = ScreenLoad<BankMatchPreview>()
    @State private var busy = false
    @State private var failure: String?
    @State private var limit = ShowMore()

    var body: some View {
        NavigationStack {
            List {
                if let preview = state.value {
                    if let banner = state.banner {
                        Section { RefreshFailureBanner(failure: banner, retry: load) }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                    Section {
                        Text(preview.headline)
                        ForEach(preview.rows.prefix(limit.visible(preview.rows.count))) { row in
                            HStack {
                                Text("Lasku \(row.invoiceNumber), \(row.customerName)").lineLimit(2)
                                Spacer()
                                MoneyText(amount: row.amount)
                            }
                        }
                        ShowMoreButton(limit: $limit, total: preview.rows.count)
                    } footer: {
                        VStack(alignment: .leading, spacing: 6) {
                            if let locked = preview.lockedText { Text(locked) }
                            if let suggestions = preview.suggestionText { Text(suggestions) }
                        }
                    }
                    if !preview.rows.isEmpty {
                        Section {
                            Button { Task { await run() } } label: {
                                HStack {
                                    Spacer()
                                    if busy { ProgressView() } else { Text("Kirjaa maksut") }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.primary)
                            .disabled(busy)
                            .listRowBackground(Color.clear)
                        }
                    }
                } else {
                    ScreenStateView(state: state, retry: load) { (_: BankMatchPreview) in EmptyView() }
                        .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .navigationTitle("Maksut pankista")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button((state.value?.rows.isEmpty ?? true) ? "Sulje" : "Peruuta") { dismiss() }
                }
            }
            .task { await load() }
            .interactiveDismissDisabled(busy)
        }
    }

    private func load() async {
        state.begin()
        do { state.succeed(try await app.api.get("/api/invoices/match")) }
        catch is CancellationError {}
        catch { state.fail(error) }
    }

    private func run() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let result: BankMatchResult = try await app.api.send("POST", "/api/invoices/match", body: EmptyBody())
            Haptics.success()
            onDone(result.message)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

struct InvoiceRow: View {
    let invoice: Invoice
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // At accessibility sizes the amount and the badge go under the name: beside it the name,
        // the amount and the badge each broke inside a word (U068).
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
        layout {
            VStack(alignment: .leading, spacing: 3) {
                Text(invoice.customer.name).font(.body).foregroundStyle(Theme.ink).lineLimitUnlessLarge()
                // The badge beside it says "Myöhässä"; the line no longer says it too (M100).
                Text(invoice.rowSecondary).font(.caption).foregroundStyle(Theme.ink2)
            }
            if !typeSize.isAccessibilitySize { Spacer() }
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 3) {
                MoneyText(amount: invoice.gross).font(.subheadline.weight(.semibold))
                StatusBadge(status: invoice.displayStatus, partlyCredited: invoice.isPartlyCredited)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusBadge: View {
    let status: InvoiceStatus
    /// A part credit leaves the status as it was; the badge says "Osittain hyvitetty" instead.
    var partlyCredited = false
    /// Words of its own in the status's colours: the invoice's "Myöhässä 15 päivää".
    var text: String? = nil
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        Text(text ?? (partlyCredited ? InvoiceCreditDisplay.partlyCreditedLabel : status.label))
            .font(.caption2.weight(.semibold))
            // One line, never broken inside a word ('Luon-/nos', 'Myöhäs/sä', U068 U069). At the
            // largest sizes "Myöhässä 15 päivää" is wider than the card: it shrinks on its line
            // rather than run past the edge.
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
            // Its whole width beside other text; at accessibility sizes it has a line of its own.
            .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
    }
    private var color: Color {
        if partlyCredited { return Theme.warning }
        switch status {
        case .draft: return Theme.ink2
        case .sent: return Theme.warning
        case .overdue: return Theme.danger
        case .paid, .credited: return Theme.success
        }
    }
}
