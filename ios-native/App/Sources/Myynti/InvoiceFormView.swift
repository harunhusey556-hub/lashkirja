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
                Section("Rivit") {
                    ForEach($draft.lines) { $line in LineEditor(line: $line) }
                        .onDelete { draft.lines.remove(atOffsets: $0) }
                    Button { withAnimation { draft.lines.append(.init()) } } label: { Label("Lisää rivi", systemImage: "plus") }
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

private struct LineEditor: View {
    @Binding var line: InvoiceDraft.Line
    @State private var priceText = ""
    @State private var quantityText = ""
    private static let rates: [Decimal] = [Decimal(string: "25.5")!, 14, Decimal(string: "13.5")!, 10, 0]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Kuvaus", text: $line.description)
            HStack {
                TextField("Määrä", text: $quantityText).keyboardType(.decimalPad).frame(maxWidth: 70)
                    .onChange(of: quantityText) { _, t in if let v = Money.parse(t) { line.quantity = v } }
                TextField("Yksikkö", text: $line.unit).frame(maxWidth: 70)
                TextField("À-hinta €", text: $priceText).keyboardType(.decimalPad)
                    .onChange(of: priceText) { _, t in if let v = Money.parse(t) { line.unitPrice = v } }
            }
            Picker("ALV", selection: $line.vatRate) {
                ForEach(Self.rates, id: \.self) { rate in
                    Text("\(NSDecimalNumber(decimal: rate).stringValue.replacingOccurrences(of: ".", with: ",")) %").tag(rate)
                }
            }
            .pickerStyle(.segmented)
        }
        .onAppear {
            if quantityText.isEmpty { quantityText = NSDecimalNumber(decimal: line.quantity).stringValue.replacingOccurrences(of: ".", with: ",") }
            if priceText.isEmpty && line.unitPrice != 0 { priceText = NSDecimalNumber(decimal: line.unitPrice).stringValue.replacingOccurrences(of: ".", with: ",") }
        }
    }
}
