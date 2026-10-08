import SwiftUI
import LashKirjaCore

struct AlvView: View {
    @Environment(AppModel.self) private var app
    @State var period: String
    /// The profile's ALV-verokausi has been read and the opening period settled.
    @State private var resolved = false
    @State private var state = ScreenLoad<AlvReport>()
    @State private var failure: String?
    @State private var notice: String?
    /// The mark being saved ("filed", "paid", "undo"), so its button shows progress and the others wait.
    @State private var busy: String?
    /// Bumped by every load: only the latest one's answer is shown.
    @State private var loadGeneration = 0

    private var kind: VatKind { VatKind(key: period) }
    private var today: String { APIDate.dayString(Date()) }

    var body: some View {
        List {
            periodSections
            if let r = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if !r.vatRegistered { notRegistered }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.field308.isRefund ? "Palautettava ALV" : "Maksettava ALV").font(.subheadline).foregroundStyle(Theme.ink2)
                        MoneyText(amount: r.field308.amount).scaledFont(size: 32, weight: .bold, design: .rounded, relativeTo: .largeTitle).moneyHero()
                    }
                    .padding(.vertical, 4)
                    // TF-11: pending receipts are not in the figure yet; Kuitit lists them on top.
                    if let pending = VatFiling.pendingNote(r.pendingReceiptCount ?? 0) {
                        NavigationLink(value: receiptsRoute) {
                            Label(pending, systemImage: "hourglass").font(.subheadline).foregroundStyle(Theme.warning)
                        }
                    }
                }
                notes(r)
                if r.vatRegistered { filingSection(r) }
                // FP-12: 301 and 307 open the documents they are made of; 302, 303 and 309 have no list of
                // their own (the lists do not filter by VAT rate), as on the web.
                Section("Myynti") {
                    NavigationLink(value: Route.forDrill(ReportDrill.alvSales(r, period: period))) { field(r.field301) }
                    if let receipts = ReportDrill.alvReceiptSales(r, period: period) {
                        NavigationLink(value: Route.forDrill(receipts)) {
                            LabeledContent("Myyntikuiteista") { MoneyText(amount: r.sources?.receiptSalesVat ?? 0) }.font(.subheadline)
                        }
                    }
                    field(r.field302)
                    field(r.field303)
                    LabeledContent(r.field309.label) { MoneyText(amount: r.field309.turnover) }.font(.subheadline)
                }
                if (r.field306?.amount ?? 0) > 0 || (r.field305?.amount ?? 0) > 0 || (r.sources?.reverseChargeVat ?? 0) > 0 || (r.sources?.foreignVatNotDeducted ?? 0) > 0 {
                    Section {
                        if let services = r.field306, services.amount > 0 {
                            LabeledContent("Palveluostot (314)") { MoneyText(amount: r.field314?.amount ?? 0) }.font(.subheadline)
                            LabeledContent(services.label) { MoneyText(amount: services.amount) }.font(.subheadline)
                        }
                        if let goods = r.field305, goods.amount > 0 {
                            LabeledContent("Tavaraostot (313)") { MoneyText(amount: r.field313?.amount ?? 0) }.font(.subheadline)
                            LabeledContent(goods.label) { MoneyText(amount: goods.amount) }.font(.subheadline)
                        }
                        if let notDeducted = r.sources?.foreignVatNotDeducted, notDeducted > 0 {
                            LabeledContent("Ulkomaisten myyjien Suomen ALV, ei vähennettävissä") { MoneyText(amount: notDeducted) }
                                .font(.subheadline).foregroundStyle(Theme.warning)
                        }
                    } header: {
                        Text("Ulkomaiset ostot")
                    } footer: {
                        Text("Käännetyn verovelvollisuuden vero on mukana maksettavassa verossa ja vähennetään samalla summalla kohdassa 307. EU:n ulkopuolelta ostettujen palvelujen vero on kohdassa 301.")
                    }
                }
                Section {
                    NavigationLink(value: Route.forDrill(ReportDrill.alvDeductible(period: period))) {
                        LabeledContent(r.field307.label) { MoneyText(amount: r.field307.amount) }.font(.subheadline)
                    }
                    if let purchases = ReportDrill.alvPurchases(r) {
                        NavigationLink(value: Route.forDrill(purchases)) {
                            LabeledContent("Ostolaskuista") { MoneyText(amount: r.sources?.purchaseInvoiceVat ?? 0) }.font(.subheadline)
                        }
                    }
                } header: {
                    Text("Ostot")
                } footer: {
                    // A quarter has no list filter of its own: say so before the list opens unfiltered.
                    if ReportDrill.alvScope(period).isEmpty { Text("Neljännesvuoden kuitit ja laskut avautuvat koko listana.") }
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: AlvReport) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("ALV-ilmoitus")
        .refreshable { await load() }
        .task(id: period) {
            failure = nil
            notice = nil
            if !resolved {
                resolved = true
                let profileKind = VatKind(profile: await app.cachedProfile()?.vatPeriod)
                // F13: no period given opens on the return that is due; a month from Koti opens on the
                // period of the profile's unit that contains it.
                if period.isEmpty || period.count == 7 && !period.contains("Q") && profileKind != .month {
                    period = period.isEmpty ? VatDue.nextDueKey(today: today, kind: profileKind)
                                            : VatPeriod.key(for: period, kind: profileKind.rawValue)
                    return
                }
            }
            await load()
        }
    }

    // MARK: Period

    /// Kuukausi / Neljännes / Vuosi, then the period: a stepper with a menu of the periods in the middle.
    @ViewBuilder private var periodSections: some View {
        Section {
            HStack(spacing: 8) {
                ForEach(VatKind.allCases) { option in
                    SectionChip(title: option.title, selected: option == kind) { pick(kind: option) }
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Ilmoituskausi")
        }
        Section {
            HStack {
                Button { show(VatPeriod.shift(period, by: -1)) } label: { Image(systemName: "chevron.left").tapTarget() }
                    .accessibilityLabel("Edellinen kausi")
                Spacer()
                Menu {
                    Picker("Kausi", selection: Binding(get: { period }, set: { show($0) })) {
                        ForEach(VatDue.periodOptions(kind: kind, nowYear: Int(today.prefix(4)) ?? 2026, selected: period), id: \.key) { option in
                            Text(option.label).tag(option.key)
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(period.isEmpty ? "" : VatPeriod.title(period)).font(.headline).foregroundStyle(Theme.ink)
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                .accessibilityLabel("Valitse kausi")
                Spacer()
                Button { show(VatPeriod.shift(period, by: 1)) } label: { Image(systemName: "chevron.right").tapTarget() }
                    .disabled(period >= VatPeriod.key(for: MonthKey.current(), kind: kind.rawValue))
                    .accessibilityLabel("Seuraava kausi")
            }
            .buttonStyle(.borderless)
        }
    }

    private func pick(kind next: VatKind) {
        guard next != kind else { return }
        // Another unit opens on the return that is due in it (web `alvKeyForKind`).
        show(VatDue.nextDueKey(today: today, kind: next))
    }

    private func show(_ key: String) {
        guard key != period else { return }
        state.restart()
        failure = nil
        period = key
    }

    // MARK: Notes

    private var notRegistered: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("OmaVero-luonnos").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(VatFiling.notRegisteredNote).font(.footnote).foregroundStyle(Theme.ink2)
            }
            NavigationLink(value: Route.settings) {
                Label("Asetukset", systemImage: "gearshape").font(.subheadline)
            }
        }
    }

    /// The period's receipts (the pending queue is on top of the list); a quarter opens the whole list.
    private var receiptsRoute: Route {
        .receiptsFiltered(month: ReportDrill.alvScope(period), tab: ReceiptTab.all.rawValue)
    }

    /// Where the reported VAT came from and what was left out, each opening the rows it names.
    @ViewBuilder private func notes(_ r: AlvReport) -> some View {
        let sources = r.sources
        let invoices = sources?.invoiceCount ?? 0
        let purchaseCount = sources?.purchaseInvoiceCount ?? 0
        let skipped = r.skippedPurchaseInvoiceCount ?? 0
        let unusable = r.purchaseReceiptUnusableCount ?? 0
        let review = r.review?.count ?? 0
        if invoices > 0 || purchaseCount > 0 || skipped > 0 || unusable > 0 || review > 0 {
            Section {
                if invoices > 0 {
                    NavigationLink(value: Route.forDrill(.invoices(period: ReportDrill.alvScope(period), status: .all))) {
                        note("Myynnin ALV kahdesta lähteestä",
                             VatFiling.salesSourcesNote(receiptSalesVat: sources?.receiptSalesVat ?? 0, invoiceSalesVat: sources?.invoiceSalesVat ?? 0,
                                                        excludedReceipts: r.excludedReceiptCount ?? 0, creditNotes: r.creditNoteCount ?? 0))
                    }
                }
                if purchaseCount > 0 || skipped > 0 || unusable > 0 {
                    NavigationLink(value: Route.forDrill(.purchaseInvoices)) {
                        note("Ostolaskujen ALV",
                             VatFiling.purchaseNote(count: purchaseCount, vat: sources?.purchaseInvoiceVat ?? 0, skipped: skipped,
                                                    suspected: r.suspectedPurchaseDuplicateCount ?? 0, unusable: unusable))
                    }
                }
                if let rv = r.review, review > 0 {
                    // The list has no "no VAT breakdown" filter: it opens on the period's receipts.
                    NavigationLink(value: receiptsRoute) {
                        note(VatFiling.reviewTitle(review), VatFiling.reviewText(salesGross: rv.salesGross, purchasesGross: rv.purchasesGross))
                    }
                }
            }
        }
    }

    private func note(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            Text(text).font(.footnote).foregroundStyle(Theme.ink2)
        }
    }

    // MARK: Ilmoita ja maksa

    @ViewBuilder private func filingSection(_ r: AlvReport) -> some View {
        let filing = r.filing
        let vat = PeriodClose.vat(filedAt: filing?.filedAt, paidAt: filing?.paidAt, filedAmount: filing?.filedAmount,
                                  amount: r.field308.amount, isRefund: r.field308.isRefund)
        let periodYear = Int(period.prefix(4)) ?? 0
        let dueIso = VatDue.deadline(period) ?? ""
        let owed = VatFiling.amountToPay(amount: r.field308.amount, filedAt: filing?.filedAt, filedAmount: filing?.filedAmount)
        Section {
            HStack(spacing: 6) {
                if vat.state != .open { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success).accessibilityHidden(true) }
                Text(VatFiling.stateLabel(vat.state, nothingToPay: vat.nothingToPay)).font(.subheadline.weight(.semibold))
                if !dueIso.isEmpty {
                    Text("· eräpäivä \(VatDue.dueDateText(dueIso, periodYear: periodYear))").font(.subheadline).foregroundStyle(Theme.ink2)
                }
            }
            if vat.state == .open {
                let pay = vat.nothingToPay ? nil : VatFiling.payStepText(amount: owed, dueIso: dueIso, periodYear: periodYear)
                VStack(alignment: .leading, spacing: 4) {
                    step(1, "Kirjaudu OmaVeroon (vero.fi/omavero).")
                    step(2, "Valitse Arvonlisävero ja kausiveroilmoitus kaudelle \(VatDue.label(period)).")
                    step(3, VatFiling.fileStepText(dueIso: dueIso, periodYear: periodYear))
                    if let pay { step(4, "\(pay) Viitenumero ja tilinumero ovat OmaVerossa kohdassa Maksut.") }
                }
            }
            if vat.state == .filed && !vat.nothingToPay {
                Text(VatFiling.filedNote(filedOn: filing?.filedAt.map(APIDate.displayDay) ?? "", amount: owed, dueIso: dueIso,
                                         nothingToPay: vat.nothingToPay, periodYear: periodYear))
                    .font(.footnote).foregroundStyle(Theme.ink2)
            }
            if vat.state == .paid {
                Text("Maksettu \(filing?.paidAt.map(APIDate.displayDay) ?? "").").font(.footnote).foregroundStyle(Theme.ink2)
            }
            if vat.changedSinceFiling, let filed = filing?.filedAmount {
                Label(PeriodClose.vatChangedNote(filedAmount: filed, amount: r.field308.amount, isRefund: r.field308.isRefund)
                      + " Tarkista, pitääkö ilmoitusta korjata OmaVerossa.",
                      systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.warning)
            }
            if !VatDue.periodEnded(period, today: today) {
                // The server refuses a mark before the period is over; say so instead of offering the button.
                Text(VatFiling.notEndedNote).font(.footnote).foregroundStyle(Theme.ink2)
            } else {
                if vat.state == .open {
                    markButton("Merkitse ilmoitetuksi", key: "filed") { await setFiling(filed: true, paid: nil, done: "ALV-ilmoitus merkitty annetuksi") }
                }
                if vat.state == .filed && !vat.nothingToPay {
                    markButton("Merkitse maksetuksi", key: "paid") { await setFiling(filed: nil, paid: true, done: "ALV merkitty maksetuksi") }
                }
                if vat.state != .open {
                    let clearsPaid = VatFiling.undo(state: vat.state, nothingToPay: vat.nothingToPay) == .paid
                    Button {
                        Task { await setFiling(filed: clearsPaid ? nil : false, paid: clearsPaid ? false : nil, done: "Merkintä peruttiin") }
                    } label: {
                        HStack {
                            Text(busy == "undo" ? "Perutaan…" : VatFiling.undoTitle(state: vat.state, nothingToPay: vat.nothingToPay))
                            if busy == "undo" { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy != nil)
                }
            }
        } header: {
            Text("Ilmoita ja maksa")
        } footer: {
            if let failure {
                Text(failure).foregroundStyle(Theme.danger)
            } else if let notice {
                Text(notice).foregroundStyle(Theme.success)
            } else {
                Text("Sovellus ei lähetä ilmoitusta OmaVeroon; merkitse se tehdyksi täällä.")
            }
        }
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(number).").monospacedDigit()
            Text(text)
        }
        .font(.footnote)
        .foregroundStyle(Theme.ink2)
    }

    private func markButton(_ title: String, key: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            ZStack {
                Text(title).opacity(busy == key ? 0 : 1)
                if busy == key { ProgressView().tint(Theme.onInk) }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.primary)
        .disabled(busy != nil)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
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

    /// An answer (or failure) is shown only while its period (and so its kind) is still on screen
    /// and no later load has started: a slow pull-to-refresh or a load from before a period
    /// change must not put another period's figures under this one's heading.
    private func load() async {
        let asked = period
        loadGeneration += 1
        let mine = loadGeneration
        state.begin()
        do {
            let report: AlvReport = try await app.api.get("/api/alv", query: ["period": asked])
            guard asked == period, mine == loadGeneration else { return }
            state.succeed(report)
        }
        catch is CancellationError {}
        catch {
            guard asked == period, mine == loadGeneration else { return }
            state.fail(error)
        }
    }

    /// PATCH /api/alv/filing: `filed: false` undoes both marks, `paid` needs a filed return.
    private func setFiling(filed: Bool?, paid: Bool?, done: String) async {
        struct Body: Encodable { let period: String; let filed: Bool?; let paid: Bool? }
        guard busy == nil else { return }
        busy = filed == false || paid == false ? "undo" : filed == true ? "filed" : "paid"
        defer { busy = nil }
        let asked = period
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/alv/filing", body: Body(period: asked, filed: filed, paid: paid))
            // Another period is on screen now: its notes are not this mark's.
            guard asked == period else { return }
            Haptics.success()
            failure = nil
            notice = done
            await load()
        } catch is CancellationError {
        } catch {
            guard asked == period else { return }
            notice = nil
            failure = error.userMessage
            Haptics.error()
        }
    }
}
