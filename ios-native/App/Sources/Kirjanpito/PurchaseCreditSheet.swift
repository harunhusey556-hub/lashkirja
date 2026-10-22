import SwiftUI
import LashKirjaCore

/// "Hyvitä ostolasku": a supplier's credit note against one purchase invoice, as the web's credit
/// sheet. The amount starts at what is still creditable; VAT may be left empty (the server then takes
/// the invoice's VAT pro rata). `onCreated` gets the invoice as it stands after the credit.
struct PurchaseCreditSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: PurchaseInvoice
    let onCreated: (PurchaseInvoice) -> Void

    @State private var form: PurchaseCreditForm
    @State private var date: Date
    @State private var failure: String?
    /// One key until the note is made: a retry after a lost answer is replayed, never credited twice.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var confirmDiscard = false
    private let initial: PurchaseCreditForm

    init(invoice: PurchaseInvoice, onCreated: @escaping (PurchaseInvoice) -> Void) {
        self.invoice = invoice
        self.onCreated = onCreated
        let today = APIDate.dayString(Date())
        let start = PurchaseCreditForm(invoice: invoice, today: today)
        initial = start
        _form = State(initialValue: start)
        _date = State(initialValue: APIDate.pickerDate(today) ?? Date())
    }

    private var dirty: Bool { form != initial }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // The field took the row's width and cut its label to 'Hyvitettävä summa…' (X160).
                    LabeledContent {
                        TextField("62,00", text: $form.amount)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 120)
                    } label: {
                        Text("Hyvitettävä summa (€)").layoutPriority(1)
                    }
                    LabeledContent("ALV (€)") {
                        TextField("Laskennallinen", text: $form.vat)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text("\(invoice.supplierName) · \(Money.format(invoice.gross))")
                } footer: {
                    Text("Jätä ALV tyhjäksi, niin se lasketaan ostolaskun ALV:stä samassa suhteessa. Hyvitys vähentää avointa summaa ja ALV-vähennystä hyvityspäivän kaudella. Hyvitettävissä enintään \(Money.format(invoice.creditable)).")
                }
                Section {
                    DatePicker("Hyvityslaskun päivä", selection: $date, displayedComponents: .date)
                        .onChange(of: date) { _, picked in form.date = APIDate.pickerDay(picked) }
                    TextField("Hyvityslaskun numero (valinnainen)", text: $form.number)
                    TextField("Syy, esim. palautus tai hinnanalennus", text: $form.reason)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .failureToast($failure)
            .formKeyboard()
            .navigationTitle("Hyvitä ostolasku")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    // One short verb, as the sales credit sheet: the long label left 'Hyvitä os…' (X160).
                    Button { Task { await create() } } label: { InFlightLabel("Hyvitä", inFlight: busy) }
                        .disabled(busy)
                }
            }
        }
        .presentationDetents([.large])
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private func create() async {
        let body: PurchaseCreditBody
        switch form.body(for: invoice) {
        case .invalid(let reason):
            failure = reason
            Haptics.error()
            return
        case .body(let found):
            body = found
        }
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let response: PurchaseCreditResponse = try await app.api.send("POST", "/api/purchase-invoices/\(invoice.id)/credit", body: body, idempotencyKey: key)
            succeeded = true
            Haptics.success()
            app.dataVersion += 1
            onCreated(response.invoice)
            dismiss()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// The credit notes against an invoice, or the invoice a credit note corrects, as links.
struct PurchaseCreditLinksSection: View {
    let invoice: PurchaseInvoice

    var body: some View {
        if let original = invoice.creditsInvoiceId {
            Section("Hyvitetty lasku") {
                NavigationLink(value: Route.purchaseInvoice(original)) {
                    Label("Avaa alkuperäinen ostolasku", systemImage: "doc.text")
                }
            }
        }
        if !invoice.creditNotes.isEmpty {
            Section {
                ForEach(invoice.creditNotesNewestFirst) { note in
                    NavigationLink(value: Route.purchaseInvoice(note.id)) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(note.title)
                                Text(APIDate.displayDay(note.issueDate)).font(.caption).foregroundStyle(Theme.ink2)
                            }
                            Spacer()
                            MoneyText(amount: note.gross)
                        }
                    }
                }
            } header: {
                Text("Hyvityslaskut")
            }
        }
    }
}
