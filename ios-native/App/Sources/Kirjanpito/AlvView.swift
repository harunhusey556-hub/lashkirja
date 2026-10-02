import SwiftUI
import LashKirjaCore

struct AlvView: View {
    @Environment(AppModel.self) private var app
    @State var period: String
    @State private var kind: String?
    @State private var state: Loadable<AlvReport> = .idle
    @State private var failure: String?
    /// The switch position while its save is in flight, so it does not snap back and flip again.
    @State private var pendingFiled: Bool?
    @State private var pendingPaid: Bool?

    var body: some View {
        List {
            Section {
                HStack {
                    Button { Task { await step(-1) } } label: { Image(systemName: "chevron.left") }
                    Spacer()
                    Text(VatPeriod.title(period)).font(.headline)
                    Spacer()
                    Button { Task { await step(1) } } label: { Image(systemName: "chevron.right") }
                        .disabled(period >= VatPeriod.key(for: MonthKey.current(), kind: kind))
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
                    Toggle("Ilmoitettu OmaVerossa", isOn: Binding(get: { pendingFiled ?? (r.filing?.filedAt != nil) }, set: { v in pendingFiled = v; Task { await setFiling(filed: v, paid: nil); pendingFiled = nil } }))
                    Toggle("Maksettu", isOn: Binding(get: { pendingPaid ?? (r.filing?.paidAt != nil) }, set: { v in pendingPaid = v; Task { await setFiling(filed: nil, paid: v); pendingPaid = nil } }))
                } footer: {
                    Text("Sovellus ei lähetä ilmoitusta OmaVeroon; merkitse se tehdyksi täällä.")
                }
                if let filing = r.filing, filing.filedAt != nil, let filed = filing.filedAmount,
                   PeriodClose.vat(filedAt: filing.filedAt, paidAt: filing.paidAt, filedAmount: filed,
                                   amount: r.field308.amount, isRefund: r.field308.isRefund).changedSinceFiling {
                    Section {
                        Label(PeriodClose.vatChangedNote(filedAmount: filed, amount: r.field308.amount, isRefund: r.field308.isRefund)
                              + " Tarkista, pitääkö ilmoitusta korjata OmaVerossa.",
                              systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                            .foregroundStyle(Theme.warning)
                    }
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
        .task(id: period) {
            if kind == nil {
                kind = await app.cachedProfile()?.vatPeriod ?? "month"
                // No period given: the latest one that can be filed.
                if period.isEmpty || period.count == 7 && kind != "month" {
                    period = period.isEmpty ? VatPeriod.previous(MonthKey.current(), kind: kind) : VatPeriod.key(for: period, kind: kind)
                    return
                }
            }
            await load()
        }
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
        state = .loading
        period = VatPeriod.shift(period, by: delta)
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
            Haptics.error()
        }
    }
}
