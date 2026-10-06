import SwiftUI
import LashKirjaCore

/// Toistuvat ostolaskut: rent and other routine bills that become a purchase invoice every period.
struct RecurringPurchasesView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<RecurringPurchaseList>()
    @State private var gate = ReloadGate()
    /// The server does not have the feature yet (its list answered 404).
    @State private var unavailable = false
    @State private var notice: String?
    @State private var createdInvoiceId: String?
    @State private var showNew = false
    @State private var editTarget: RecurringPurchase?
    @State private var deleteTarget: RecurringPurchase?
    /// The pushed template, kept apart from the rows so a reload does not pop it.
    @State private var selected: RecurringPurchase?
    @State private var pushed: Route?
    @State private var busy = false
    @State private var limit = ShowMore()

    var body: some View {
        List {
            if unavailable {
                Section {
                    ContentUnavailableView {
                        Label("Tulossa pian", systemImage: "clock")
                    } description: {
                        Text(RecurringPurchaseText.unavailable)
                    }
                }
                .listRowBackground(Color.clear)
            } else if let list = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                content(list)
            } else {
                ScreenStateView(state: state, retry: load) { (_: RecurringPurchaseList) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(RecurringPurchaseText.title)
        .toolbar {
            if !unavailable {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Uusi toistuva ostolasku")
                }
            }
        }
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
        .disabled(busy)
        .sheet(isPresented: $showNew) {
            RecurringPurchaseFormSheet(existing: nil) { message in show(message) }
        }
        .sheet(item: $editTarget) { entry in
            RecurringPurchaseFormSheet(existing: entry) { message in show(message) }
        }
        .confirmationDialog(
            "Poistetaanko toistuva ostolasku?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            titleVisibility: .visible,
            presenting: deleteTarget
        ) { entry in
            Button("Poista", role: .destructive) { remove(entry) }
        } message: { entry in
            Text("\(entry.supplierName). \(RecurringPurchaseText.deleteMessage)")
        }
        .navigationDestination(item: $selected) { entry in
            RecurringPurchaseDetailView(recurringId: entry.id, initial: entry)
        }
        .navigationDestination(item: $pushed) { route in RouteScreen(route: route) }
    }

    @ViewBuilder
    private func content(_ list: RecurringPurchaseList) -> some View {
        let rows = list.ordered.filter { !app.removedIds.contains($0.id) }
        if let notice {
            Section {
                Text(notice).font(.subheadline)
                if let createdInvoiceId {
                    NavigationLink(value: Route.purchaseInvoice(createdInvoiceId)) { Text("Avaa ostolasku") }
                }
            }
            .listRowBackground(Theme.accentSoft)
        }
        if rows.isEmpty {
            Section {
                ContentUnavailableView {
                    Label("Ei toistuvia ostolaskuja", systemImage: "repeat")
                } description: {
                    Text("Vuokra ja muut säännölliset kulut tulevat ostolaskuiksi itsestään joka kerta.")
                } actions: {
                    Button("Uusi toistuva ostolasku") { showNew = true }.buttonStyle(.primary)
                }
            }
            .listRowBackground(Color.clear)
        } else {
            Section {
                ForEach(rows.prefix(limit.visible(rows.count))) { entry in
                    Button { selected = entry } label: { row(entry) }
                        .foregroundStyle(Theme.ink)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { deleteTarget = entry } label: { Label("Poista", systemImage: "trash") }
                            Button { Task { await toggle(entry) } } label: {
                                Label(entry.active ? "Pysäytä" : "Jatka", systemImage: entry.active ? "pause.circle" : "play.circle")
                            }
                            .tint(Theme.neutralFill)
                        }
                        .swipeActions(edge: .leading) {
                            if entry.active {
                                Button { Task { await run(entry) } } label: { Label("Luo nyt", systemImage: "bolt") }
                                    .tint(Theme.accentFill)
                            }
                        }
                        .contextMenu { menu(entry) }
                }
                ShowMoreButton(limit: $limit, total: rows.count)
            } footer: {
                Text("Ostolasku tehdään itsestään joka kaudelle. Pyyhkäise riviä pysäyttääksesi, luodaksesi heti tai poistaaksesi.")
            }
        }
    }

    @ViewBuilder
    private func menu(_ entry: RecurringPurchase) -> some View {
        Button { editTarget = entry } label: { Label("Muokkaa", systemImage: "pencil") }
        if entry.active {
            Button { Task { await run(entry) } } label: { Label("Luo nyt", systemImage: "bolt") }
        }
        Button { Task { await toggle(entry) } } label: {
            Label(entry.active ? "Pysäytä" : "Jatka", systemImage: entry.active ? "pause.circle" : "play.circle")
        }
        if let last = entry.lastInvoice {
            Button { pushed = .purchaseInvoice(last.id) } label: { Label("Avaa viimeisin ostolasku", systemImage: "doc.text") }
        }
        Button(role: .destructive) { deleteTarget = entry } label: { Label("Poista", systemImage: "trash") }
    }

    private func row(_ entry: RecurringPurchase) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.supplierName).lineLimitUnlessLarge()
                Text(entry.secondary(today: APIDate.dayString(Date()))).font(.caption).foregroundStyle(Theme.ink2).lineLimit(2)
                if let last = entry.lastInvoice {
                    Text("Viimeisin \(APIDate.displayDay(last.issueDate))").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                MoneyText(amount: entry.grossAmount).font(.subheadline.weight(.semibold))
                if !entry.active { RecurringPausedBadge() }
            }
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func show(_ message: String, invoiceId: String? = nil) {
        withMotion {
            notice = message
            createdInvoiceId = invoiceId
        }
    }

    private func load() async {
        state.begin()
        do {
            let list: RecurringPurchaseList = try await app.api.get("/api/recurring-purchases")
            state.succeed(list)
            unavailable = false
        } catch is CancellationError {
        } catch let error where RecurringPurchaseText.isUnavailable(error) {
            unavailable = true
        } catch {
            state.fail(error)
        }
    }

    private func toggle(_ entry: RecurringPurchase) async {
        busy = true
        defer { busy = false }
        do {
            let message = try await RecurringPurchaseActions.setActive(!entry.active, id: entry.id, app: app)
            Haptics.success()
            show(message)
        } catch {
            Haptics.error()
            show(error.userMessage)
        }
    }

    private func run(_ entry: RecurringPurchase) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await RecurringPurchaseActions.run(id: entry.id, app: app)
            Haptics.success()
            show(result.message, invoiceId: result.purchaseInvoiceId)
        } catch {
            Haptics.error()
            show(error.userMessage)
        }
    }

    private func remove(_ entry: RecurringPurchase) {
        let api = app.api, id = entry.id
        withMotion {
            app.removeInBackground([id]) {
                let _: Ignored = try await api.send("DELETE", "/api/recurring-purchases/\(id)", body: Optional<EmptyBody>.none)
            }
        }
        show("Toistuva ostolasku poistettiin. Jo luodut ostolaskut säilyvät.")
    }
}

