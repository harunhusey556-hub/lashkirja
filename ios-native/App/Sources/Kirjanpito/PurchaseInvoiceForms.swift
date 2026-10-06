import SwiftUI
import LashKirjaCore

/// "Uusi ostolasku", or editing an existing one (`existing`).
struct PurchaseInvoiceFormView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: PurchaseInvoice?
    var onSaved: (PurchaseInvoice) -> Void = { _ in }

    @State private var form = PurchaseInvoiceForm(today: APIDate.dayString(Date()))
    @State private var errors: [PurchaseInvoiceForm.Field: String] = [:]
    @State private var failure: String?
    @State private var busy = false
    @State private var key = UUID().uuidString
    @State private var prepared = false
    @State private var baseline: PurchaseInvoiceForm?
    @State private var confirmDiscard = false

    private var dirty: Bool { baseline.map { $0 != form } ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Toimittaja", text: $form.supplierName, prompt: Text("Tukku Oy"))
                        .textContentType(.organizationName)
                        .textInputAutocapitalization(.words)
                    fieldError(.supplierName)
                } header: {
                    Text("Toimittaja")
                }

                Section {
                    LabeledContent("Summa (€)") {
                        TextField("124,00", text: $form.gross)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.gross)
                    LabeledContent("ALV (€)") {
                        TextField("0,00", text: $form.vat)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.vat)
                } header: {
                    Text("Summat")
                } footer: {
                    Text("Laskun ALV on mukana ALV-ilmoituksen vähennettävässä verossa laskun päivän mukaan. Jos sama osto on myös kuittina, liitä kuitti laskuun, niin ALV ei lasketa kahdesti.")
                }

                Section {
                    DatePicker("Laskun päivä", selection: dayBinding(\.issueDate), displayedComponents: .date)
                    DatePicker("Eräpäivä", selection: dayBinding(\.dueDate), displayedComponents: .date)
                    fieldError(.dueDate)
                } header: {
                    Text("Päivät")
                }

                Section {
                    LabeledContent("Viitenumero") {
                        TextField("", text: $form.reference)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                    }
                    fieldError(.reference)
                    LabeledContent("Laskun numero") {
                        TextField("", text: $form.invoiceNumber)
                            .codeInput(.never)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Kategoria") {
                        TextField("", text: $form.category)
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text("Tunnisteet")
                } footer: {
                    Text("Viitenumero tarvitaan automaattiseen kohdistukseen.")
                }

                Section {
                    TextField("Lisätiedot (valinnainen)", text: $form.notes, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Lisätiedot")
                }

                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle(existing == nil ? "Uusi ostolasku" : "Muokkaa ostolaskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Lisää" : "Tallenna") { Task { await save() } }
                        .disabled(busy)
                }
            }
            .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
            .onAppear {
                guard !prepared else { return }
                prepared = true
                if let existing { form = PurchaseInvoiceForm(editing: existing) }
                baseline = form
            }
        }
    }

    @ViewBuilder
    private func fieldError(_ field: PurchaseInvoiceForm.Field) -> some View {
        if let message = errors[field] {
            Text(message).font(.footnote).foregroundStyle(Theme.danger)
        }
    }

    private func dayBinding(_ keyPath: WritableKeyPath<PurchaseInvoiceForm, String>) -> Binding<Date> {
        Binding(
            get: { APIDate.day(form[keyPath: keyPath]) ?? Date() },
            set: { form[keyPath: keyPath] = APIDate.dayString($0) }
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
            let saved: PurchaseInvoice
            if let existing {
                let patch = PurchaseInvoicePatch(from: input, existing: existing)
                if patch.isEmpty {
                    dismiss()
                    return
                }
                let response: PurchaseInvoiceResponse = try await app.api.send("PATCH", "/api/purchase-invoices/\(existing.id)", body: patch)
                saved = response.invoice
            } else {
                let response: PurchaseInvoiceResponse = try await app.api.send("POST", "/api/purchase-invoices", body: input, idempotencyKey: key)
                saved = response.invoice
            }
            Haptics.success()
            app.dataVersion += 1
            onSaved(saved)
            dismiss()
        } catch is CancellationError {
        } catch {
            Haptics.error()
            // A refusal that names a field is shown at that field.
            var routed: [PurchaseInvoiceForm.Field: String] = [:]
            if let lk = error as? LKError {
                for (name, message) in lk.fields {
                    if let field = PurchaseInvoiceForm.Field(rawValue: name) { routed[field] = message }
                }
            }
            if routed.isEmpty {
                failure = error.userMessage
            } else {
                errors = routed
            }
        }
    }
}

