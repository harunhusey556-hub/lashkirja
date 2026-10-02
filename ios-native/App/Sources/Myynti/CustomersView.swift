import SwiftUI
import UniformTypeIdentifiers
import LashKirjaCore

struct CustomersView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[Customer]> = .idle
    @State private var search = ""
    @State private var showNew = false
    @State private var showImport = false
    @State private var notice: String?

    var body: some View {
        List {
            if let notice { Section { Text(notice).font(.subheadline) } }
            if let customers = state.value {
                let rows = customers.filter { !app.removedIds.contains($0.id) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }
                if rows.isEmpty { Text("Ei asiakkaita.").foregroundStyle(Theme.ink2) }
                ForEach(rows) { customer in
                    NavigationLink(value: Route.customer(customer.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(customer.name)
                            Text([customer.businessId, "Maksuaika \(customer.defaultPaymentTermDays) pv"].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                }
            } else {
                LoadState(state: state, retry: load) { (_: [Customer]) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .searchable(text: $search, prompt: "Hae asiakasta")
        .navigationTitle("Asiakkaat")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showNew = true } label: { Label("Uusi asiakas", systemImage: "person.badge.plus") }
                    Button { showImport = true } label: { Label("Tuo CSV", systemImage: "square.and.arrow.down") }
                } label: { Image(systemName: "plus") }
                .accessibilityLabel("Lisää asiakkaita")
            }
        }
        .sheet(isPresented: $showNew) { CustomerFormSheet(existing: nil) { _ in Task { await load() } } }
        .sheet(isPresented: $showImport) {
            CustomerImportSheet { created in
                notice = CustomerImportResult.createdText(created)
                Task { await load() }
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let list: CustomerList = try await app.api.get("/api/customers")
            state = .loaded(list.customers.filter { $0.archivedAt == nil })
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }
}

struct CustomerDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let customerId: String
    @State private var state: Loadable<CustomerDetail> = .idle
    @State private var showEdit = false
    @State private var showNewInvoice = false
    @State private var confirmDelete = false
    @State private var failure: String?
    @State private var notice: String?
    @State private var showMerge = false
    @State private var others: [Customer] = []
    /// A just-created invoice, opened when the form's sheet has closed.
    @State private var createdId: String?
    @State private var openedInvoiceId: String?

    var body: some View {
        List {
            if let detail = state.value {
                let c = detail.customer
                Section {
                    if let contact = c.contactPerson { LabeledContent("Yhteyshenkilö", value: contact) }
                    if let email = c.email { LabeledContent("Sähköposti", value: email) }
                    if let phone = c.phone { LabeledContent("Puhelin", value: phone) }
                    if let address = c.address { LabeledContent("Osoite", value: address) }
                    if let id = c.businessId { LabeledContent("Y-tunnus", value: id) }
                    LabeledContent("Maksuaika", value: "\(c.defaultPaymentTermDays) pv")
                }
                Section {
                    LabeledContent("Laskutettu yhteensä") { MoneyText(amount: detail.invoicedTotal) }
                    LabeledContent("Avoinna") { MoneyText(amount: detail.openBalance) }
                    Button { showNewInvoice = true } label: { Label("Uusi lasku asiakkaalle", systemImage: "doc.badge.plus") }
                }
                if !detail.invoices.isEmpty {
                    Section("Laskut") {
                        ForEach(detail.invoices) { invoice in
                            NavigationLink(value: Route.invoice(invoice.id)) {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text("Lasku \(invoice.number)")
                                        Text(APIDate.displayDay(invoice.issueDate)).font(.caption).foregroundStyle(Theme.ink2)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing) {
                                        MoneyText(amount: invoice.gross)
                                        StatusBadge(status: invoice.displayStatus)
                                    }
                                }
                            }
                        }
                    }
                }
                if let notes = c.notes { Section("Muistiinpanot") { Text(notes) } }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                if let notice { Text(notice).foregroundStyle(Theme.success) }
            } else {
                LoadState(state: state, retry: load) { (_: CustomerDetail) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(state.value?.customer.name ?? "Asiakas")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if state.value != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showEdit = true } label: { Label("Muokkaa", systemImage: "pencil") }
                        if let businessId = state.value?.customer.businessId {
                            Button { UIPasteboard.general.string = businessId } label: { Label("Kopioi Y-tunnus", systemImage: "doc.on.doc") }
                        }
                        if !others.isEmpty {
                            Button { showMerge = true } label: { Label("Yhdistä kaksoiskappale", systemImage: "arrow.triangle.merge") }
                        }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
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
                openedInvoiceId = id
            }
        }) {
            InvoiceFormView(existing: nil, presetCustomerId: customerId, onCreated: { id in createdId = id })
        }
        .navigationDestination(item: $openedInvoiceId) { id in InvoiceDetailView(invoiceId: id) }
        .sheet(isPresented: $showMerge) {
            CustomerMergeSheet(keepId: customerId, others: others) {
                notice = "Asiakkaat yhdistettiin. Kaksoiskappale arkistoitiin."
                Task { await load() }
            }
        }
        .confirmationDialog("Poistetaanko asiakas?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await delete() } }
        }
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await app.api.get("/api/customers/\(customerId)"))
            // Merge candidates: every other customer still in use.
            if let list: CustomerList = try? await app.api.get("/api/customers") {
                others = list.customers.filter { $0.id != customerId && $0.archivedAt == nil }
            }
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    private func delete() async {
        let api = app.api, id = customerId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/customers/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }
}

