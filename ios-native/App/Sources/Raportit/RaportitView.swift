import SwiftUI
import Charts
import LashKirjaCore

struct RaportitView: View {
    @Environment(AppModel.self) private var app
    @State private var year = Int(MonthKey.current().prefix(4)) ?? 2026
    @State private var state = ScreenLoad<ProfitLoss>()
    @State private var export: ExportKind?
    /// The accountant package's period: "YYYY-MM", "YYYY-Qn" or "YYYY" (SALES-21).
    @State private var packageChoice = MonthKey.shift(MonthKey.current(), by: -1)
    @State private var showPackage = false
    /// Tulot or Menot by category: one list at a time instead of two stacked (nil = the default).
    @State private var categoryChoice: ReportCategoryKind?
    @State private var categoryLimit = ShowMore()
    /// The month picked on the chart; nil = the latest month with figures.
    @State private var selectedMonth: String?
    /// Reloads after a change elsewhere (`dataVersion`) as well as on another year.
    @State private var gate = ReloadGate()

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
                    Button { setYear(year - 1) } label: { Image(systemName: "chevron.left") }
                    Spacer()
                    Text(String(year)).font(.headline).monospacedDigit()
                    Spacer()
                    Button { setYear(year + 1) } label: { Image(systemName: "chevron.right") }
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
                let yearKey = String(year)
                Section("Tulos ilman ALV:ta") {
                    drillFigure(ReportDrill.incomeTargets(report.total, key: yearKey)) {
                        LabeledContent("Tulot") { MoneyText(amount: report.total.incomeNet) }
                    }
                    drillFigure([ReportDrill.expenseTarget(report.total, key: yearKey)].compactMap { $0 }) {
                        LabeledContent("Menot") { MoneyText(amount: report.total.expenseNet) }
                    }
                    LabeledContent("Tulos") { MoneyText(amount: report.total.profitNet).fontWeight(.semibold) }
                    // What the figures may be missing; the list has no filter for either, so the rows
                    // open the year's receipts (undated ones the whole list).
                    ForEach(ReportDrill.dataQuality(missingVat: report.total.missingVatCount, undated: report.undatedCount, year: yearKey), id: \.self) { row in
                        NavigationLink(value: Route.forDrill(row.drill)) {
                            LabeledContent(row.title) {
                                Text("\(row.count)").monospacedDigit().foregroundStyle(Theme.warning)
                            }
                        }
                    }
                }
                monthSection(report.filledMonths(year: yearKey))
                categorySection(report.total)
            } else {
                ScreenStateView(state: state, retry: load) { (_: ProfitLoss) in EmptyView() }.listRowBackground(Color.clear)
            }
            Section {
                Picker("Kausi", selection: Binding(get: { packagePeriod }, set: { packageChoice = $0 })) {
                    ForEach(packageOptions, id: \.key) { option in
                        Text(option.title).tag(option.key)
                    }
                }
                Button { showPackage = true } label: { Label("Lataa zip", systemImage: "archivebox") }
            } header: {
                Text("Kirjanpitopaketti")
            } footer: {
                Text("Lähetä kirjanpitäjälle kuun sulun jälkeen. Zip kuukaudelta, neljännekseltä tai koko vuodelta: tuloslaskelma, ALV, CSV, kohdistukset ja kuitit.")
            }
            Section {
                ForEach(exports) { kind in
                    Button { export = kind } label: { Label(kind.title, systemImage: "square.and.arrow.up") }
                }
            } header: { Text("Vienti (CSV)") } footer: { Text("Koko vuoden \(String(year)) tiedot kirjanpitäjälle.") }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Raportit")
        .refreshable { await load() }
        .task(id: "\(year)|\(app.dataVersion)") {
            let key = String(year)
            guard state.value == nil || gate.isDue(key: key, version: app.dataVersion) else { return }
            // The report on screen stays while the new one loads (another year clears it in `setYear`).
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: key, version: version) }
        }
        .onChange(of: year) { _, _ in categoryLimit.reset() }
        .sheet(isPresented: $showPackage) {
            DocumentPreviewSheet(path: "/api/export/package", query: ["month": packagePeriod], fileName: "kirjanpito-\(packagePeriod).zip")
        }
        .sheet(item: $export) { kind in
            DocumentPreviewSheet(path: "/api/export", query: ["type": kind.type, "year": String(year)], fileName: "\(kind.type)-\(year).csv")
        }
    }

    /// The chosen period when it belongs to the year on screen, else that year's January (as on the web).
    private var packagePeriod: String {
        packageChoice.hasPrefix(String(year)) ? packageChoice : "\(year)-01"
    }

    private struct PackageOption: Hashable { let key: String; let title: String }

    private var packageOptions: [PackageOption] {
        let y = String(year)
        let months = (1...12).map { m -> PackageOption in
            let mm = String(format: "%02d", m)
            return PackageOption(key: "\(y)-\(mm)", title: "\(mm)/\(y)")
        }
        let quarters = (1...4).map { q in PackageOption(key: "\(y)-Q\(q)", title: "Q\(q)/\(y)") }
        return months + quarters + [PackageOption(key: y, title: "Koko vuosi \(y)")]
    }

    @ViewBuilder
    private func categorySection(_ total: ProfitLoss.Period) -> some View {
        let kinds = ReportCategoryKind.available(total)
        if let kind = ReportCategoryKind.resolve(categoryChoice, in: total) {
            let rows = kind.rows(total)
            if kinds.count > 1 {
                Section("Luokittain") {
                    Picker("Luokittain", selection: Binding(get: { kind }, set: { categoryChoice = $0; categoryLimit.reset() })) {
                        ForEach(kinds) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            Section {
                categories(Array(rows.prefix(categoryLimit.visible(rows.count))), kind: kind)
                ShowMoreButton(limit: $categoryLimit, total: rows.count)
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
                        Text(row.category)
                        Text("\(row.count) kpl").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
            }
        }
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
            .padding(.vertical, 6)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(chartSummary(picked))
            .accessibilityHint("Pyyhkäise ylös tai alas vaihtaaksesi kuukautta")
            .accessibilityAdjustableAction { direction in
                guard let key else { return }
                let step = direction == .increment ? 1 : -1
                if let month = Koti.adjacentMonth(months.compactMap(\.month), from: key, step: step) { selectedMonth = month }
            }
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

    /// The year's `.task(id:)` loads it and cancels a slower load of the previous year; the old
    /// year's figures are not shown under the new year's heading meanwhile.
    private func setYear(_ next: Int) {
        year = next
        selectedMonth = nil
        state.restart()
    }

    private func load() async {
        // A pull-to-refresh is not cancelled by a year change: its answer is for the year it asked.
        let asked = year
        state.begin()
        do {
            let report: ProfitLoss = try await app.api.get("/api/reports/profit-loss", query: ["from": "\(asked)-01", "to": "\(asked)-12"])
            try Task.checkCancellation()
            guard asked == year else { return }
            state.succeed(report)
        }
        catch is CancellationError {}
        catch {
            guard asked == year else { return }
            // A failed reload keeps the figures already shown (as the other gated screens).
            state.fail(error)
        }
    }
}
