import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

/// A message for Asiakkaat from a customer screen that closed itself ("Asiakas poistettiin.").
@MainActor enum CustomerFlash {
    static var pending: String?
}

struct CustomersView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<[Customer]>()
    @State private var gate = ReloadGate()
    @State private var search = ""
    @State private var showNew = false
    @State private var showImport = false
    @State private var notice: String?
    @State private var limit = ShowMore()
    /// "Myös arkistoidut": the archived customers are listed too, marked as such.
    @State private var includeArchived = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 8) {
                    SectionChip(title: "Aktiiviset", selected: !includeArchived) { includeArchived = false }
                    SectionChip(title: "Myös arkistoidut", selected: includeArchived) { includeArchived = true }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
            }
            if let customers = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                let rows = customers.filter { !app.removedIds.contains($0.id) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }
                Section {
                    if rows.isEmpty { Text(search.isEmpty ? "Ei asiakkaita." : "Ei osumia.").foregroundStyle(Theme.ink2) }
                    ForEach(rows.prefix(limit.visible(rows.count))) { customer in
                        NavigationLink(value: Route.customer(customer.id)) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(customer.name)
                                    Text([customer.businessId, "Maksuaika \(customer.defaultPaymentTermDays) pv"].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(Theme.ink2)
                                }
                                Spacer()
                                if customer.isArchived { ArchivedBadge() }
                            }
                        }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                }
            } else {
                ScreenStateView(state: state, retry: load) { (_: [Customer]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .noticeToast($notice)
        .searchable(text: $search, prompt: "Hae asiakasta")
        .onChange(of: search) { _, _ in limit.reset() }
        .onChange(of: includeArchived) { _, _ in limit.reset() }
        .navigationTitle("Asiakkaat")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button { showImport = true } label: { Label("Tuo CSV", systemImage: "square.and.arrow.down") }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("Toiminnot")
                // "+" adds a customer at once (X029): it opened a menu with the import beside it, two taps.
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Uusi asiakas")
            }
        }
        .sheet(isPresented: $showNew) { CustomerFormSheet(existing: nil) { _ in Task { await load() } } }
        .sheet(isPresented: $showImport) {
            CustomerImportSheet { created in
                notice = CustomerImportResult.createdText(created)
                Task { await load() }
            }
        }
        .refreshable { await load(force: true) }
        .onAppear {
            if let flash = CustomerFlash.pending {
                CustomerFlash.pending = nil
                notice = flash
            }
        }
        // A customer archived, restored or deleted elsewhere moves between the two lists.
        .task(id: "\(app.dataVersion)|\(includeArchived)") {
            let key = includeArchived ? "all" : "active"
            guard state.value == nil || gate.isDue(key: key, version: app.dataVersion) else { return }
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: key, version: version) }
        }
    }

    private func load() async { await load(force: false) }

    /// Through the app's cache: the last list at once, then the server's when stale; `force`
    /// (pull-to-refresh) always asks.
    private func load(force: Bool) async {
        let timing = ScreenTiming("Asiakkaat")
        let archived = includeArchived
        let query = CustomerArchive.listQuery(includeArchived: archived)
        if state.value == nil, let cached: CustomerList = await app.cachedValue("/api/customers", query: query) {
            state.succeed(archived ? cached.customers : cached.customers.filter { !$0.isArchived })
            timing.painted(fromCache: true)
        }
        state.begin()
        do {
            let list: CustomerList = try await app.cachedGet("/api/customers", query: query, force: force)
            state.succeed(archived ? list.customers : list.customers.filter { !$0.isArchived })
            // A customer opened from here paints its row in the first frame (`customerPreview`).
            app.rememberPainted(list, "/api/customers", query: query)
            timing.dataReady()
            warmDetails(state.value ?? [])
            app.indexForSpotlight(list.customers.filter { !$0.isArchived }.compactMap {
                SpotlightEntry.customer(id: $0.id, name: $0.name, businessId: $0.businessId)
            })
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    /// The first rows' details into the cache and `lastPainted`, so a customer opened from here
    /// paints its invoices in the first frame too, not only what its row knows (F008).
    private func warmDetails(_ customers: [Customer]) {
        let app = self.app
        let first = customers.filter { !app.removedIds.contains($0.id) }.prefix(5).map(\.id)
        Task {
            for id in first {
                let path = CustomerDetailView.path(id)
                if let detail: CustomerDetail = try? await app.cachedGet(path) { app.rememberPainted(detail, path) }
            }
        }
    }
}

struct ArchivedBadge: View {
    var body: some View {
        Text("Arkistoitu")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Theme.ink2.opacity(0.12), in: Capsule())
            .foregroundStyle(Theme.ink2)
    }
}

