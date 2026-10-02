import SwiftUI
import LashKirjaCore

/// New invoice, or edit of a draft (`existing`).
struct InvoiceFormView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: Invoice?
    var presetCustomerId: String? = nil

    @State private var draft = InvoiceDraft(customerId: "", issueDate: APIDate.dayString(Date()), paymentTermDays: 14)
    @State private var issueDate = Date()
    @State private var customers: [Customer] = []
    @State private var showNewCustomer = false
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString
    @State private var loaded = false
    @State private var catalog: [CatalogItem] = []
    @State private var productNotice: String?

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
                }
                Section("Päivät") {
                    DatePicker("Laskun päivä", selection: $issueDate, displayedComponents: .date)
                    Stepper("Maksuaika \(draft.paymentTermDays) pv", value: $draft.paymentTermDays, in: 0...365, step: 7)
                }
                Section {
                    ForEach($draft.lines) { $line in
                        LineEditor(line: $line, catalog: catalog, issueDate: APIDate.dayString(issueDate)) { saved in
                            Task { await saveProduct(saved) }
                        }
                    }
                    .onDelete { draft.lines.remove(atOffsets: $0) }
                    Button { withAnimation { draft.lines.append(.init()) } } label: { Label("Lisää rivi", systemImage: "plus") }
                } header: {
                    Text("Rivit")
                } footer: {
                    if let productNotice { Text(productNotice) }
                }
                if !catalog.isEmpty {
                    Section {
                        DisclosureGroup("Tallennetut tuotteet (\(catalog.count))") {
                            ForEach(catalog) { item in
                                HStack {
                                    Text(item.name)
                                    Spacer()
                                    MoneyText(amount: item.unitPrice).foregroundStyle(Theme.ink2)
                                }
                                .swipeActions {
                                    Button("Poista", role: .destructive) { Task { await deleteProduct(item) } }
                                }
                            }
                        }
                    } footer: {
                        Text("Pyyhkäise tuotetta vasemmalle poistaaksesi sen valikosta. Laskut, joilla sitä on käytetty, eivät muutu.")
                    }
                }
                Section {
                    let t = draft.totals
                    LabeledContent("Veroton") { MoneyText(amount: t.net) }
                    LabeledContent("ALV") { MoneyText(amount: t.vat) }
                    LabeledContent("Yhteensä") { MoneyText(amount: t.gross).fontWeight(.semibold) }
                }
                Section("Lisätiedot") {
                    TextField("Viesti laskulle (valinnainen)", text: $draft.notes, axis: .vertical).lineLimit(2...5)
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle(existing == nil ? "Uusi lasku" : "Muokkaa laskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Luo lasku" : "Tallenna") { Task { await save() } }.disabled(busy)
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
        if let list: CustomerList = try? await app.api.get("/api/customers") { customers = list.customers.filter { $0.archivedAt == nil } }
        // The form works without the catalog; the product picker just stays hidden.
        if let list: CatalogList = try? await app.api.get("/api/catalog") { catalog = list.items }
        if let existing {
            draft.customerId = existing.customer.id
            draft.issueDate = existing.issueDate
            issueDate = APIDate.day(existing.issueDate) ?? Date()
            if let issue = APIDate.day(existing.issueDate), let due = APIDate.day(existing.dueDate) {
                draft.paymentTermDays = max(0, Calendar.current.dateComponents([.day], from: issue, to: due).day ?? 14)
            }
            draft.notes = existing.notes ?? ""
            draft.lines = existing.lines.map { .init(description: $0.description, quantity: $0.quantity, unit: $0.unit, unitPrice: $0.unitPrice, vatRate: $0.vatRate) }
        } else {
            if let presetCustomerId { draft.customerId = presetCustomerId }
            if draft.lines.isEmpty { draft.lines = [.init()] }
        }
    }

    /// "Tallenna tuotteeksi": the line becomes a catalog product for later invoices.
    private func saveProduct(_ line: InvoiceDraft.Line) async {
        let product = CatalogItemDraft(line: line)
        if let problem = product.validationError { productNotice = problem; Haptics.error(); return }
        do {
            let response: CatalogItemResponse = try await app.api.send("POST", "/api/catalog", body: product)
            catalog = (catalog + [response.item]).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            productNotice = "Tuote \(response.item.name) tallennettiin."
            Haptics.success()
        } catch {
            productNotice = error.userMessage
            Haptics.error()
        }
    }

    /// Archived on the server: gone from the picker, existing invoice lines are untouched.
    private func deleteProduct(_ item: CatalogItem) async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/catalog/\(item.id)", body: Optional<EmptyBody>.none)
            withAnimation { catalog.removeAll { $0.id == item.id } }
            productNotice = "Tuote \(item.name) poistettiin valikosta."
            Haptics.success()
        } catch {
            productNotice = error.userMessage
            Haptics.error()
        }
    }

    private func save() async {
        draft.issueDate = APIDate.dayString(issueDate)
        if let problem = draft.validationError { failure = problem; Haptics.error(); return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            if let existing {
                let _: InvoiceResponse = try await app.api.send("PATCH", "/api/invoices/\(existing.id)", body: InvoicePatch(draft: draft, expectedUpdatedAt: existing.updatedAt))
            } else {
                let _: InvoiceResponse = try await app.api.send("POST", "/api/invoices", body: draft, idempotencyKey: key)
            }
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// One invoice line. Shared by the invoice and the recurring invoice forms.
struct LineEditor: View {
    @Binding var line: InvoiceDraft.Line
    var catalog: [CatalogItem] = []
    var issueDate: String = APIDate.dayString(Date())
    var onSaveProduct: ((InvoiceDraft.Line) -> Void)? = nil
    @State private var priceText = ""
    @State private var quantityText = ""
    // An emptied or unreadable field counts as 0, never as the value typed before it.
    static let rates: [Decimal] = [Decimal(string: "25.5")!, 14, Decimal(string: "13.5")!, 10, 0]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !catalog.isEmpty {
                Menu {
                    ForEach(catalog) { item in
                        Button("\(item.name) · \(Money.format(item.unitPrice))") {
                            line.apply(item, issueDate: issueDate)
                            Haptics.selection()
                        }
                    }
                } label: {
                    Label("Valitse tuote", systemImage: "shippingbox")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
            }
            TextField("Kuvaus", text: $line.description)
            HStack {
                TextField("Määrä", text: $quantityText).keyboardType(.decimalPad).frame(maxWidth: 70)
                    .onChange(of: quantityText) { _, t in line.quantity = Money.parse(t) ?? 0 }
                TextField("Yksikkö", text: $line.unit).frame(maxWidth: 70)
                TextField("À-hinta €", text: $priceText).keyboardType(.decimalPad)
                    .onChange(of: priceText) { _, t in line.unitPrice = Money.parse(t) ?? 0 }
            }
            Picker("ALV", selection: $line.vatRate) {
                ForEach(Self.rates, id: \.self) { rate in
                    Text("\(Self.text(rate)) %").tag(rate)
                }
            }
            .pickerStyle(.segmented)
            if let onSaveProduct {
                Button { onSaveProduct(line) } label: {
                    Label("Tallenna tuotteeksi", systemImage: "square.and.arrow.down").font(.footnote)
                }
                .buttonStyle(.borderless)
            }
        }
        .onAppear {
            if quantityText.isEmpty { quantityText = Self.text(line.quantity) }
            if priceText.isEmpty && line.unitPrice != 0 { priceText = Self.text(line.unitPrice) }
        }
        // A product picked from the catalog changes the line from outside the text fields.
        .onChange(of: line.unitPrice) { _, value in
            if (Money.parse(priceText) ?? 0) != value { priceText = Self.text(value) }
        }
        .onChange(of: line.quantity) { _, value in
            if (Money.parse(quantityText) ?? 0) != value { quantityText = Self.text(value) }
        }
    }

    static func text(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: ",")
    }
}