struct CustomerFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: Customer?
    let onSaved: (Customer) -> Void
    @State private var draft = CustomerDraft()
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString
    /// The form as it opened; anything else is an unsaved change.
    @State private var baseline: CustomerDraft?
    @State private var confirmDiscard = false

    private var dirty: Bool { baseline.map { $0 != draft } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Nimi", text: $draft.name)
                    TextField("Y-tunnus (valinnainen)", text: $draft.businessId)
                    TextField("Yhteyshenkilö (valinnainen)", text: $draft.contactPerson)
                }
                Section {
                    TextField("Sähköposti", text: $draft.email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    TextField("Puhelin", text: $draft.phone).keyboardType(.phonePad)
                }
                Section("Osoite") {
                    TextField("Katuosoite", text: $draft.addressStreet)
                    TextField("Postinumero", text: $draft.addressPostalCode).keyboardType(.numberPad)
                    TextField("Kaupunki", text: $draft.addressCity)
                }
                Section {
                    Stepper("Maksuaika \(draft.defaultPaymentTermDays) pv", value: $draft.defaultPaymentTermDays, in: 0...365, step: 7)
                    TextField("Muistiinpanot", text: $draft.notes, axis: .vertical)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            }
            .navigationTitle(existing == nil ? "Uusi asiakas" : "Muokkaa asiakasta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }.disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .confirmationDialog("Hylätäänkö muutokset?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Hylkää muutokset", role: .destructive) { dismiss() }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text("Muutoksia ei ole tallennettu.")
            }
            .onAppear {
                // Once: a second onAppear must not overwrite what the owner has typed.
                guard baseline == nil else { return }
                if let existing {
                    draft = CustomerDraft(existing)
                    draft.clearsEmptyFields = true
                }
                baseline = draft
            }
            .interactiveDismissDisabled(busy || dirty)
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            let r: CustomerResponse
            if let existing {
                r = try await app.api.send("PATCH", "/api/customers/\(existing.id)", body: draft)
            } else {
                r = try await app.api.send("POST", "/api/customers", body: draft, idempotencyKey: key)
            }
            Haptics.success()
            baseline = draft
            onSaved(r.customer)
            dismiss()
        } catch {
            failure = error.userMessage
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
                        .onChange(of: csv) { _, _ in result = nil }
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
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
                if let result {
                    Section {
                        ForEach(result.rows) { row in
                            Text(row.text).font(.caption).foregroundStyle(row.isValid ? Theme.ink : Theme.danger)
                        }
                    } header: {
                        Text(result.statusText)
                    }
                }
            }
            .navigationTitle("Tuo asiakkaita")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                if busy { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.commaSeparatedText, .plainText, .text, .data]) { picked in
                if case .success(let url) = picked { read(url) }
            }
            .interactiveDismissDisabled(busy)
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
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Yhdistä kaksoiskappale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Yhdistä tähän") { Task { await merge() } }.disabled(busy || mergeId.isEmpty)
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium])
    }

    private func merge() async {
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
