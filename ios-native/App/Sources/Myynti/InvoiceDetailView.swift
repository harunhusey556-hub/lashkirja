import SwiftUI
import LashKirjaCore

struct InvoiceDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoiceId: String
    @State private var state: Loadable<Invoice> = .idle
    @State private var sheet: SheetKind?
    @State private var confirm: ConfirmKind?
    @State private var busy = false
    @State private var failure: String?
    @State private var pushedId: String?

    enum SheetKind: Identifiable { case payment, send, pdf, edit; var id: Self { self } }
    enum ConfirmKind: Identifiable { case delete, credit, markSent; var id: Self { self } }

    var body: some View {
        List {
            if let invoice = state.value {
                Section { header(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger).font(.footnote) } }
                Section {
                    LabeledContent("Päivätty", value: APIDate.displayDay(invoice.issueDate))
                    LabeledContent("Eräpäivä", value: APIDate.displayDay(invoice.dueDate))
                    LabeledContent("Viite", value: invoice.reference)
                    NavigationLink(value: Route.customer(invoice.customer.id)) {
                        LabeledContent("Asiakas", value: invoice.customer.name)
                    }
                }
                Section("Rivit") {
                    ForEach(invoice.lines) { line in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(line.description)
                                Spacer()
                                MoneyText(amount: line.net)
                            }
                            Text("\(Self.number(line.quantity)) \(line.unit) × \(Money.format(line.unitPrice)) · ALV \(Self.number(line.vatRate)) %")
                                .font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    LabeledContent("Veroton") { MoneyText(amount: invoice.net) }
                    LabeledContent("ALV") { MoneyText(amount: invoice.vat) }
                    LabeledContent("Yhteensä") { MoneyText(amount: invoice.gross).fontWeight(.semibold) }
                }
                Section("Maksut") {
                    if invoice.payments.isEmpty {
                        Text("Ei maksuja.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(invoice.payments) { payment in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(APIDate.displayDay(payment.paidDate))
                                if let note = payment.note { Text(note).font(.caption).foregroundStyle(Theme.ink2) }
                            }
                            Spacer()
                            MoneyText(amount: payment.amount)
                        }
                        .swipeActions {
                            Button("Poista", role: .destructive) { Task { await deletePayment(payment) } }
                        }
                    }
                    if invoice.open > 0 && invoice.displayStatus != .draft {
                        Button { sheet = .payment } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
                    }
                }
                if !invoice.activity.isEmpty {
                    Section("Historia") {
                        ForEach(invoice.activity) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.summary).font(.subheadline)
                                Text(Self.timestamp(item.createdAt)).font(.caption).foregroundStyle(Theme.ink2)
                            }
                        }
                    }
                }
            } else {
                LoadState(state: state, retry: load) { (_: Invoice) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(state.value.map { $0.isCreditNote ? "Hyvityslasku \($0.number)" : "Lasku \($0.number)" } ?? "Lasku")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let invoice = state.value { ToolbarItem(placement: .topBarTrailing) { actions(invoice) } } }
        .refreshable { await load() }
        .task { await load() }
        .disabled(busy)
        .sheet(item: $sheet, onDismiss: { Task { await load() } }) { kind in
            if let invoice = state.value {
                switch kind {
                case .payment: PaymentSheet(invoice: invoice)
                case .send: SendInvoiceSheet(invoice: invoice)
                case .pdf: DocumentPreviewSheet(path: "/api/invoices/\(invoice.id)/pdf", fileName: "Lasku-\(invoice.number).pdf")
                case .edit: InvoiceFormView(existing: invoice)
                }
            }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            switch confirm {
            case .delete: Button("Poista luonnos", role: .destructive) { Task { await deleteDraft() } }
            case .credit: Button("Luo hyvityslasku") { Task { await credit() } }
            case .markSent: Button("Merkitse lähetetyksi") { Task { await setStatus("sent") } }
            case nil: EmptyView()
            }
        }
        .navigationDestination(item: $pushedId) { id in InvoiceDetailView(invoiceId: id) }
    }

    private var confirmTitle: String {
        switch confirm {
        case .delete: "Poistetaanko luonnos?"
        case .credit: "Luodaanko hyvityslasku? Alkuperäinen lasku kuitataan hyvitetyksi."
        case .markSent: "Merkitäänkö lasku lähetetyksi ilman sähköpostia?"
        case nil: ""
        }
    }

    private func header(_ invoice: Invoice) -> some View {
        VStack(spacing: 6) {
            MoneyText(amount: invoice.gross).font(.system(size: 36, weight: .bold, design: .rounded))
            Text(invoice.customer.name).font(.headline)
            StatusBadge(status: invoice.displayStatus)
            if invoice.open > 0 && invoice.paid > 0 {
                Text("Avoinna \(Money.format(invoice.open))").font(.caption).foregroundStyle(Theme.ink2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private func actions(_ invoice: Invoice) -> some View {
        Menu {
            if invoice.displayStatus == .draft {
                Button { sheet = .edit } label: { Label("Muokkaa", systemImage: "pencil") }
            }
            Button { sheet = .pdf } label: { Label("Avaa PDF", systemImage: "doc.richtext") }
            if invoice.customer.email != nil && !invoice.isCreditNote {
                Button { sheet = .send } label: { Label("Lähetä sähköpostilla", systemImage: "paperplane") }
            }
            Button { UIPasteboard.general.string = invoice.reference } label: { Label("Kopioi viitenumero", systemImage: "doc.on.doc") }
            Button { Task { await duplicate() } } label: { Label("Kopioi luonnokseksi", systemImage: "plus.square.on.square") }
            if invoice.displayStatus == .draft {
                Button { confirm = .markSent } label: { Label("Merkitse lähetetyksi", systemImage: "checkmark.circle") }
            }
            if invoice.displayStatus != .draft && invoice.displayStatus != .credited && !invoice.isCreditNote {
                Button { confirm = .credit } label: { Label("Hyvitä", systemImage: "arrow.uturn.backward") }
            }
            if invoice.displayStatus == .draft {
                Button(role: .destructive) { confirm = .delete } label: { Label("Poista luonnos", systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Toiminnot")
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            let response: InvoiceDetailResponse = try await app.api.get("/api/invoices/\(invoiceId)")
            state = .loaded(response.invoice)
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) }
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        failure = nil
        defer { busy = false }
        do { try await work(); Haptics.success() }
        catch { failure = error.userMessage; Haptics.error() }
    }

    private func setStatus(_ status: String) async {
        struct Body: Encodable { let status: String }
        await run {
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/status", body: Body(status: status))
            state = .loaded(r.invoice)
        }
    }

    private func credit() async {
        await run {
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/credit", body: EmptyBody())
            pushedId = r.invoice.id
        }
        await load()
    }

    private func duplicate() async {
        await run {
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/duplicate", body: EmptyBody())
            pushedId = r.invoice.id
        }
    }

    private func deleteDraft() async {
        await run {
            let _: Ignored = try await app.api.send("DELETE", "/api/invoices/\(invoiceId)", body: Optional<EmptyBody>.none)
            dismiss()
        }
    }

    private func deletePayment(_ payment: Invoice.Payment) async {
        await run {
            let r: InvoiceResponse = try await app.api.send("DELETE", "/api/invoices/\(invoiceId)/payments", query: ["paymentId": payment.id], body: Optional<EmptyBody>.none)
            state = .loaded(r.invoice)
        }
    }

    static func number(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: ",")
    }

    static func timestamp(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        let f = DateFormatter()
        f.locale = Locale(identifier: "fi_FI")
        f.dateFormat = "d.M.yyyy 'klo' H.mm"
        return f.string(from: date)
    }
}

struct PaymentSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    @State private var amountText = ""
    @State private var date = Date()
    @State private var note = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Summa", text: $amountText).keyboardType(.decimalPad)
                    DatePicker("Maksupäivä", selection: $date, displayedComponents: .date)
                    TextField("Lisätieto (valinnainen)", text: $note)
                } footer: {
                    Text("Avoinna \(Money.format(invoice.open))")
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Kirjaa maksu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }.disabled(busy || Money.parse(amountText) == nil)
                }
            }
            .onAppear { amountText = Money.format(invoice.open).replacingOccurrences(of: "\u{00A0}€", with: "") }
        }
        .presentationDetents([.medium])
    }

    private func save() async {
        guard let amount = Money.parse(amountText) else { return }
        struct Body: Encodable { let amount: Decimal; let paidDate: String; let note: String? }
        busy = true
        defer { busy = false }
        do {
            let _: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoice.id)/payments",
                body: Body(amount: amount, paidDate: APIDate.dayString(date), note: note.isEmpty ? nil : note), idempotencyKey: key)
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
        }
    }
}

struct SendInvoiceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    @State private var to = ""
    @State private var message = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString

    var body: some View {
        NavigationStack {
            Form {
                Section("Vastaanottaja") {
                    TextField("Sähköposti", text: $to).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                }
                Section("Viesti (valinnainen)") {
                    TextField("Viesti", text: $message, axis: .vertical).lineLimit(3...8)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            }
            .navigationTitle("Lähetä lasku \(invoice.number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Lähetä") { Task { await send() } }.disabled(busy || to.isEmpty)
                }
            }
            .onAppear { to = invoice.customer.email ?? "" }
        }
    }

    private func send() async {
        struct Body: Encodable { let to: String; let message: String? }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/invoices/\(invoice.id)/send",
                body: Body(to: to.trimmingCharacters(in: .whitespaces), message: message.isEmpty ? nil : message), idempotencyKey: key)
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
        }
    }
}
