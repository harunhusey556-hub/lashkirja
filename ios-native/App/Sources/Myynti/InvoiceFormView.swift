import SwiftUI
import LashKirjaCore

/// New invoice, or edit of a draft (`existing`).
struct InvoiceFormView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: Invoice?
    var presetCustomerId: String? = nil
    /// Called with the new invoice's id after a create, before the sheet closes: the presenter
    /// opens the invoice once the sheet is gone (the web replaces the form with the invoice).
    var onCreated: ((String) -> Void)? = nil

    @State private var draft = InvoiceDraft(customerId: "", issueDate: APIDate.dayString(Date()), paymentTermDays: 14)
    @State private var issueDate = Date()
    @State private var customers: [Customer] = []
    @State private var showNewCustomer = false
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString
    @State private var loaded = false
    @State private var sellerRegistered = true
    @State private var catalog: [CatalogItem] = []
    @State private var productNotice: String?
    /// The form as it was when it opened; anything else is an unsaved change.
    @State private var baseline: InvoiceDraft?
    @State private var restored = false
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            Form {
                if restored {
                    Section {
                        Text("Palautettiin tallentamaton luonnos.")
                        Button("Aloita tyhjästä", role: .destructive) { startOver() }
                    }
                }
                Section("Asiakas") {
                    Picker("Asiakas", selection: Binding(get: { draft.customerId }, set: { pickCustomer($0) })) {
                        Text("Valitse asiakas").tag("")
                        ForEach(customers) { Text($0.name).tag($0.id) }
                    }
                    Button { showNewCustomer = true } label: { Label("Uusi asiakas", systemImage: "person.badge.plus") }
                }
                Section("Päivät") {
                    DatePicker("Laskun päivä", selection: $issueDate, displayedComponents: .date)
                    Stepper("Maksuaika \(draft.paymentTermDays) pv", value: $draft.paymentTermDays, in: 0...365, step: 7)
                }
                Section {
                    ForEach($draft.lines) { $line in
                        LineEditor(line: $line, catalog: catalog, issueDate: APIDate.dayString(issueDate), showsVat: sellerRegistered) { saved in
                            Task { await saveProduct(saved) }
                        }
                    }
                    .onDelete { draft.lines.remove(atOffsets: $0) }
                    Button { withAnimation { draft.lines.append(.new(sellerRegistered: sellerRegistered)) } } label: { Label("Lisää rivi", systemImage: "plus") }
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Luo lasku" : "Tallenna") { Task { await save() } }.disabled(busy)
                }
            }
            .confirmationDialog("Hylätäänkö muutokset?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Hylkää muutokset", role: .destructive) {
                    if existing == nil, let owner { SalesDraftStore.shared.clear(owner: owner) }
                    dismiss()
                }
                if existing == nil {
                    // Kept in memory: "Uusi lasku" opens with it again.
                    Button("Säilytä luonnos ja sulje") { dismiss() }
                }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text(existing == nil ? "Laskua ei ole vielä luotu." : "Muutoksia ei ole tallennettu.")
            }
            .sheet(isPresented: $showNewCustomer) {
                CustomerFormSheet(existing: nil) { created in
                    customers.append(created)
                    draft.customerId = created.id
                    draft.paymentTermDays = created.defaultPaymentTermDays
                }
            }
            // A date moved into 2026 turns old 14 % lines into 13,5 % (as the web form does).
            .onChange(of: issueDate) { _, date in
                draft.lines.adjustVatRates(issueDate: APIDate.dayString(date))
            }
            .onChange(of: snapshot) { _, current in keepDraft(current) }
            .task { await prepare() }
            .interactiveDismissDisabled(busy || dirty)
        }
    }

    /// The draft with the picked date, as it would be sent.
    private var snapshot: InvoiceDraft {
        var current = draft
        current.issueDate = APIDate.dayString(issueDate)
        return current
    }

    private var dirty: Bool {
        guard let baseline else { return false }
        return snapshot != baseline
    }

    private var owner: String? {
        if case .signedIn(let user) = app.phase { return user.userId }
        return nil
    }

    /// Picking a customer on a new invoice brings that customer's payment term along.
    private func pickCustomer(_ id: String) {
        draft.customerId = id
        if existing == nil, let c = customers.first(where: { $0.id == id }) { draft.paymentTermDays = c.defaultPaymentTermDays }
    }

    /// A new invoice the owner has typed into is kept in memory until it is created or discarded.
    private func keepDraft(_ current: InvoiceDraft) {
        guard existing == nil, let baseline, let owner, !busy else { return }
        if SalesDraftStore.worthKeeping(current, baseline: baseline) {
            SalesDraftStore.shared.keep(current, owner: owner)
        } else {
            SalesDraftStore.shared.clear(owner: owner)
        }
    }

    private func startOver() {
        guard let baseline else { return }
        draft = baseline
        issueDate = APIDate.day(baseline.issueDate) ?? Date()
        restored = false
        if let owner { SalesDraftStore.shared.clear(owner: owner) }
    }

    private func prepare() async {
        guard !loaded else { return }
        loaded = true
        // Customers, catalog and profile load side by side: the form is ready after one round trip.
        let api = app.api
        async let customerList: CustomerList? = try? api.get("/api/customers")
        async let catalogList: CatalogList? = try? api.get("/api/catalog")
        async let profile = app.cachedProfile()
        if let list = await customerList { customers = list.customers.filter { $0.archivedAt == nil } }
        // The form works without the catalog; the product picker just stays hidden.
        if let list = await catalogList { catalog = list.items }
        if let profile = await profile { sellerRegistered = profile.vatRegistered }
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
            if let presetCustomerId { pickCustomer(presetCustomerId) }
            if draft.lines.isEmpty { draft.lines = [.new(sellerRegistered: sellerRegistered)] }
        }
        draft.followSellerVat(registered: sellerRegistered)
        // What the date change below would do anyway, done before the baseline so it does not
        // count as the owner's change (a 14 % draft line dated in 2026 can only be 13,5 %).
        draft.lines.adjustVatRates(issueDate: APIDate.dayString(issueDate))
        baseline = snapshot
        restoreKeptDraft()
    }

    /// "Uusi lasku" again after closing an unsaved one: the owner continues where they left off.
    /// Not when the form was opened for another customer than the kept draft's.
    private func restoreKeptDraft() {
        guard existing == nil, let owner, let kept = SalesDraftStore.shared.entry(owner: owner) else { return }
        if let presetCustomerId, kept.draft.customerId != presetCustomerId { return }
        var restoredDraft = kept.draft
        // The VAT status may have changed since; the kept customer may since have been archived.
        restoredDraft.followSellerVat(registered: sellerRegistered)
        if !restoredDraft.customerId.isEmpty, !customers.contains(where: { $0.id == restoredDraft.customerId }) {
            restoredDraft.customerId = baseline?.customerId ?? ""
        }
        draft = restoredDraft
        issueDate = APIDate.day(restoredDraft.issueDate) ?? Date()
        draft.lines.adjustVatRates(issueDate: APIDate.dayString(issueDate))
        restored = true
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
        draft.followSellerVat(registered: sellerRegistered)
        if let problem = draft.validationError { failure = problem; Haptics.error(); return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            if let existing {
                let _: InvoiceResponse = try await app.api.send("PATCH", "/api/invoices/\(existing.id)", body: InvoicePatch(draft: draft, expectedUpdatedAt: existing.updatedAt))
            } else {
                let response: InvoiceResponse = try await app.api.send("POST", "/api/invoices", body: draft, idempotencyKey: key)
                if let owner { SalesDraftStore.shared.clear(owner: owner) }
                onCreated?(response.invoice.id)
            }
            // Saved: nothing left to lose, so the sheet may close without asking.
            baseline = snapshot
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
    /// Off for a seller outside the VAT register: every line is 0 % and the rate is not offered.
    var showsVat = true
    var onSaveProduct: ((InvoiceDraft.Line) -> Void)? = nil
    @State private var priceText = ""
    @State private var quantityText = ""

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
            if showsVat {
                // The rates valid on the invoice date (web `vatRateOptions`), plus the line's own
                // rate when it is no longer one of them, with the reason underneath.
                Picker("ALV", selection: $line.vatRate) {
                    ForEach(SalesVat.rateOptions(current: line.vatRate, issueDate: issueDate), id: \.self) { rate in
                        Text("\(Self.text(rate)) %").tag(rate)
                    }
                }
                .pickerStyle(.segmented)
                if let note = SalesVat.dateNote(line.vatRate, issueDate: issueDate) {
                    Text(note).font(.caption).foregroundStyle(Theme.danger)
                }
            }
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