struct CustomerDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// A created invoice opens on the stack's path: pushed beside it, the invoice's customer opened
    /// under it (G005).
    @Environment(\.openRoute) private var openRoute
    let customerId: String
    /// The customer's row as Asiakkaat painted it (`app.customerPreview`): its name, contact rows and
    /// totals while the invoices load.
    private let row: Customer?
    @State private var state = ScreenLoad<CustomerDetail>()
    @State private var showEdit = false
    @State private var showNewInvoice = false
    @State private var confirmDelete = false
    /// Archive / delete / restore: one at a time, a second tap sends nothing.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var notice: String?
    @State private var showMerge = false
    @State private var others: [Customer] = []
    /// A just-created invoice, opened when the form's sheet has closed.
    @State private var createdId: String?
    @State private var invoiceLimit = ShowMore()

    /// `detail` (what this screen or Asiakkaat's warm-up last painted, `app.lastPainted`) is on screen
    /// in the first frame, else `row` with the invoices' place held. Loaded in `.task` instead, the
    /// push showed a blank 'Asiakas' page with a spinner, then about 0.9 s later the whole page at
    /// once, and the title changed to the name (F008, motion gate myynti-customer-open).
    init(customerId: String, detail: CustomerDetail? = nil, row: Customer? = nil) {
        self.customerId = customerId
        self.row = row
        guard let detail else { return }
        var shown = ScreenLoad<CustomerDetail>()
        shown.succeed(detail)
        _state = State(initialValue: shown)
    }

    static func path(_ id: String) -> String { "/api/customers/\(id)" }

    /// The loaded customer, else its row.
    private var customer: Customer? { state.value?.customer ?? row }

    var body: some View {
        List {
            if let c = customer {
                let detail: CustomerDetail? = state.value
                // A failed load leaves what is shown, the detail or the row alone, under the banner.
                if let banner = state.failure {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if c.isArchived {
                    Section {
                        HStack {
                            ArchivedBadge()
                            Spacer()
                            Button("Palauta arkistosta") { Task { await restore() } }
                                .buttonStyle(.borderless)
                                .foregroundStyle(Theme.accentDark)
                        }
                    }
                }
                Section {
                    if let contact = c.contactPerson { LabeledContent("Yhteyshenkilö", value: contact) }
                    // Mail, phone and address open Mail, the phone and Maps (web ContactLink).
                    if let email = c.email { contactRow("Sähköposti", email, CustomerContact.mail(email)) }
                    if let phone = c.phone { contactRow("Puhelin", phone, CustomerContact.phone(phone)) }
                    if let address = c.address { contactRow("Osoite", address, CustomerContact.maps(address)) }
                    if let id = c.businessId { LabeledContent("Y-tunnus", value: id) }
                    LabeledContent("Maksuaika", value: "\(c.defaultPaymentTermDays) pv")
                }
                Section {
                    // The row has the same totals as the detail (the server counts both alike).
                    LabeledContent("Laskutettu yhteensä") { total(detail?.invoicedTotal ?? c.invoicedTotal) }
                    LabeledContent("Avoinna") { total(detail?.openBalance ?? c.openBalance) }
                    Button { showNewInvoice = true } label: { Label("Uusi lasku asiakkaalle", systemImage: "doc.badge.plus") }
                }
                // Before the detail, the row's count holds the invoices' place: nothing moves when they come.
                let invoiceCount: Int = detail?.invoices.count ?? (state.failure == nil ? c.invoiceCount ?? 0 : 0)
                if invoiceCount > 0 {
                    Section("Laskut") {
                        if let detail {
                            ForEach(detail.invoices.prefix(invoiceLimit.visible(invoiceCount))) { invoice in
                                NavigationLink(value: Route.invoice(invoice.id)) {
                                    HStack {
                                        // Myynti's line (X027): the invoice date here, unlabelled, read as
                                        // the same day as Myynti's due date.
                                        Text(invoice.rowSecondary)
                                        Spacer()
                                        VStack(alignment: .trailing) {
                                            MoneyText(amount: invoice.gross)
                                            StatusBadge(status: invoice.displayStatus)
                                        }
                                    }
                                }
                            }
                        } else {
                            ForEach(0..<invoiceLimit.visible(invoiceCount), id: \.self) { _ in invoicePlaceholder }
                        }
                        ShowMoreButton(limit: $invoiceLimit, total: invoiceCount)
                        // The customer's invoices on Myynti's status chips (web "Näytä kaikki").
                        NavigationLink(value: Route.invoicesFiltered(month: "", status: "", customerId: c.id)) {
                            Text("Näytä tilan mukaan").foregroundStyle(Theme.accentDark)
                        }
                    }
                }
                if let notes = c.notes { Section("Muistiinpanot") { Text(notes) } }
            } else {
                ScreenStateView(state: state, retry: load) { (_: CustomerDetail) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .failureToast($failure)
        .noticeToast($notice)
        // The greyed invoices give way to the rows eased, as ScreenStateView's swap does: not a cut.
        .motion(.snappy, value: state.value == nil)
        // The banner eases in over what is shown, so the rows under it do not jump.
        .motion(.snappy, value: state.failure != nil)
        .navigationTitle(customer?.name ?? "Asiakas")
        .refreshable { await load(force: true) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // With the row already: the bar does not change when the detail comes.
            if let c = customer {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // Muokkaa and Poista wait for the detail: a row painted earlier may be older.
                        Button { showEdit = true } label: { Label("Muokkaa", systemImage: "pencil") }
                            .disabled(state.value == nil)
                        if let businessId = c.businessId {
                            Button { UIPasteboard.general.string = businessId } label: { Label("Kopioi Y-tunnus", systemImage: "doc.on.doc") }
                        }
                        if !others.isEmpty {
                            Button { showMerge = true } label: { Label("Yhdistä kaksoiskappale", systemImage: "arrow.triangle.merge") }
                        }
                        if c.isArchived {
                            Button { Task { await restore() } } label: { Label("Palauta arkistosta", systemImage: "arrow.uturn.backward") }
                        } else {
                            Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
                                .disabled(state.value == nil)
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Toiminnot")
                }
            }
        }
        .sheet(isPresented: $showEdit, onDismiss: { Task { await load() } }) {
            if let c = state.value?.customer { CustomerFormSheet(existing: c) { _ in } }
        }
        .sheet(isPresented: $showNewInvoice, onDismiss: {
            Task { await load() }
            if let id = createdId {
                createdId = nil
                openRoute(.invoice(id))
            }
        }) {
            InvoiceFormView(existing: nil, presetCustomerId: customerId, preview: app.invoiceFormPreview(), onCreated: { id in createdId = id })
        }
        .sheet(isPresented: $showMerge) {
            CustomerMergeSheet(keepId: customerId, others: others) {
                notice = "Asiakkaat yhdistettiin. Kaksoiskappale arkistoitiin."
                Task { await load() }
            }
        }
        .confirmSheet(
            isPresented: $confirmDelete,
            title: "Poistetaanko asiakas?",
            message: state.value.map {
                CustomerArchive.deleteNote(name: $0.customer.name, invoiceCount: $0.invoices.count, recurringCount: $0.recurringCount ?? 0)
            } ?? "",
            confirmTitle: "Poista"
        ) {
            Task { await delete() }
        }
        .disabled(busy)
        .task { await load() }
    }

    private func load() async { await load(force: false) }

    /// The cached customer at once (opened before, nothing changed since), then the server's
    /// when stale; `force` (pull-to-refresh) always asks.
    private func load(force: Bool) async {
        let path = Self.path(customerId)
        if state.value == nil, let cached: CustomerDetail = await app.cachedValue(path) { state.succeed(cached) }
        state.begin()
        do {
            let detail: CustomerDetail = try await app.cachedGet(path, force: force)
            state.succeed(detail)
            // The next visit's first frame (`init`).
            app.rememberPainted(detail, path)
            // Merge candidates: every other customer still in use.
            if let list: CustomerList = try? await app.cachedGet("/api/customers") {
                others = list.customers.filter { $0.id != customerId && $0.archivedAt == nil }
            }
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    @ViewBuilder
    private func contactRow(_ title: String, _ value: String, _ url: URL?) -> some View {
        if let url {
            Link(destination: url) {
                LabeledContent(title) { Text(value).foregroundStyle(Theme.accentDark).multilineTextAlignment(.trailing) }
            }
            .foregroundStyle(Theme.ink)
        } else {
            LabeledContent(title, value: value)
        }
    }

    /// A total as the detail or the row has it; greyed while neither does.
    @ViewBuilder
    private func total(_ amount: Decimal?) -> some View {
        if let amount {
            MoneyText(amount: amount)
        } else {
            Text("000,00 €").redacted(reason: .placeholder).accessibilityHidden(true)
        }
    }

    /// An invoice row's shape, greyed, until the invoices come: the line, then the sum over the state.
    private var invoicePlaceholder: some View {
        HStack {
            Text("Lasku 0 · eräpäivä 0.00.0000")
            Spacer()
            VStack(alignment: .trailing) {
                Text("000,00 €")
                StatusBadge(status: .sent)
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ladataan laskuja")
    }

    /// Not optimistic: the reply says whether the customer was deleted or archived (it has invoices
    /// or recurring invoices), and an archived one stays on screen with "Palauta arkistosta".
    private func delete() async {
        guard submit.begin() != nil else { return }
        failure = nil
        notice = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let result: CustomerRemoval = try await app.api.send("DELETE", "/api/customers/\(customerId)", body: Optional<EmptyBody>.none)
            succeeded = true
            Haptics.success()
            if result.archived {
                notice = result.message
                await load()
            } else {
                app.hide([customerId])
                CustomerFlash.pending = result.message
                dismiss()
            }
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func restore() async {
        guard submit.begin() != nil else { return }
        failure = nil
        notice = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let _: CustomerResponse = try await app.api.send("PATCH", "/api/customers/\(customerId)", body: CustomerArchive.Restore())
            succeeded = true
            Haptics.success()
            notice = CustomerArchive.restoredText
            await load()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

extension AppModel {
    /// The customer's row as Asiakkaat (or the launch's warm-up) last painted it, in the active list
    /// or the one with the archived; nil when neither holds it.
    func customerPreview(_ id: String) -> Customer? {
        for archived in [false, true] {
            let list: CustomerList? = lastPainted("/api/customers", query: CustomerArchive.listQuery(includeArchived: archived))
            if let row = list?.customers.first(where: { $0.id == id }) { return row }
        }
        return nil
    }
}

struct CustomerFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: Customer?
    let onSaved: (Customer) -> Void
    @State private var draft = CustomerDraft()
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    /// The form as it opened; anything else is an unsaved change.
    @State private var baseline: CustomerDraft?
    @State private var confirmDiscard = false
    private enum Field: Hashable { case name, businessId, contact, email, phone, street, postal, city, notes }
    @FocusState private var focus: Field?

    private var dirty: Bool { baseline.map { $0 != draft } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // A name is not a word to correct: 'Testi Oy' came up underlined in red (U009).
                    TextField("Nimi", text: $draft.name)
                        .textContentType(.organizationName).textInputAutocapitalization(.words).autocorrectionDisabled()
                        .focused($focus, equals: .name).submitLabel(.next).onSubmit { focus = .businessId }
                    TextField("Y-tunnus (valinnainen)", text: $draft.businessId)
                        .codeInput(.never)
                        .focused($focus, equals: .businessId).submitLabel(.next).onSubmit { focus = .contact }
                    TextField("Yhteyshenkilö (valinnainen)", text: $draft.contactPerson)
                        .textContentType(.name).textInputAutocapitalization(.words).autocorrectionDisabled()
                        .focused($focus, equals: .contact).submitLabel(.next).onSubmit { focus = .email }
                }
                Section {
                    TextField("Sähköposti", text: $draft.email)
                        .emailInput()
                        .focused($focus, equals: .email).submitLabel(.next).onSubmit { focus = .phone }
                    TextField("Puhelin", text: $draft.phone)
                        .phoneInput()
                        .focused($focus, equals: .phone)
                }
                Section("Osoite") {
                    TextField("Katuosoite", text: $draft.addressStreet)
                        .textContentType(.streetAddressLine1).textInputAutocapitalization(.words)
                        .focused($focus, equals: .street).submitLabel(.next).onSubmit { focus = .postal }
                    TextField("Postinumero", text: $draft.addressPostalCode)
                        .keyboardType(.numberPad).textContentType(.postalCode)
                        .focused($focus, equals: .postal)
                    TextField("Kaupunki", text: $draft.addressCity)
                        .textContentType(.addressCity).textInputAutocapitalization(.words)
                        .focused($focus, equals: .city).submitLabel(.next).onSubmit { focus = .notes }
                }
                Section {
                    Stepper("Maksuaika \(draft.defaultPaymentTermDays) pv", value: $draft.defaultPaymentTermDays, in: 0...365, step: 7)
                    TextField("Muistiinpanot", text: $draft.notes, axis: .vertical)
                        .focused($focus, equals: .notes)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .formKeyboard()
            .navigationTitle(existing == nil ? "Uusi asiakas" : "Muokkaa asiakasta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { InFlightLabel("Tallenna", inFlight: busy) }.disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
            .onAppear {
                // Once: a second onAppear must not overwrite what the owner has typed.
                guard baseline == nil else { return }
                if let existing {
                    draft = CustomerDraft(existing)
                    draft.clearsEmptyFields = true
                }
                baseline = draft
            }
        }
    }

    private func save() async {
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let r: CustomerResponse
            if let existing {
                r = try await app.api.send("PATCH", "/api/customers/\(existing.id)", body: draft)
            } else {
                r = try await app.api.send("POST", "/api/customers", body: draft, idempotencyKey: key)
            }
            succeeded = true
            Haptics.success()
            baseline = draft
            onSaved(r.customer)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// CSV import: check the file first (`/api/customers/import`), then import the valid rows.
struct CustomerImportSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onImported: (Int) -> Void
    @State private var csv = ""
    @State private var result: CustomerImportResult?
    @State private var picking = false
    @State private var busy = false
    @State private var failure: String?
    /// One key per checked file: a retried "Tuo" (lost answer, second tap) gets the first
    /// import's answer back from the server instead of creating every customer twice.
    @State private var commitKey = UUID().uuidString
    @State private var rowLimit = ShowMore()
    @State private var confirmDiscard = false
    private var dirty: Bool { !csv.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { picking = true } label: { Label("Valitse tiedosto", systemImage: "doc") }
                    TextField("CSV-tiedosto", text: $csv, axis: .vertical)
                        .lineLimit(4...10)
                        .font(.footnote.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: csv) { _, _ in result = nil; rowLimit.reset() }
                } footer: {
                    Text("Valitse CSV-tiedosto tai liitä sen sisältö. Ensimmäinen rivi on otsikko. Erotin voi olla pilkku tai puolipiste.")
                }
                Section {
                    Button { Task { await check() } } label: { Text("Tarkista") }
                        .disabled(busy || csv.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button { Task { await commit() } } label: {
                        Text(commitLabel)
                    }
                    .disabled(busy || (result?.validCount ?? 0) == 0)
                }
                if let result {
                    // Rows to fix first: a long file opens on its first rows only.
                    let rows = result.rows.filter { !$0.isValid } + result.rows.filter(\.isValid)
                    Section {
                        ForEach(rows.prefix(rowLimit.visible(rows.count))) { row in
                            Text(row.text).font(.caption).foregroundStyle(row.isValid ? Theme.ink : Theme.danger)
                        }
                        ShowMoreButton(limit: $rowLimit, total: rows.count)
                    } header: {
                        Text(result.statusText)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .navigationTitle("Tuo asiakkaita")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                if busy { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.commaSeparatedText, .plainText, .text, .data]) { picked in
                if case .success(let url) = picked { read(url) }
            }
            .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
        }
    }

    private var commitLabel: String {
        if let count = result?.validCount, count > 0 { return "Tuo \(count) kelvollista" }
        return "Tuo kelvolliset"
    }

    private func read(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), let text = CustomerImportRequest.text(from: data) else {
            failure = "Tiedostoa ei voitu lukea."
            return
        }
        failure = nil
        csv = text
        Task { await check() }
    }

    private func check() async {
        if let problem = CustomerImportRequest.sizeError(csv) { failure = problem; return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let checked: CustomerImportResult = try await app.api.send("POST", "/api/customers/import", body: CustomerImportRequest(csv: csv, commit: false))
            result = checked
            commitKey = UUID().uuidString
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func commit() async {
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let done: CustomerImportResult = try await app.api.send("POST", "/api/customers/import", body: CustomerImportRequest(csv: csv, commit: true), idempotencyKey: commitKey)
            Haptics.success()
            onImported(done.created)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// "Yhdistä kaksoiskappale": the other customer's invoices and schedules move here; it is archived.
struct CustomerMergeSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let keepId: String
    let others: [Customer]
    let onMerged: () -> Void
    @State private var mergeId = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var confirmMerge = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Yhdistettävä asiakas", selection: $mergeId) {
                        Text("Valitse asiakas").tag("")
                        ForEach(others) { Text($0.name).tag($0.id) }
                    }
                } footer: {
                    Text("Laskut ja toistuvat laskut siirtyvät tälle asiakkaalle. Toinen asiakas arkistoidaan.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .navigationTitle("Yhdistä kaksoiskappale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Yhdistä tähän") { confirmMerge = true }.disabled(busy || mergeId.isEmpty)
                }
            }
            .interactiveDismissDisabled(busy)
            .confirmSheet(
                isPresented: $confirmMerge,
                title: "Yhdistetäänkö asiakkaat?",
                message: "\(others.first { $0.id == mergeId }?.name ?? "Valittu asiakas") arkistoidaan, ja sen laskut siirtyvät tälle asiakkaalle. Tätä ei voi perua.",
                confirmTitle: "Yhdistä ja arkistoi toinen"
            ) {
                Task { await merge() }
            }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.canvas)
    }

    private func merge() async {
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/customers/merge", body: CustomerMergeRequest(keepId: keepId, mergeId: mergeId))
            Haptics.success()
            onMerged()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
