import SwiftUI
import Charts
import LashKirjaCore

struct RaportitView: View {
    @Environment(AppModel.self) private var app
    @State private var year = RaportitView.currentYear
    @State private var state = ScreenLoad<ProfitLoss>()
    @State private var export: ExportKind?
    /// The accountant package's period: "YYYY-MM", "YYYY-Qn" or "YYYY" (SALES-21).
    @State private var packageChoice = MonthKey.shift(MonthKey.current(), by: -1)
    @State private var showPackage = false
    /// Tulot or Menot by category: one list at a time instead of two stacked (nil = the default).
    @State private var categoryChoice: ReportCategoryKind?
    @State private var categoryLimit = ShowMore()
    /// Clear room over Kirjanpitopaketti, under Luokittain's rows: what a swap to the shorter list gave
    /// up at the end of the page, held until it is off screen below (F012, `ListEndHold`).
    @State private var categoryHold: CGFloat = 0
    /// Where Luokittain's rows sit and how far the page still scrolls, for a swap to read.
    @State private var categoryFrames = CategoryFrames()
    /// The month picked on the chart; nil = the latest month with figures.
    @State private var selectedMonth: String?
    /// Reloads after a change elsewhere (`dataVersion`) as well as on another year.
    @State private var gate = ReloadGate()
    /// Asks each receipts drill's list once while the screen lives, not again on every reload (row 23).
    @State private var drillWarmer = ReportDrillWarmer()
    /// The previous year's report has been asked once, after this year's painted (`warmPreviousYear`).
    @State private var previousWarmed = false

    /// `preview` (the app's last painted report of this year) is on screen in the first frame:
    /// painted from `load` instead, after an await on the cache, the tab showed a spinner and then
    /// the figures (motion audit raportit-tab, every CI walk of 2026-10-17).
    init(preview: ProfitLoss? = nil) {
        guard let preview else { return }
        var shown = ScreenLoad<ProfitLoss>()
        shown.succeed(preview)
        _state = State(initialValue: shown)
    }

    static var currentYear: Int { Int(MonthKey.current().prefix(4)) ?? 2026 }

    static let path = "/api/reports/profit-loss"

    /// The query of a year's report, as `load` and the launch prefetch ask it.
    static func query(year: Int) -> [String: String] { ["from": "\(year)-01", "to": "\(year)-12"] }

    struct ExportKind: Identifiable { let type: String; let title: String; var id: String { type } }
    private let exports = [
        ExportKind(type: "profit-loss", title: "Tuloslaskelma"),
        ExportKind(type: "receipts", title: "Kuitit"),
        ExportKind(type: "invoices", title: "Myyntilaskut"),
        ExportKind(type: "transactions", title: "Pankkitapahtumat"),
        ExportKind(type: "purchase-invoices", title: "Ostolaskut"),
        ExportKind(type: "customers", title: "Asiakkaat"),
    ]

