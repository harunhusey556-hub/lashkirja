import SwiftUI
import Observation
import LashKirjaCore

/// Recurring invoices (`/toistuvat`): schedules that make an invoice every month, quarter or year.
struct RecurringInvoicesView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<RecurringList>()
    @State private var showInactive = false
    /// The pushed schedule. Kept apart from the rows, so a reload that drops its row
    /// (paused while only active ones show) does not pop the screen.
    @State private var selected: RecurringInvoice?
    @State private var showNew = false
    @State private var notice: String?
    @State private var runner = RecurringRunner()
    @State private var limit = ShowMore()

    var body: some View {
        List {
            if let list = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if let notice {
                    Section { Text(notice).font(.subheadline) }
                }
                if list.dueNow > 0 {
                    Section {
                        Text(list.dueNow == 1 ? "1 toistuva lasku odottaa luontia." : "\(list.dueNow) toistuvaa laskua odottaa luontia.")
                        Button {
                            Task { await runner.preview(app: app, scope: nil) }
                        } label: {
                            HStack {
                                Spacer()
                                if runner.checking { ProgressView() } else { Text("Luo odottavat laskut") }
                                Spacer()
                            }
                        }
                        .buttonStyle(.primary)
                        .disabled(runner.checking || runner.running)
                        .listRowBackground(Color.clear)
                    }
                }
                Section {
                    Picker("Näytä", selection: $showInactive) {
                        Text("Aktiiviset").tag(false)
                        Text("Myös pysäytetyt").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    if list.recurring.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(showInactive ? "Ei toistuvia laskuja vielä" : "Ei aktiivisia toistuvia laskuja").font(.headline)
                            Text(showInactive
                                 ? "Kun asiakas maksaa säännöllisesti, lasku tehdään tästä joka kerta itsestään."
                                 : "Pysäytetyt näkyvät valinnalla Myös pysäytetyt. Uuden voi lisätä +-painikkeesta.")
                                .font(.subheadline).foregroundStyle(Theme.ink2)
                        }
                        .padding(.vertical, 4)
                    }
                    ForEach(list.recurring.prefix(limit.visible(list.recurring.count))) { entry in
                        Button { selected = entry } label: { row(entry) }
                            .foregroundStyle(Theme.ink)
                    }
                    ShowMoreButton(limit: $limit, total: list.recurring.count)
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: RecurringList) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Toistuvat laskut")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Uusi toistuva lasku")
            }
        }
        .refreshable { await load() }
        // Every accepted write bumps dataVersion: a change made on the pushed detail shows here on Back.
        .task(id: "\(showInactive)|\(app.dataVersion)") { await load() }
        .onChange(of: showInactive) { _, _ in limit.reset() }
        .sheet(isPresented: $showNew) {
            RecurringFormSheet(existing: nil) { message in
                notice = message
                Task { await load() }
            }
        }
        .navigationDestination(item: $selected) { entry in
            RecurringDetailView(entry: entry) { message in notice = message }
        }
        .recurringRunConfirmation(runner: runner) { message in
            notice = message
            Task { await load() }
        }
    }

    private func row(_ entry: RecurringInvoice) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title).lineLimit(1)
                Text(entry.secondary(today: APIDate.dayString(Date()))).font(.caption).foregroundStyle(Theme.ink2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                MoneyText(amount: entry.total).font(.subheadline.weight(.semibold))
                if !entry.active {
                    Text("Pysäytetty")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.ink2.opacity(0.12), in: Capsule())
                        .foregroundStyle(Theme.ink2)
                }
            }
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func load() async {
        state.begin()
        do {
            let list: RecurringList = try await app.api.get("/api/recurring-invoices", query: showInactive ? ["includeInactive": "1"] : [:])
            state.succeed(list)
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }
}

/// "Luo lasku nyt": first the plan (what would be created and mailed), then the confirmed run.
@MainActor
@Observable
final class RecurringRunner {
    var checking = false
    var running = false
    var plan: RecurringRunPlan?
    var scope: String?
    var message: String?

    func preview(app: AppModel, scope: String?) async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let plan: RecurringRunPlan = try await app.api.get("/api/recurring-invoices/run",
                query: scope.map { ["recurringInvoiceId": $0] } ?? [:])
            if plan.plan.isEmpty {
                message = "Yhtään laskua ei ole juuri nyt luotavana."
            } else if plan.invoiceCount == 0 {
                message = plan.lockedOnlyMessage
            } else {
                self.scope = scope
                self.plan = plan
            }
        } catch is CancellationError {
        } catch {
            message = error.userMessage
            Haptics.error()
        }
    }
}

