import SwiftUI
import LashKirjaCore

struct CustomersView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[Customer]> = .idle
    @State private var search = ""
    @State private var showNew = false

    var body: some View {
        List {
            if let customers = state.value {
                let rows = customers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
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
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { showNew = true } label: { Image(systemName: "plus") }.accessibilityLabel("Uusi asiakas") } }
        .sheet(isPresented: $showNew) { CustomerFormSheet(existing: nil) { _ in Task { await load() } } }
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
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Poista", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .sheet(isPresented: $showEdit, onDismiss: { Task { await load() } }) {
            if let c = state.value?.customer { CustomerFormSheet(existing: c) { _ in } }
        }
        .sheet(isPresented: $showNewInvoice, onDismiss: { Task { await load() } }) { InvoiceFormView(existing: nil, presetCustomerId: customerId) }
        .confirmationDialog("Poistetaanko asiakas?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Poista", role: .destructive) { Task { await delete() } }
        }
        .task { await load() }
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await app.api.get("/api/customers/\(customerId)"))
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    private func delete() async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/customers/\(customerId)", body: Optional<EmptyBody>.none)
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
        }
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
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }.disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                if let existing {
                    draft = CustomerDraft(existing)
                    draft.clearsEmptyFields = true
                }
            }
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
            onSaved(r.customer)
            dismiss()
        } catch {
            failure = error.userMessage
        }
    }
}
