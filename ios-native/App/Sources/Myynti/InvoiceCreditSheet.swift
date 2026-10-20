import SwiftUI
import LashKirjaCore

/// "Hyvitä": the web's credit sheet. Each line starts with what is left of it; lowering a quantity
/// (or clearing it) credits only a part. The server takes the quantities per line, so that is
/// what is chosen here. `onCreated` gets the id of the new credit note.
struct InvoiceCreditSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    let onCreated: (String) -> Void
    @State private var quantities: [String: String]
    @State private var failure: String?
    /// One key until the note is made: a retry after a lost answer is replayed, never credited twice.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var confirmDiscard = false

    init(invoice: Invoice, onCreated: @escaping (String) -> Void) {
        self.invoice = invoice
        self.onCreated = onCreated
        _quantities = State(initialValue: InvoiceCredit.prefilled(invoice))
    }

    private var dirty: Bool { quantities != InvoiceCredit.prefilled(invoice) }
    private var left: [String: Decimal] { InvoiceCredit.remaining(invoice) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(invoice.lines) { line in lineRow(line) }
                } header: {
                    Text("Hyvitettävät rivit")
                } footer: {
                    Text("Jätä määrä tyhjäksi, jos riviä ei hyvitetä. Pienempi määrä hyvittää vain osan.")
                }
                Section {
                    LabeledContent("Hyvitetään yhteensä") {
                        if let total = InvoiceCredit.total(invoice: invoice, quantities: quantities) {
                            MoneyText(amount: total).fontWeight(.semibold)
                        } else {
                            Text("–").foregroundStyle(Theme.ink2)
                        }
                    }
                } footer: {
                    Text(InvoiceCredit.confirmNote)
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle("Hyvitä laskua")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    // One short verb: "Luo hyvityslasku" left the title only "Hyvitä la…" (X022).
                    Button { Task { await create() } } label: { InFlightLabel("Hyvitä", inFlight: busy) }
                        .disabled(busy)
                }
            }
        }
        .presentationDetents([.medium, .large])
        // Opaque at half height: the invoice under the glass showed through the form (U007).
        .presentationBackground(Theme.canvas)
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private func lineRow(_ line: Invoice.Line) -> some View {
        let rest = left[line.id] ?? 0
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(line.description)
                if rest > 0 {
                    Text("Hyvitettävissä \(InvoiceCredit.quantityText(rest)) \(line.unit)")
                        .font(.caption).foregroundStyle(Theme.ink2)
                } else {
                    Text("Hyvitetty kokonaan").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            Spacer(minLength: 8)
            TextField("0", text: binding(line.id))
                .moneyInput()
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
                .disabled(rest <= 0)
                .accessibilityLabel("Määrä, \(line.description)")
        }
    }

    private func binding(_ lineId: String) -> Binding<String> {
        Binding(get: { quantities[lineId] ?? "" }, set: { quantities[lineId] = $0 })
    }

    private func create() async {
        let body: InvoiceCredit.Body
        switch InvoiceCredit.body(invoice: invoice, quantities: quantities) {
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
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoice.id)/credit", body: body, idempotencyKey: key)
            succeeded = true
            Haptics.success()
            app.dataVersion += 1
            onCreated(r.invoice.id)
            dismiss()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