private struct RunBody: Encodable { let recurringInvoiceId: String? }

private struct RecurringRunConfirmation: ViewModifier {
    @Environment(AppModel.self) private var app
    let runner: RecurringRunner
    let onDone: (String) -> Void

    func body(content: Content) -> some View {
        content
            .alert(runner.plan?.confirmTitle ?? "",
                   isPresented: Binding(get: { runner.plan != nil }, set: { if !$0 { runner.plan = nil } }),
                   presenting: runner.plan) { plan in
                Button(plan.confirmLabel) { Task { await run() } }
                Button("Peruuta", role: .cancel) { runner.plan = nil }
            } message: { plan in
                Text(plan.summary)
            }
            .onChange(of: runner.message) { _, message in
                if let message {
                    onDone(message)
                    runner.message = nil
                }
            }
    }

    private func run() async {
        let scope = runner.scope
        runner.plan = nil
        runner.running = true
        defer { runner.running = false }
        do {
            let result: RecurringRunResult = try await app.api.send("POST", "/api/recurring-invoices/run", body: RunBody(recurringInvoiceId: scope))
            let summary = result.summary
            if summary.isProblem { Haptics.error() } else { Haptics.success() }
            onDone(summary.text)
        } catch {
            Haptics.error()
            onDone(error.userMessage)
        }
    }
}

extension View {
    func recurringRunConfirmation(runner: RecurringRunner, onDone: @escaping (String) -> Void) -> some View {
        modifier(RecurringRunConfirmation(runner: runner, onDone: onDone))
    }
}