/// "Kirjaa maksu" for a purchase invoice: amount (prefilled with the open balance), date and note.
struct PurchasePaymentSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: PurchaseInvoice
    var onSaved: (PurchaseInvoice) -> Void = { _ in }

    @State private var amountText = ""
    @State private var date = Date()
    @State private var note = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString
    @State private var prefilled = ""
    @State private var confirmDiscard = false

    private var dirty: Bool { amountText != prefilled || !note.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Summa (€)") {
                        TextField("124,00", text: $amountText)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                    DatePicker("Maksupäivä", selection: $date, displayedComponents: .date)
                    TextField("Lisätieto (valinnainen)", text: $note)
                } header: {
                    Text(invoice.supplierName)
                } footer: {
                    Text("Avoinna \(Money.format(invoice.open))")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
            }
            .formKeyboard()
            .navigationTitle("Kirjaa maksu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Merkitse maksetuksi") { Task { await save() } }.disabled(busy)
                }
            }
            .onAppear {
                if amountText.isEmpty && invoice.open > 0 {
                    amountText = PurchaseInvoiceForm.amountText(invoice.open)
                    prefilled = amountText
                }
            }
        }
        .presentationDetents([.medium, .large])
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private func save() async {
        if let problem = PurchasePaymentBody.problem(amountText: amountText) {
            failure = problem
            Haptics.error()
            return
        }
        guard !busy, let amount = Money.parse(amountText) else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let body = PurchasePaymentBody(amount: amount, paidDate: APIDate.dayString(date), note: note)
            let response: PurchaseInvoiceResponse = try await app.api.send("POST", "/api/purchase-invoices/\(invoice.id)/payments", body: body, idempotencyKey: key)
            Haptics.success()
            app.dataVersion += 1
            onSaved(response.invoice)
            dismiss()
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}

/// Closes a purchase invoice as paid without full payments: the server wants a reason.
struct PurchaseMarkPaidSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: PurchaseInvoice
    var onSaved: (PurchaseInvoice) -> Void = { _ in }

    @State private var reason = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var confirmDiscard = false

    private var dirty: Bool { !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Perustelu", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Miksi lasku on maksettu?")
                } footer: {
                    Text("Laskulle ei ole kirjattu maksuja koko summalle (avoinna \(Money.format(invoice.open))). Kirjoita vähintään kolmen merkin perustelu, esim. maksettu käteisellä.")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
            }
            .formKeyboard()
            .navigationTitle("Merkitse maksetuksi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }
                        .disabled(busy || !PurchaseStatusChange.reasonIsLongEnough(reason))
                }
            }
        }
        .presentationDetents([.medium])
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private func save() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let response: PurchaseInvoiceResponse = try await app.api.send("PATCH", "/api/purchase-invoices/\(invoice.id)", body: PurchaseStatusChange(status: .paid, closeReason: reason))
            Haptics.success()
            app.dataVersion += 1
            onSaved(response.invoice)
            dismiss()
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}

/// The status pill of a purchase invoice, toned like the web's `PURCHASE_STATUS`.
struct PurchaseStatusBadge: View {
    let status: PurchaseDisplayStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .open: Theme.ink2
        case .overdue: Theme.danger
        case .paid: Theme.success
        case .cancelled: Theme.ink2
        }
    }
}

/// "Toistuva": the invoice was made by a recurring template.
struct RecurringBadge: View {
    var chevron = false

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "repeat").imageScale(.small).accessibilityHidden(true)
            Text("Toistuva")
            if chevron { Image(systemName: "chevron.right").imageScale(.small).accessibilityHidden(true) }
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Theme.accent.opacity(0.12), in: Capsule())
        .foregroundStyle(Theme.accent)
    }
}

struct PurchaseInvoiceRow: View {
    let invoice: PurchaseInvoice
    var recurring = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(invoice.supplierName).foregroundStyle(Theme.ink).lineLimitUnlessLarge()
                Text(invoice.rowSecondary).font(.caption).foregroundStyle(Theme.ink2).lineLimit(2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                MoneyText(amount: invoice.gross).font(.subheadline.weight(.semibold))
                HStack(spacing: 4) {
                    if recurring { RecurringBadge() }
                    PurchaseStatusBadge(status: invoice.displayStatus)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
