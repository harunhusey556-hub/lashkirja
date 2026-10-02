import SwiftUI
import Charts
import LashKirjaCore

struct RaportitView: View {
    @Environment(AppModel.self) private var app
    @State private var year = Int(MonthKey.current().prefix(4)) ?? 2026
    @State private var state: Loadable<ProfitLoss> = .idle
    @State private var export: ExportKind?
    /// The accountant package's period: "YYYY-MM", "YYYY-Qn" or "YYYY" (SALES-21).
    @State private var packageChoice = MonthKey.shift(MonthKey.current(), by: -1)
    @State private var showPackage = false
    /// Tulot or Menot by category: one list at a time instead of two stacked (nil = the default).
    @State private var categoryChoice: ReportCategoryKind?
    @State private var categoryLimit = ShowMore()

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
                Section("Tulos ilman ALV:ta") {
                    LabeledContent("Tulot") { MoneyText(amount: report.total.incomeNet) }
                    LabeledContent("Menot") { MoneyText(amount: report.total.expenseNet) }
                    LabeledContent("Tulos") { MoneyText(amount: report.total.profitNet).fontWeight(.semibold) }
                }
                Section("Kuukausittain") {
                    Chart(report.filledMonths(year: String(year))) { m in
                        BarMark(x: .value("Kuukausi", MonthKey.short(m.month ?? "")), y: .value("Tulot", NSDecimalNumber(decimal: m.incomeNet).doubleValue))
                            .foregroundStyle(Theme.success)
                            .position(by: .value("Laji", "Tulot"))
                        BarMark(x: .value("Kuukausi", MonthKey.short(m.month ?? "")), y: .value("Menot", NSDecimalNumber(decimal: m.expenseNet).doubleValue))
                            .foregroundStyle(Theme.ink2.opacity(0.7))
                            .position(by: .value("Laji", "Menot"))
                    }
                    .chartForegroundStyleScale(["Tulot": Theme.success, "Menot": Theme.ink2.opacity(0.7)])
                    .frame(height: 180)
                    .padding(.vertical, 6)
                }
                categorySection(report.total)
            } else {
                LoadState(state: state, retry: load) { (_: ProfitLoss) in EmptyView() }.listRowBackground(Color.clear)
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
        .task(id: year) { await load() }
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
                categories(Array(rows.prefix(categoryLimit.visible(rows.count))))
                ShowMoreButton(limit: $categoryLimit, total: rows.count)
            } header: {
                // With the picker above, its label already names the list.
                if kinds.count == 1 { Text("\(kind.title) luokittain") }
            }
        }
    }

    private func categories(_ rows: [ProfitLoss.Category]) -> some View {
        ForEach(rows) { row in
            LabeledContent { MoneyText(amount: row.net) } label: {
                VStack(alignment: .leading) {
                    Text(row.category)
                    Text("\(row.count) kpl").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
        }
    }

    /// The year's `.task(id:)` loads it and cancels a slower load of the previous year.
    private func setYear(_ next: Int) {
        year = next
        state = .loading
    }

    private func load() async {
        do {
            let report: ProfitLoss = try await app.api.get("/api/reports/profit-loss", query: ["from": "\(year)-01", "to": "\(year)-12"])
            try Task.checkCancellation()
            state = .loaded(report)
        }
        catch is CancellationError {}
        catch { state = .failed(error.userMessage) }
    }
}
