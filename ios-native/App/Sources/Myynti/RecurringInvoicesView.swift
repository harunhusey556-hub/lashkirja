import SwiftUI
import Observation
import LashKirjaCore

/// Recurring invoices (`/toistuvat`): schedules that make an invoice every month, quarter or year.
struct RecurringInvoicesView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<RecurringList> = .idle
    @State private var showInactive = false
    @State private var selected: RecurringInvoice?
    @State private var showNew = false
    @State private var notice: String?
    @State private var runner = RecurringRunner()

    var body: some View {
        List {
            if let list = state.value {
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
                    ForEach(list.recurring) { entry in
                        Button { selected = entry } label: { row(entry) }
                            .foregroundStyle(Theme.ink)
                    }
                }
            } else {
                LoadState(state: state, retry: load) { (_: RecurringList) in EmptyView() }
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
        .task(id: showInactive) { await load() }
        .sheet(isPresented: $showNew) {
            RecurringFormSheet(existing: nil) { message in
                notice = message
                Task { await load() }
            }
        }
        .sheet(item: $selected) { entry in
            RecurringDetailSheet(entry: entry) { message in
                notice = message
                app.dataVersion += 1
                Task { await load() }
            }
        }
        .recurringRunConfirmation(runner: runner) { message in
            notice = message
            app.dataVersion += 1
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
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let list: RecurringList = try await app.api.get("/api/recurring-invoices", query: showInactive ? ["includeInactive": "1"] : [:])
            state = .loaded(list)
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) } else { notice = error.userMessage }
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

/// Everything about one schedule, with its actions.
struct RecurringDetailSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entry: RecurringInvoice
    let onChanged: (String) -> Void
    @State private var busy = false
    @State private var failure: String?
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var runner = RecurringRunner()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Asiakas", value: entry.customer.name)
                    LabeledContent("Toistoväli", value: entry.interval.label)
                    LabeledContent("Laskutuspäivä", value: "\(entry.anchorDay).")
                    LabeledContent("Seuraava", value: entry.nextRunAt.map { RecurringInvoice.scheduleDate($0, today: APIDate.dayString(Date())) } ?? "Päättynyt")
                    LabeledContent("Alkaa", value: APIDate.displayDay(entry.startDate))
                    if let end = entry.endDate { LabeledContent("Päättyy", value: APIDate.displayDay(end)) }
                    LabeledContent("Maksuaika", value: "\(entry.paymentTermDays) pv")
                    LabeledContent("Lähetys", value: entry.autoSend ? "Sähköpostilla automaattisesti" : "Jää luonnokseksi")
                    LabeledContent("Luotu", value: "\(entry.generatedCount) laskua")
                    LabeledContent("Yhteensä (veroton)") { MoneyText(amount: entry.total) }
                }
                ForEach(entry.failedSends, id: \.invoiceId) { failed in
                    Section {
                        Text("Laskun \(APIDate.displayDay(failed.issueDate)) automaattinen lähetys epäonnistui. Lasku on tallessa luonnoksena.")
                        NavigationLink(value: Route.invoice(failed.invoiceId)) { Text("Avaa lasku ja lähetä") }
                    }
                }
                if let missed = entry.missedText {
                    Section {
                        Text(missed)
                        NavigationLink(value: Route.periods) { Text("Avaa kaudet") }
                    }
                }
                Section("Rivit") {
                    ForEach(entry.lines) { line in
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
                }
                if let last = entry.lastRun, let invoiceId = last.invoiceId {
                    Section {
                        NavigationLink(value: Route.invoice(invoiceId)) {
                            Text("Avaa viimeisin lasku (\(APIDate.displayDay(last.issueDate)))")
                        }
                    }
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
                Section {
                    if entry.isDue(today: APIDate.dayString(Date())) {
                        Button {
                            Task { await runner.preview(app: app, scope: entry.id) }
                        } label: {
                            Label(runner.checking ? "Tarkistetaan…" : "Luo lasku nyt", systemImage: "bolt")
                        }
                        .disabled(busy || runner.checking || runner.running)
                    }
                    Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
                    Button { Task { await toggleActive() } } label: {
                        Label(entry.active ? "Pysäytä" : "Jatka", systemImage: entry.active ? "pause.circle" : "play.circle")
                    }
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
                }
                .disabled(busy)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle(entry.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Sulje") { dismiss() } }
            }
            .appDestinations()
            .sheet(isPresented: $editing) {
                RecurringFormSheet(existing: entry) { message in
                    onChanged(message)
                    dismiss()
                }
            }
            .confirmationDialog("Poistetaanko toistuva lasku?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Poista", role: .destructive) { Task { await remove() } }
            } message: {
                Text("\(entry.title). Jo luodut laskut säilyvät.")
            }
            .recurringRunConfirmation(runner: runner) { message in
                onChanged(message)
                dismiss()
            }
        }
    }

    private func toggleActive() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let response: RecurringResponse = try await app.api.send("PATCH", "/api/recurring-invoices/\(entry.id)", body: RecurringActivePatch(active: !entry.active))
            Haptics.success()
            onChanged(response.recurring.active ? "Toistuva lasku jatkuu" : "Toistuva lasku pysäytettiin")
            dismiss()
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
            let _: Ignored = try await app.api.send("DELETE", "/api/recurring-invoices/\(entry.id)", body: Optional<EmptyBody>.none)
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

    var body: some View {
        NavigationStack {
            Form {
                Section("Asiakas") {
                    Picker("Asiakas", selection: $draft.customerId) {
                        Text("Valitse asiakas").tag("")
                        ForEach(customers) { Text($0.name).tag($0.id) }
                    }
                    .onChange(of: draft.customerId) { _, id in
                        if existing == nil, let c = customers.first(where: { $0.id == id }) { draft.paymentTermDays = c.defaultPaymentTermDays }
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
                    ForEach($draft.lines) { $line in
                        LineEditor(line: $line, catalog: catalog, issueDate: APIDate.dayString(startDate), showsVat: sellerRegistered)
                    }
                    .onDelete { draft.lines.remove(atOffsets: $0) }
                    Button { withAnimation { draft.lines.append(.new(sellerRegistered: sellerRegistered)) } } label: { Label("Lisää rivi", systemImage: "plus") }
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle(existing == nil ? "Uusi toistuva lasku" : "Muokkaa toistuvaa laskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
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
            .task { await prepare() }
            .interactiveDismissDisabled(busy)
        }
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
        if let list: CustomerList = try? await app.api.get("/api/customers") {
            customers = list.customers.filter { $0.archivedAt == nil || $0.id == draft.customerId }
        }
        if let list: CatalogList = try? await app.api.get("/api/catalog") { catalog = list.items }
        if let profile: ProfileResponse = try? await app.api.get("/api/profile") { sellerRegistered = profile.profile.vatRegistered }
        draft.lines.followSellerVat(registered: sellerRegistered)
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
            onSaved(existing == nil ? "Toistuva lasku luotiin" : "Muutokset tallennettiin")
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