    var body: some View {
        List {
            Section {
                HStack {
                    Button { setYear(year - 1) } label: { Image(systemName: "chevron.left").tapTarget() }
                        .accessibilityLabel("Edellinen vuosi")
                    Spacer()
                    Text(String(year)).font(.headline).monospacedDigit()
                        // Beside the year, over nothing: another year's figures hold the report's
                        // place until this year's arrive, so no spinner page stands in (M039).
                        .overlay(alignment: .trailing) {
                            if swapping {
                                ProgressView().controlSize(.small)
                                    .alignmentGuide(.trailing) { $0[.leading] - 8 }
                            }
                        }
                        .motion(.easeOut(duration: 0.2), value: swapping)
                    Spacer()
                    Button { setYear(year + 1) } label: { Image(systemName: "chevron.right").tapTarget() }
                        .accessibilityLabel("Seuraava vuosi")
                        .disabled(year >= Int(MonthKey.current().prefix(4)) ?? year)
                }
                .buttonStyle(.borderless)
            }
            if let report = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Group { reportSections(report) }
                    // Another year's figures while this year's are on their way: kept in place, greyed
                    // and inert, so nothing below moves until the new report swaps in (M039).
                    .redacted(reason: swapping ? RedactionReasons.placeholder : RedactionReasons())
                    .disabled(swapping)
            } else {
                ScreenStateView(state: state, retry: load) { (_: ProfitLoss) in EmptyView() }.listRowBackground(Color.clear)
            }
            Section {
                Picker("Kausi", selection: Binding(get: { packagePeriod }, set: { packageChoice = $0 })) {
                    ForEach(ReportPackage.options(year: year), id: \.key) { option in
                        Text(option.title).tag(option.key)
                    }
                }
                // The page's one visible action; the CSV exports wait in Toiminnot (X078).
                Button { showPackage = true } label: {
                    Label("Lataa zip", systemImage: "archivebox").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .listRowBackground(Color.clear)
            } header: {
                // Over the title, so the package stays put while the rows above it get shorter.
                Text("Kirjanpitopaketti")
                    .padding(.top, categoryHold)
                    .onAppear { categoryFrames.carrierShown = true }
                    .onDisappear {
                        categoryFrames.carrierShown = false
                        releaseCategoryHold()
                    }
            } footer: {
                Text("Lähetä kirjanpitäjälle kuun sulun jälkeen. Zip kuukaudelta, neljännekseltä tai koko vuodelta: tuloslaskelma, ALV, CSV, kohdistukset ja kuitit.")
            }
        }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            // At its top the page has nothing to clamp, however short it gets.
            guard geometry.contentOffset.y > 0.5 - geometry.contentInsets.top else { return .infinity }
            return geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height - geometry.contentOffset.y
        } action: { _, room in
            categoryFrames.room = room
            releaseCategoryHold()
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Raportit")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { actionsMenu }
        }
        .refreshable {
            // Pull-to-refresh asks every screen again; this one's own load stands for the bump.
            gate.mark(key: String(year), version: app.refreshEverything())
            // Not awaited, as on Koti: the spinner held for the whole load and then sprang back,
            // moving the figures again after they had come to rest (motion audit raportit-refresh,
            // w60 gate). The figures stay on screen while they refresh and update in place.
            Task { await load() }
        }
        .perfReady("raportit", state.value != nil)
        .task(id: "\(year)|\(app.dataVersion)") {
            let key = String(year)
            guard state.value == nil || gate.isDue(key: key, version: app.dataVersion) else { return }
            // The report on screen stays while the new one loads (another year's as a placeholder).
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: key, version: version) }
        }
        // Once the figures are on screen, the Kuitit lists they open go into the cache: a drill
        // paints its rows with the push, not grey rows the answer replaces after the push has
        // settled (motion audit raportit-drill-open). Keyed on the lists themselves, not on
        // `dataVersion`: a reload with the same figures asks nothing, other figures cancel the
        // warm of the old ones.
        .task(id: drillWarms) {
            guard !drillWarms.isEmpty else { return }
            await warmDrills(drillWarms)
        }
        .onChange(of: year) { _, _ in categoryLimit.reset() }
        .sheet(isPresented: $showPackage) {
            DocumentPreviewSheet(path: "/api/export/package", query: ["month": packagePeriod], fileName: "kirjanpito-\(packagePeriod).zip",
                                 shareTitle: "Jaa kirjanpitäjälle")
        }
        .sheet(item: $export) { kind in
            // Titled in words; the file keeps the server's name (tuloslaskelma-2026.csv), X084.
            DocumentPreviewSheet(path: "/api/export", query: ["type": kind.type, "year": String(year)], fileName: "\(kind.type)-\(year).csv",
                                 title: "\(kind.title) \(year)")
        }
    }

    /// The chosen period when it belongs to the year on screen, else that year's January (as on the web).
    private var packagePeriod: String {
        packageChoice.hasPrefix(String(year)) ? packageChoice : "\(year)-01"
    }

    /// Another year's figures are on screen: the year just changed and its own are on their way.
    private var swapping: Bool {
        guard let report = state.value else { return false }
        return Self.reportYear(report) != String(year)
    }

    /// The year a report is for ("2026"), as asked by `query(year:)`.
    private static func reportYear(_ report: ProfitLoss) -> String { String(report.from.prefix(4)) }

    /// Toiminnot: the year's six CSV exports, behind ⋯ so the page keeps one visible action,
    /// Lataa zip. Nine equal-weight rows took about 700 pt of the page (X078).
    private var actionsMenu: some View {
        Menu {
            Menu {
                ForEach(exports) { kind in
                    Button { export = kind } label: { Label(kind.title, systemImage: "square.and.arrow.up") }
                }
            } label: {
                Label("Vienti (CSV)", systemImage: "tablecells")
            }
        } label: {
            Image(systemName: "ellipsis.circle").tapTarget()
        }
        .accessibilityLabel("Toiminnot")
    }

    /// The month first (change 5): Kuukausittain right under the year, then the year's result and
    /// its categories. A year with nothing booked says so once instead (M048). Drawn for the
    /// report's own year, so another year's figures standing in keep their months and links.
    @ViewBuilder
    private func reportSections(_ report: ProfitLoss) -> some View {
        let yearKey = Self.reportYear(report)
        // What the figures may be missing; the list has no filter for either, so the rows open
        // the year's receipts (undated ones the whole list).
        let quality = ReportDrill.dataQuality(missingVat: report.total.missingVatCount, undated: report.undatedCount, year: yearKey)
        if report.hasFigures {
            monthSection(report.filledMonths(year: yearKey))
            Section("Tulos ilman ALV:ta") {
                drillFigure(ReportDrill.incomeTargets(report.total, key: yearKey)) {
                    LabeledContent("Tulot") { MoneyText(amount: report.total.incomeNet) }
                }
                drillFigure(ReportDrill.expenseTargets(report.total, key: yearKey)) {
                    LabeledContent("Menot") { MoneyText(amount: report.total.expenseNet) }
                }
                LabeledContent("Tulos") { MoneyText(amount: report.total.profitNet).fontWeight(.semibold) }
                qualityRows(quality)
            }
            categorySection(report.total)
        } else {
            Section {
                ContentUnavailableView("Ei kirjauksia vuodelta \(yearKey)", systemImage: "chart.bar")
            }
            .listRowBackground(Color.clear)
            if !quality.isEmpty {
                Section { qualityRows(quality) }
            }
        }
    }

    private func qualityRows(_ rows: [ReportDrill.QualityRow]) -> some View {
        ForEach(rows, id: \.self) { row in
            NavigationLink(value: Route.forDrill(row.drill)) {
                LabeledContent(row.title) {
                    Text("\(row.count)").monospacedDigit().foregroundStyle(Theme.warning)
                }
            }
        }
    }

    @ViewBuilder
    private func categorySection(_ total: ProfitLoss.Period) -> some View {
        let kinds = ReportCategoryKind.available(total)
        if let kind = ReportCategoryKind.resolve(categoryChoice, in: total) {
            let rows = kind.rows(total)
            if kinds.count > 1 {
                Section("Luokittain") {
                    Picker("Luokittain", selection: Binding(get: { kind }, set: { swapCategories(to: $0, from: kind, in: total) })) {
                        ForEach(kinds) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            Section {
                categories(Array(rows.prefix(categoryLimit.visible(rows.count))), kind: kind)
                // Measured only while it shows: a swap counts its row with the rows it takes away.
                if categoryLimit.buttonTitle(total: rows.count) != nil {
                    ShowMoreButton(limit: $categoryLimit, total: rows.count)
                        .onGeometryChange(for: ListEndHold.Frame.self) { Self.measured($0) } action: { categoryFrames.button = $0 }
                        .onDisappear { categoryFrames.button = nil }
                }
            } header: {
                // With the picker above, its label already names the list.
                if kinds.count == 1 { Text("\(kind.title) luokittain") }
            }
        }
    }

    /// Each category opens the receipts (or invoices) that make it up, for the year on screen.
    private func categories(_ rows: [ProfitLoss.Category], kind: ReportCategoryKind) -> some View {
        ForEach(rows) { row in
            NavigationLink(value: Route.forDrill(ReportDrill.target(kind: kind, category: row.category, year: String(year)))) {
                LabeledContent { MoneyText(amount: row.net) } label: {
                    VStack(alignment: .leading) {
                        // The label Kuitit shows ("Tarvikkeet & ostot", X081); the drill above keeps the id.
                        Text(ReceiptCategory.label(for: row.category))
                        Text("\(row.count) kpl").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
            }
            // Off screen a row keeps no place: its last one goes stale as the page scrolls on.
            .onGeometryChange(for: ListEndHold.Frame.self) { Self.measured($0) } action: { categoryFrames.rows[row.id] = $0 }
            .onDisappear { categoryFrames.rows[row.id] = nil }
        }
    }

    /// Tulot in place of Menot, or back. At the end of the page the shorter list let the List clamp
    /// its offset, and the picker with everything above it slid a row down under the finger (F012,
    /// motion gates 39580643433 and 39636460950: SCROLLJUMP dy=-66, Menot 3 rows to Tulot 2). What
    /// the page cannot give back from its room below is held over Kirjanpitopaketti instead.
    private func swapCategories(to next: ReportCategoryKind, from shown: ReportCategoryKind, in total: ProfitLoss.Period) {
        let rows = shown.rows(total)
        let visible = rows.prefix(categoryLimit.visible(rows.count))
        let frames = visible.map { categoryFrames.rows[$0.id] }
        // No two rows on screen: the block starts below it, and the page has all of it as room.
        if next != shown, let rowHeight = ListEndHold.rowHeight(frames) {
            let button = categoryLimit.buttonTitle(total: rows.count) != nil
            let buttonHeight = ListEndHold.buttonHeight(button ? categoryFrames.button : nil,
                                                        under: frames.last ?? nil, rowHeight: rowHeight)
            let fresh = ShowMore(step: categoryLimit.step)
            let count = next.rows(total).count
            let before = ListEndHold.blockHeight(rows: visible.count, button: button, rowHeight: rowHeight, buttonHeight: buttonHeight)
            let after = ListEndHold.blockHeight(rows: fresh.visible(count), button: fresh.buttonTitle(total: count) != nil,
                                                rowHeight: rowHeight, buttonHeight: buttonHeight)
            categoryHold = CGFloat(ListEndHold.held(before: before, after: after, held: Double(categoryHold), room: Double(categoryFrames.room)))
        }
        categoryChoice = next
        categoryLimit.reset()
    }

    /// The held room goes once the header that carries it is off screen and the page has that much
    /// room below it: the page gets shorter out of sight.
    private func releaseCategoryHold() {
        guard ListEndHold.canRelease(held: Double(categoryHold), carrierShown: categoryFrames.carrierShown,
                                     room: Double(categoryFrames.room)) else { return }
        categoryHold = 0
    }

    /// Only what a swap reads: not the x, so a push or a swipe-back sliding the page sideways
    /// changes nothing and calls no action.
    private nonisolated static func measured(_ proxy: GeometryProxy) -> ListEndHold.Frame {
        let frame = proxy.frame(in: .global)
        return ListEndHold.Frame(top: Double(frame.minY), height: Double(frame.height))
    }

    /// Written on every layout and scroll, so a class: kept in @State, a write re-renders nothing.
    private final class CategoryFrames {
        var rows: [String: ListEndHold.Frame] = [:]
        var button: ListEndHold.Frame?
        /// How far the page still scrolls down; infinite at its top, where nothing can clamp.
        var room: CGFloat = .infinity
        /// Kirjanpitopaketti's header, which carries `categoryHold`, is on screen: taken as so until it
        /// says it left, so held room never goes while it may still be in sight.
        var carrierShown = true
    }

    /// A figure that opens the rows it is made of (web `DrillFigure`): with one list behind it the
    /// figure is the link; with two (invoices and receipts) it stays plain and each list gets a
    /// labelled row under it; with none it is plain text, never a link to an empty list.
    @ViewBuilder
    private func drillFigure<Content: View>(_ targets: [ReportDrill], @ViewBuilder content: () -> Content) -> some View {
        if targets.count == 1, let only = targets.first {
            NavigationLink(value: Route.forDrill(only)) { content() }
        } else {
            content()
            ForEach(targets, id: \.self) { target in
                NavigationLink(value: Route.forDrill(target)) {
                    Text("Avaa \(target.label.lowercased())")
                        .font(.subheadline)
                        .foregroundStyle(Theme.accentDark)
                        .padding(.leading, 12)
                }
            }
        }
    }

    /// The year's months as bars; a tap picks a month, and the row under the chart opens the
    /// invoices and receipts its result is made of (web `SelectedMonthRow`).
    @ViewBuilder
    private func monthSection(_ months: [ProfitLoss.Period]) -> some View {
        let key = selectedMonth.flatMap { picked in months.contains { $0.month == picked } ? picked : nil }
            ?? ReportDrill.defaultMonth(months)
        let picked = months.first { $0.month == key }
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Chart(months) { m in
                    let on = m.month == key
                    BarMark(x: .value("Kuukausi", m.month ?? ""), y: .value("Tulot", NSDecimalNumber(decimal: m.incomeNet).doubleValue))
                        .foregroundStyle(Theme.success.opacity(on ? 1 : 0.45))
                        .position(by: .value("Laji", "Tulot"))
                        .cornerRadius(2)
                    BarMark(x: .value("Kuukausi", m.month ?? ""), y: .value("Menot", NSDecimalNumber(decimal: m.expenseNet).doubleValue))
                        .foregroundStyle(Theme.ink2.opacity(on ? 0.9 : 0.35))
                        .position(by: .value("Laji", "Menot"))
                        .cornerRadius(2)
                }
                .chartXAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            if let month = value.as(String.self) {
                                Text(MonthKey.short(month))
                                    .fontWeight(month == key ? .semibold : .regular)
                                    .foregroundStyle(month == key ? Theme.ink : Theme.ink2)
                            }
                        }
                    }
                }
                .chartYAxis { AxisMarks(values: .automatic(desiredCount: 3)) }
                // A tap, not a drag, so the list still scrolls over the chart (as Koti's cash-flow card).
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .onTapGesture { location in
                                guard let plot = proxy.plotFrame else { return }
                                let x = location.x - geometry[plot].origin.x
                                if let month = proxy.value(atX: x, as: String.self) {
                                    selectedMonth = month
                                    Haptics.selection()
                                }
                            }
                    }
                }
                .frame(height: 180)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chartSummary(picked))
                .accessibilityHint("Pyyhkäise ylös tai alas vaihtaaksesi kuukautta")
                .accessibilityAdjustableAction { direction in
                    guard let key else { return }
                    let step = direction == .increment ? 1 : -1
                    if let month = Koti.adjacentMonth(months.compactMap(\.month), from: key, step: step) { selectedMonth = month }
                }
                // The bars' key, from the first frame: the colours had none, and only the picked
                // month's row named Tulot and Menot, without them (X086). One element, read after
                // the chart's own summary.
                HStack(spacing: 12) {
                    ChartLegendItem(title: "Tulot", tint: Theme.success)
                    ChartLegendItem(title: "Menot", tint: Theme.ink2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("raportit-legend")
            }
            .padding(.vertical, 6)
            if let picked, let month = picked.month {
                drillFigure(ReportDrill.monthTargets(picked)) {
                    LabeledContent {
                        MoneyText(amount: picked.profitNet).fontWeight(.semibold)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(MonthKey.name(month))
                            Text("Tulot \(Money.format(picked.incomeNet)) · Menot \(Money.format(picked.expenseNet))")
                                .font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                }
            }
        } header: {
            Text("Kuukausittain")
        } footer: {
            Text("Napauta pylvästä nähdäksesi kuukauden tuloksen.")
        }
    }

    private func chartSummary(_ picked: ProfitLoss.Period?) -> String {
        let head = "Tulot ja menot kuukausittain."
        guard let picked, let month = picked.month else { return head }
        return "\(head) \(MonthKey.name(month)): tulot \(Money.format(picked.incomeNet)), menot \(Money.format(picked.expenseNet))."
    }

    /// A year the app has painted (or warmed, `warmPreviousYear`) swaps in within the tap. Emptied
    /// into a spinner page instead, the report let the package below ride up and fall back (M039).
    /// Without a copy the old year's figures stay as a placeholder; the year's `.task(id:)` loads
    /// it and cancels a slower load of the year before.
    private func setYear(_ next: Int) {
        let painted: ProfitLoss? = app.lastPainted(Self.path, query: Self.query(year: next))
        withMotion(.easeInOut(duration: 0.2)) {
            year = next
            selectedMonth = nil
            if let painted { state.succeed(painted) }
        }
    }

    /// The receipts lists this screen links to, as `ReceiptsView` asks for them: the Tulot and
    /// Menot figures, the data-quality rows and the categories shown.
    private var drillWarms: [ReportDrillWarm.Request] {
        guard let report = state.value, !swapping else { return [] }
        let key = String(year)
        var drills = ReportDrill.incomeTargets(report.total, key: key)
        drills += ReportDrill.expenseTargets(report.total, key: key)
        drills += ReportDrill.dataQuality(missingVat: report.total.missingVatCount, undated: report.undatedCount, year: key).map(\.drill)
        if let kind = ReportCategoryKind.resolve(categoryChoice, in: report.total) {
            let rows = kind.rows(report.total)
            drills += rows.prefix(categoryLimit.visible(rows.count)).map { ReportDrill.target(kind: kind, category: $0.category, year: key) }
        }
        return ReportDrillWarm.requests(drills)
    }

    /// Fills the cache, for the lists it holds no answer for, and the drilled list's first frame
    /// (`AppModel.warmReceiptsDrill`); a failure is the list's to show when it is opened. Decoded as
    /// the list decodes them. Not kept on disk: the drills would push the main lists out of the launch snapshot.
    private func warmDrills(_ requests: [ReportDrillWarm.Request]) async {
        let app = app
        await drillWarmer.warm(requests, isCached: { request in
            await app.warmReceiptsDrill(request, fetch: false)
        }, fetch: { request in
            await app.warmReceiptsDrill(request, fetch: true)
        })
    }

    /// Through the app's cache: a year looked at before shows at once, then refreshes when stale.
    private func load() async {
        // A pull-to-refresh is not cancelled by a year change: its answer is for the year it asked.
        let asked = year
        let timing = ScreenTiming("Raportit")
        let query = Self.query(year: asked)
        if state.value == nil || swapping, let cached: ProfitLoss = await app.cachedValue(Self.path, query: query), asked == year {
            show(cached)
            timing.painted(fromCache: true)
        }
        state.begin()
        do {
            let report: ProfitLoss = try await app.cachedGet(Self.path, query: query)
            try Task.checkCancellation()
            guard asked == year else { return }
            show(report)
            timing.dataReady()
            if asked == Self.currentYear { warmPreviousYear() }
        }
        catch is CancellationError {}
        catch {
            guard asked == year else { return }
            // Another year's figures stood in: the failure shows as a first load's would, with its
            // retry, not under a heading those figures do not belong to.
            if swapping { state.restart() }
            // A failed reload keeps the figures already shown (as the other gated screens).
            state.fail(error)
        }
    }

    /// The year's figures on screen; from another year's they fade in. Kept as the app's painted
    /// copy, so coming back to this year swaps it in within the tap (`setYear`).
    private func show(_ report: ProfitLoss) {
        withMotion(swapping ? Animation.easeInOut(duration: 0.2) : nil) { state.succeed(report) }
        app.rememberPainted(report, Self.path, query: Self.query(year: year))
    }

    /// Once this year's figures have painted, the year before is asked once, into the cache and the
    /// app's painted copies: 'Edellinen vuosi' then swaps it in within the tap (M039).
    private func warmPreviousYear() {
        guard !previousWarmed else { return }
        previousWarmed = true
        let app = app
        let query = Self.query(year: Self.currentYear - 1)
        Task {
            do {
                let report: ProfitLoss = try await app.cachedGet(Self.path, query: query)
                app.rememberPainted(report, Self.path, query: query)
            } catch {
                // Asked again after this year's next paint; a swap meanwhile loads the year itself.
                previousWarmed = false
            }
        }
    }
}