/// The writes both the list and the detail make.
@MainActor
enum RecurringPurchaseActions {
    static func setActive(_ active: Bool, id: String, app: AppModel) async throws -> String {
        let _: Ignored = try await app.api.send("PATCH", "/api/recurring-purchases/\(id)", body: RecurringPurchaseActivePatch(active: active))
        return active ? "Toistuva ostolasku jatkuu." : "Toistuva ostolasku pysäytettiin. Uusia ostolaskuja ei luoda ennen kuin jatkat."
    }

    static func run(id: String, app: AppModel) async throws -> RecurringPurchaseRunResult {
        try await app.api.send("POST", "/api/recurring-purchases/\(id)/run", body: EmptyBody())
    }
}

struct RecurringPausedBadge: View {
    var body: some View {
        Text("Pysäytetty")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Theme.ink2.opacity(0.12), in: Capsule())
            .foregroundStyle(Theme.ink2)
    }
}

/// One template with its actions; opened from the list or from an invoice's "Toistuva" badge.
struct RecurringPurchaseDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let recurringId: String
    var initial: RecurringPurchase?

    @State private var fresh: RecurringPurchase?
    @State private var loading = true
    @State private var missing = false
    @State private var unavailable = false
    @State private var busy = false
    @State private var notice: String?
    @State private var createdInvoiceId: String?
    @State private var failure: String?
    @State private var editing = false
    @State private var confirmDelete = false

    private var current: RecurringPurchase? { fresh ?? initial }

    var body: some View {
        List {
            if let entry = current, !missing {
                content(entry)
            } else if unavailable {
                Section { Text(RecurringPurchaseText.unavailable).foregroundStyle(Theme.ink2) }
            } else if missing {
                Section { Text("Toistuva ostolasku on poistettu. Jo luodut ostolaskut säilyvät.").foregroundStyle(Theme.ink2) }
            } else if let failure {
                Section { Text(failure).foregroundStyle(Theme.danger) }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200).listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(current?.supplierName ?? "Toistuva ostolasku")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
        .refreshable { await refresh() }
        .task(id: app.dataVersion) { await refresh() }
        .sheet(isPresented: $editing) {
            if let entry = current {
                RecurringPurchaseFormSheet(existing: entry) { message in notice = message }
            }
        }
        .confirmationDialog("Poistetaanko toistuva ostolasku?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { remove() }
        } message: {
            Text("\(current?.supplierName ?? ""). \(RecurringPurchaseText.deleteMessage)")
        }
    }

    @ViewBuilder
    private func content(_ entry: RecurringPurchase) -> some View {
        if let notice {
            Section {
                Text(notice).font(.subheadline)
                if let createdInvoiceId {
                    NavigationLink(value: Route.purchaseInvoice(createdInvoiceId)) { Text("Avaa ostolasku") }
                }
            }
            .listRowBackground(Theme.accentSoft)
        }
        if let failure {
            Section { Text(failure).font(.footnote).foregroundStyle(Theme.danger) }
        }
        Section {
            LabeledContent("Toisto", value: entry.scheduleText)
            LabeledContent("Seuraava", value: entry.nextRunDate.map(APIDate.displayDay) ?? "Päättynyt")
            if !entry.active { LabeledContent("Tila") { RecurringPausedBadge() } }
            LabeledContent("Eräaika", value: "\(entry.dueDays) pv")
            LabeledContent("Aloitus", value: APIDate.displayDay(entry.startDate))
            if let end = entry.endDate { LabeledContent("Päättyy", value: APIDate.displayDay(end)) }
            LabeledContent("Luotu", value: entry.runCount == 1 ? "1 ostolasku" : "\(entry.runCount) ostolaskua")
        }
        Section {
            LabeledContent("Veroton") { MoneyText(amount: entry.netAmount) }
            LabeledContent("ALV \(PurchaseVatRate.label(entry.vatRate))") { MoneyText(amount: entry.vatAmount) }
            LabeledContent("Yhteensä") { MoneyText(amount: entry.grossAmount).fontWeight(.semibold) }
        }
        Section {
            if let reference = entry.reference, !reference.isEmpty { LabeledContent("Viite", value: reference) }
            if let iban = entry.supplierIban, !iban.isEmpty { LabeledContent("IBAN", value: iban) }
            if let id = entry.supplierBusinessId, !id.isEmpty { LabeledContent("Y-tunnus", value: id) }
            if let category = entry.category, !category.isEmpty { LabeledContent("Kategoria", value: category) }
            if let notes = entry.notes, !notes.isEmpty { Text(notes).font(.subheadline) }
        }
        if let last = entry.lastInvoice {
            Section {
                NavigationLink(value: Route.purchaseInvoice(last.id)) {
                    LabeledContent("Viimeisin ostolasku \(APIDate.displayDay(last.issueDate))") { MoneyText(amount: last.grossAmount) }
                }
            }
        }
        Section {
            if entry.active {
                Button { Task { await run(entry) } } label: { Label("Luo nyt", systemImage: "bolt") }
            }
            Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
            Button { Task { await toggle(entry) } } label: {
                Label(entry.active ? "Pysäytä" : "Jatka", systemImage: entry.active ? "pause.circle" : "play.circle")
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
        } footer: {
            Text("Luo nyt tekee kuluvan kauden ostolaskun heti, jos sitä ei ole vielä tehty.")
        }
    }

    /// There is no single-template route: the list holds it.
    private func refresh() async {
        do {
            let list: RecurringPurchaseList = try await app.api.get("/api/recurring-purchases")
            if let entry = list.recurring.first(where: { $0.id == recurringId }) {
                fresh = entry
                missing = false
            } else {
                missing = true
            }
        } catch is CancellationError {
        } catch let error where RecurringPurchaseText.isUnavailable(error) {
            unavailable = true
        } catch {
            if current == nil { failure = error.userMessage }
        }
    }

    private func toggle(_ entry: RecurringPurchase) async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            notice = try await RecurringPurchaseActions.setActive(!entry.active, id: entry.id, app: app)
            createdInvoiceId = nil
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func run(_ entry: RecurringPurchase) async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let result = try await RecurringPurchaseActions.run(id: entry.id, app: app)
            notice = result.message
            createdInvoiceId = result.purchaseInvoiceId
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func remove() {
        let api = app.api, id = recurringId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/recurring-purchases/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }
}

/// New template, an edit of one (`existing`), or one made from an invoice (`prefill`).
struct RecurringPurchaseFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: RecurringPurchase?
    var prefill: RecurringPurchaseForm?
    let onSaved: (String) -> Void

    @State private var form = RecurringPurchaseForm(today: APIDate.dayString(Date()))
    @State private var errors: [RecurringPurchaseForm.Field: String] = [:]
    @State private var failure: String?
    @State private var busy = false
    @State private var key = UUID().uuidString
    @State private var prepared = false
    @State private var baseline: RecurringPurchaseForm?
    @State private var confirmDiscard = false

    private var dirty: Bool { baseline.map { $0 != form } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section("Toimittaja") {
                    TextField("Toimittaja", text: $form.supplierName, prompt: Text("Kiinteistö Oy"))
                        .textInputAutocapitalization(.words)
                    fieldError(.supplierName)
                    LabeledContent("Y-tunnus") {
                        TextField("1234567-8", text: $form.businessId)
                            .multilineTextAlignment(.trailing)
                            .codeInput(.never)
                    }
                    fieldError(.businessId)
                    LabeledContent("IBAN") {
                        TextField("FI…", text: $form.iban)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }
                    fieldError(.iban)
                }

                Section {
                    LabeledContent("Summa (€)") {
                        TextField("850,00", text: $form.gross)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.gross)
                    Picker("ALV-kanta", selection: $form.vatRate) {
                        ForEach(PurchaseVatRate.allowed, id: \.self) { Text(PurchaseVatRate.label($0)).tag($0) }
                    }
                } header: {
                    Text("Summa")
                } footer: {
                    if let gross = form.grossValue, gross > 0 {
                        let split = PurchaseVatRate.split(gross: gross, rate: form.vatRate)
                        Text("Veroton \(Money.format(split.net)) · ALV \(Money.format(split.vat))")
                    }
                }

                Section {
                    Picker("Toistuvuus", selection: $form.interval) {
                        ForEach(RecurrenceInterval.allCases) { Text($0.label).tag($0) }
                    }
                    Stepper("Päivä \(form.dayOfMonth).", value: $form.dayOfMonth, in: 1...28)
                    fieldError(.dayOfMonth)
                    Stepper("Eräaika \(form.dueDays) pv", value: $form.dueDays, in: 0...90)
                    fieldError(.dueDays)
                    DatePicker("Aloitus", selection: dayBinding(\.startDate), displayedComponents: .date)
                    Toggle("Päättymispäivä", isOn: hasEnd).tint(Theme.accent)
                    if form.endDate != nil {
                        DatePicker("Päättyy", selection: endBinding, displayedComponents: .date)
                    }
                    fieldError(.endDate)
                } header: {
                    Text("Toisto")
                } footer: {
                    if existing == nil, let preview = form.preview(today: APIDate.dayString(Date())) { Text(preview) }
                }

                Section {
                    LabeledContent("Viitenumero") {
                        TextField("", text: $form.reference)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.reference)
                    LabeledContent("Kategoria") {
                        TextField("Vuokra", text: $form.category)
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.category)
                } header: {
                    Text("Tunnisteet")
                } footer: {
                    Text("Kiinteä viitenumero, esim. vuokran, kohdistaa maksun pankista automaattisesti.")
                }

                Section("Muistiinpano") {
                    TextField("Muistiinpano (valinnainen)", text: $form.notes, axis: .vertical)
                        .lineLimit(2...5)
                    fieldError(.notes)
                }

                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle(existing == nil ? "Uusi toistuva ostolasku" : "Muokkaa toistuvaa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Luo" : "Tallenna") { Task { await save() } }
                        .disabled(busy)
                }
            }
            .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
            .onAppear {
                guard !prepared else { return }
                prepared = true
                if let existing { form = RecurringPurchaseForm(editing: existing) } else if let prefill { form = prefill }
                // A prefilled form is not yet the owner's change, so it counts as the starting point.
                baseline = form
            }
        }
    }

    @ViewBuilder
    private func fieldError(_ field: RecurringPurchaseForm.Field) -> some View {
        if let message = errors[field] {
            Text(message).font(.footnote).foregroundStyle(Theme.danger)
        }
    }

    private func dayBinding(_ keyPath: WritableKeyPath<RecurringPurchaseForm, String>) -> Binding<Date> {
        Binding(
            get: { APIDate.day(form[keyPath: keyPath]) ?? Date() },
            set: { form[keyPath: keyPath] = APIDate.dayString($0) }
        )
    }

    private var hasEnd: Binding<Bool> {
        Binding(
            get: { form.endDate != nil },
            set: { form.endDate = $0 ? (form.endDate ?? form.startDate) : nil }
        )
    }

    private var endBinding: Binding<Date> {
        Binding(
            get: { form.endDate.flatMap(APIDate.day) ?? Date() },
            set: { form.endDate = APIDate.dayString($0) }
        )
    }

    private func save() async {
        guard !busy else { return }
        let validation = form.validate()
        errors = validation.errors
        failure = nil
        guard let input = validation.input else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        do {
            if let existing {
                let _: Ignored = try await app.api.send("PATCH", "/api/recurring-purchases/\(existing.id)", body: input.body(forEdit: true))
            } else {
                let _: Ignored = try await app.api.send("POST", "/api/recurring-purchases", body: input.body(forEdit: false), idempotencyKey: key)
            }
            Haptics.success()
            baseline = form
            onSaved(existing == nil ? "Toistuva ostolasku luotiin." : "Muutokset tallennettiin.")
            dismiss()
        } catch is CancellationError {
        } catch {
            Haptics.error()
            if RecurringPurchaseText.isUnavailable(error) && existing == nil {
                failure = RecurringPurchaseText.unavailable
                return
            }
            // A refusal that names a field is shown at that field.
            var routed: [RecurringPurchaseForm.Field: String] = [:]
            if let lk = error as? LKError {
                for (name, message) in lk.fields {
                    if let field = RecurringPurchaseForm.Field(rawValue: name) { routed[field] = message }
                }
            }
            if routed.isEmpty { failure = error.userMessage } else { errors = routed }
        }
    }
}
