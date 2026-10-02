import SwiftUI
import LashKirjaCore

struct AlvView: View {
    @Environment(AppModel.self) private var app
    @State var period: String
    @State private var state: Loadable<AlvReport> = .idle
    @State private var failure: String?

    var body: some View {
        List {
            Section {
                HStack {
                    Button { Task { await step(-1) } } label: { Image(systemName: "chevron.left") }
                    Spacer()
                    Text(MonthKey.title(period, currentYear: String(MonthKey.current().prefix(4)))).font(.headline)
                    Spacer()
                    Button { Task { await step(1) } } label: { Image(systemName: "chevron.right") }.disabled(period >= MonthKey.current())
                }
                .buttonStyle(.borderless)
            }
            if let r = state.value {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.field308.isRefund ? "Palautettava ALV" : "Maksettava ALV").font(.subheadline).foregroundStyle(Theme.ink2)
                        MoneyText(amount: r.field308.amount).font(.system(size: 32, weight: .bold, design: .rounded))
                    }
                    .padding(.vertical, 4)
                }
                Section("Myynti") {
                    field(r.field301)
                    field(r.field302)
                    field(r.field303)
                    LabeledContent(r.field309.label) { MoneyText(amount: r.field309.turnover) }.font(.subheadline)
                }
                Section("Ostot") {
                    LabeledContent(r.field307.label) { MoneyText(amount: r.field307.amount) }.font(.subheadline)
                }
                Section {
                    Toggle("Ilmoitettu OmaVerossa", isOn: Binding(get: { r.filing?.filedAt != nil }, set: { v in Task { await setFiling(filed: v, paid: nil) } }))
                    Toggle("Maksettu", isOn: Binding(get: { r.filing?.paidAt != nil }, set: { v in Task { await setFiling(filed: nil, paid: v) } }))
                } footer: {
                    Text("Sovellus ei lähetä ilmoitusta OmaVeroon; merkitse se tehdyksi täällä.")
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            } else {
                LoadState(state: state, retry: load) { (_: AlvReport) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("ALV-ilmoitus")
        .refreshable { await load() }
        .task { await load() }
    }

    private func field(_ f: AlvReport.SalesField) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(f.label).font(.subheadline)
            HStack {
                Text("Myynti \(Money.format(f.netSales))").font(.caption).foregroundStyle(Theme.ink2)
                Spacer()
                MoneyText(amount: f.vat).font(.subheadline.weight(.semibold))
            }
        }
    }

    private func step(_ delta: Int) async {
        period = MonthKey.shift(period, by: delta)
        state = .loading
        await load()
    }

    private func load() async {
        do { state = .loaded(try await app.api.get("/api/alv", query: ["period": period])) }
        catch is CancellationError {}
        catch { state = .failed(error.userMessage) }
    }

    private func setFiling(filed: Bool?, paid: Bool?) async {
        struct Body: Encodable { let period: String; let filed: Bool?; let paid: Bool? }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/alv/filing", body: Body(period: period, filed: filed, paid: paid))
            Haptics.success()
            await load()
        } catch {
            failure = error.userMessage
        }
    }
}