/// Everything about one schedule, with its actions; pushed from the list, so Back works as anywhere.
struct RecurringDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: RecurringInvoice
    let onChanged: (String) -> Void
    /// The schedule as the server has it now: fixing a failed auto-send (opening the invoice and
    /// sending it from here) changes what this screen should show.
    @State private var fresh: RecurringInvoice?
    @State private var busy = false
    @State private var failure: String?
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var runner = RecurringRunner()
    @State private var lineLimit = ShowMore()

    var body: some View {
        List {
            Section {
                LabeledContent("Asiakas", value: current.customer.name)
                LabeledContent("Toistoväli", value: current.interval.label)
                LabeledContent("Laskutuspäivä", value: "\(current.anchorDay).")
                LabeledContent("Seuraava", value: current.nextRunAt.map { RecurringInvoice.scheduleDate($0, today: APIDate.dayString(Date())) } ?? "Päättynyt")
                LabeledContent("Alkaa", value: APIDate.displayDay(current.startDate))
                if let end = current.endDate { LabeledContent("Päättyy", value: APIDate.displayDay(end)) }
                LabeledContent("Maksuaika", value: "\(current.paymentTermDays) pv")
                LabeledContent("Lähetys", value: current.autoSend ? "Sähköpostilla automaattisesti" : "Jää luonnokseksi")
                LabeledContent("Luotu", value: "\(current.generatedCount) laskua")
                LabeledContent("Yhteensä (veroton)") { MoneyText(amount: current.total) }
            }
            ForEach(current.failedSends, id: \.invoiceId) { failed in
                Section {
                    Text("Laskun \(APIDate.displayDay(failed.issueDate)) automaattinen lähetys epäonnistui. Lasku on tallessa luonnoksena.")
                    NavigationLink(value: Route.invoice(failed.invoiceId)) { Text("Avaa lasku ja lähetä") }
                }
            }
            if let missed = current.missedText {
                Section {
                    Text(missed)
                    NavigationLink(value: Route.periods) { Text("Kuukauden sulku") }
                }
            }
            Section("Rivit") {
                ForEach(current.lines.prefix(lineLimit.visible(current.lines.count))) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(line.description)
                            Spacer()
                            MoneyText(amount: line.quantity * line.unitPrice)
                        }
                        Text("\(InvoiceDetailView.number(line.quantity)) \(line.unit) × \(Money.format(line.unitPrice)) · ALV \(InvoiceDetailView.number(SalesVat.adjustedRate(line.vatRate, issueDate: APIDate.dayString(Date())))) %")
                            .font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                ShowMoreButton(limit: $lineLimit, total: current.lines.count)
            }
            if let last = current.lastRun, let invoiceId = last.invoiceId {
                Section {
                    NavigationLink(value: Route.invoice(invoiceId)) {
                        Text("Avaa viimeisin lasku (\(APIDate.displayDay(last.issueDate)))")
                    }
                }
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            Section {
                if current.isDue(today: APIDate.dayString(Date())) {
                    Button {
                        Task { await runner.preview(app: app, scope: current.id) }
                    } label: {
                        Label(runner.checking ? "Tarkistetaan…" : "Luo lasku nyt", systemImage: "bolt")
                    }
                    .disabled(busy || runner.checking || runner.running)
                }
                Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
                Button { Task { await toggleActive() } } label: {
                    Label(current.active ? "Pysäytä" : "Jatka", systemImage: current.active ? "pause.circle" : "play.circle")
                }
                Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
            }
            .disabled(busy)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(current.title)
        .navigationBarTitleDisplayMode(.inline)
        // After an edit the screen stays: the refresh below shows the saved schedule.
        .sheet(isPresented: $editing) {
            RecurringFormSheet(existing: current) { message in
                onChanged(message)
            }
        }
        .confirmationDialog("Poistetaanko toistuva lasku?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await remove() } }
        } message: {
            Text("\(current.title). Jo luodut laskut säilyvät.")
        }
        .recurringRunConfirmation(runner: runner) { message in
            onChanged(message)
            dismiss()
        }
        // Every accepted write bumps dataVersion (a send from the invoice pushed above included).
        .task(id: app.dataVersion) { await refresh() }
    }

    private var current: RecurringInvoice { fresh ?? entry }

    private func refresh() async {
        do {
            let response: RecurringResponse = try await app.api.get("/api/recurring-invoices/\(entry.id)")
            fresh = response.recurring
        } catch is CancellationError {
        } catch {
            // The list's copy stays on screen; a deleted schedule is handled by the list on close.
        }
    }

    private func toggleActive() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let response: RecurringResponse = try await app.api.send("PATCH", "/api/recurring-invoices/\(current.id)", body: RecurringActivePatch(active: !current.active))
            Haptics.success()
            fresh = response.recurring
            onChanged(response.recurring.active ? "Toistuva lasku jatkuu" : "Toistuva lasku pysäytettiin")
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func remove() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/recurring-invoices/\(current.id)", body: Optional<EmptyBody>.none)
            Haptics.success()
            onChanged("Toistuva lasku poistettiin. Jo luodut laskut säilyvät.")
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// New schedule, or an edit of one (`existing`).
struct RecurringFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: RecurringInvoice?
    let onSaved: (String) -> Void
    @State private var draft = RecurringDraft(today: APIDate.dayString(Date()))
    @State private var startDate = Date()
    @State private var hasEnd = false
    @State private var endDate = Date()
    @State private var customers: [Customer] = []
    @State private var catalog: [CatalogItem] = []
    @State private var showNewCustomer = false
    @State private var busy = false
    @State private var failure: String?
    @State private var loaded = false
    @State private var sellerRegistered = true
    /// The form as it opened; anything else is an unsaved change.
    @State private var baseline: RecurringDraft?
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Asiakas") {
                    Picker("Asiakas", selection: Binding(get: { draft.customerId }, set: { pickCustomer($0) })) {
                        Text("Valitse asiakas").tag("")
                        ForEach(customers) { Text($0.name).tag($0.id) }
                    }
                    Button { showNewCustomer = true } label: { Label("Uusi asiakas", systemImage: "person.badge.plus") }
                    TextField("Nimi (valinnainen)", text: $draft.name)
                }
                Section("Toisto") {
                    Picker("Toistoväli", selection: $draft.interval) {
                        ForEach(RecurrenceInterval.allCases) { Text($0.label).tag($0) }
                    }
                    Stepper("Laskutuspäivä \(draft.anchorDay).", value: $draft.anchorDay, in: 1...31)
                    DatePicker("Alkaa", selection: $startDate, displayedComponents: .date)
                    Toggle("Päättymispäivä", isOn: $hasEnd).tint(Theme.accent)
                    if hasEnd {
                        DatePicker("Päättyy", selection: $endDate, in: startDate..., displayedComponents: .date)
                    }
                    Stepper("Maksuaika \(draft.paymentTermDays) pv", value: $draft.paymentTermDays, in: 0...365, step: 7)
                    Toggle("Lähetä sähköpostilla automaattisesti", isOn: $draft.autoSend).tint(Theme.accent)
                }
                Section("Rivit") {
                    // Values with a lookup binding, not `$draft.lines`: an array binding crashes when a
                    // swiped line goes while its editor is still on screen.
                    ForEach(draft.lines) { line in
                        LineEditor(line: Binding(
                            get: { draft.lines.first { $0.id == line.id } ?? line },
                            set: { updated in
                                if let i = draft.lines.firstIndex(where: { $0.id == updated.id }) { draft.lines[i] = updated }
                            }
                        ), catalog: catalog, issueDate: APIDate.dayString(startDate), showsVat: sellerRegistered)
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { draft.lines[$0].id }
                        Task { @MainActor in withAnimation { draft.lines.removeAll { ids.contains($0.id) } } }
                    }
                    Button { withAnimation { draft.lines.append(.new(sellerRegistered: sellerRegistered)) } } label: { Label("Lisää rivi", systemImage: "plus") }
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .formKeyboard()
            .navigationTitle(existing == nil ? "Uusi toistuva lasku" : "Muokkaa toistuvaa laskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Luo" : "Tallenna") { Task { await save() } }.disabled(busy)
                }
            }
            .sheet(isPresented: $showNewCustomer) {
                CustomerFormSheet(existing: nil) { created in
                    customers.append(created)
                    draft.customerId = created.id
                    draft.paymentTermDays = created.defaultPaymentTermDays
                }
            }
            .confirmationDialog("Hylätäänkö muutokset?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Hylkää muutokset", role: .destructive) { dismiss() }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text("Muutoksia ei ole tallennettu.")
            }
            // A start date moved into 2026 turns old 14 % lines into 13,5 % (as the web form does).
            .onChange(of: startDate) { _, date in
                draft.lines.adjustVatRates(issueDate: APIDate.dayString(date))
            }
            .task { await prepare() }
            .interactiveDismissDisabled(busy || dirty)
        }
    }

    /// The draft with the picked dates, as it would be sent.
    private var snapshot: RecurringDraft {
        var current = draft
        current.startDate = APIDate.dayString(startDate)
        current.endDate = hasEnd ? APIDate.dayString(endDate) : nil
        return current
    }

    private var dirty: Bool {
        guard let baseline else { return false }
        return snapshot != baseline
    }

    /// Picking a customer on a new schedule brings that customer's payment term along.
    private func pickCustomer(_ id: String) {
        draft.customerId = id
        if existing == nil, let c = customers.first(where: { $0.id == id }) { draft.paymentTermDays = c.defaultPaymentTermDays }
    }

    private func prepare() async {
        guard !loaded else { return }
        loaded = true
        if let existing {
            draft = RecurringDraft(existing)
            startDate = APIDate.day(draft.startDate) ?? Date()
            if let end = draft.endDate, let date = APIDate.day(end) {
                hasEnd = true
                endDate = date
            }
        }
        let api = app.api
        async let customerList: CustomerList? = try? api.get("/api/customers")
        async let catalogList: CatalogList? = try? api.get("/api/catalog")
        async let profile = app.cachedProfile()
        if let list = await customerList {
            customers = list.customers.filter { $0.archivedAt == nil || $0.id == draft.customerId }
        }
        if let list = await catalogList { catalog = list.items }
        if let profile = await profile { sellerRegistered = profile.vatRegistered }
        draft.lines.followSellerVat(registered: sellerRegistered)
        baseline = snapshot
    }

    private func save() async {
        draft.startDate = APIDate.dayString(startDate)
        draft.lines.followSellerVat(registered: sellerRegistered)
        draft.endDate = hasEnd ? APIDate.dayString(endDate) : nil
        if let problem = draft.validationError { failure = problem; Haptics.error(); return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            if let existing {
                let _: Ignored = try await app.api.send("PATCH", "/api/recurring-invoices/\(existing.id)", body: draft)
            } else {
                let _: Ignored = try await app.api.send("POST", "/api/recurring-invoices", body: draft)
            }
            Haptics.success()
            baseline = snapshot
            onSaved(existing == nil ? "Toistuva lasku luotiin" : "Muutokset tallennettiin")
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
