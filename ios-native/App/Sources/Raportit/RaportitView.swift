import SwiftUI
import Charts
import LashKirjaCore

struct RaportitView: View {
    @Environment(AppModel.self) private var app
    @State private var year = Int(MonthKey.current().prefix(4)) ?? 2026
    @State private var state: Loadable<ProfitLoss> = .idle
    @State private var export: ExportKind?

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
                    Button { Task { await setYear(year - 1) } } label: { Image(systemName: "chevron.left") }
                    Spacer()
                    Text(String(year)).font(.headline).monospacedDigit()
                    Spacer()
                    Button { Task { await setYear(year + 1) } } label: { Image(systemName: "chevron.right") }
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
                if !report.total.incomeByCategory.isEmpty {
                    Section("Tulot luokittain") { categories(report.total.incomeByCategory) }
                }
                if !report.total.expenseByCategory.isEmpty {
                    Section("Menot luokittain") { categories(report.total.expenseByCategory) }
                }
            } else {
                LoadState(state: state, retry: load) { (_: ProfitLoss) in EmptyView() }.listRowBackground(Color.clear)
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
        .task { await load() }
        .sheet(item: $export) { kind in
            DocumentPreviewSheet(path: "/api/export", query: ["type": kind.type, "year": String(year)], fileName: "\(kind.type)-\(year).csv")
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

    private func setYear(_ next: Int) async {
        year = next
        state = .loading
        await load()
    }

    private func load() async {
        do { state = .loaded(try await app.api.get("/api/reports/profit-loss", query: ["from": "\(year)-01", "to": "\(year)-12"])) }
        catch is CancellationError {}
        catch { state = .failed(error.userMessage) }
    }
}
