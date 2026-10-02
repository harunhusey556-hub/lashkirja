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
    @State private var duplicates: [PaymentDuplicate] = []
    @State private var duplicateBusy: String?
    @State private var reminder: ReminderPreview?
    @State private var reminderFailed = false
    @State private var notice: String?
    /// A send that left but was not recorded: said in the warning colour, not as a success.
    @State private var warning: String?
    @State private var toast: Toast?
    @State private var toastAction: (() async -> Void)?
    @State private var toastTask: Task<Void, Never>?
    /// The version whose PDF was already fetched ahead, so a reload does not fetch it again.
    @State private var prefetchedKey: String?
    @State private var lineLimit = ShowMore()
    @State private var paymentLimit = ShowMore()
    /// The history is secondary on this long screen: five events, then more on request.
    @State private var activityLimit = ShowMore(step: 5)

    enum SheetKind: Identifiable { case payment, send, pdf, edit, reminder, reminderPdf, close; var id: Self { self } }
    enum ConfirmKind: Identifiable { case delete, credit, markSent; var id: Self { self } }

    var body: some View {
        List {
            if let invoice = state.value {
                Section { header(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                if let main = primaryAction(invoice) {
                    Section {
                        Button { perform(main) } label: {
                            Label(main.title, systemImage: main.symbol).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.primary)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    }
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger).font(.footnote) } }
                if let warning { Section { Text(warning).foregroundStyle(Theme.warning).font(.footnote) } }
                if let notice { Section { Text(notice).foregroundStyle(Theme.success).font(.footnote) } }
                Section {
                    LabeledContent("Päivätty", value: APIDate.displayDay(invoice.issueDate))
                    LabeledContent("Eräpäivä", value: APIDate.displayDay(invoice.dueDate))
                    LabeledContent("Viite", value: invoice.reference)
                    if let reason = invoice.closedReason, !reason.isEmpty { LabeledContent("Suljettu", value: reason) }
                    NavigationLink(value: Route.customer(invoice.customer.id)) {
                        LabeledContent("Asiakas", value: invoice.customer.name)
                    }
                }
                Section("Rivit") {
                    ForEach(invoice.lines.prefix(lineLimit.visible(invoice.lines.count))) { line in
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
                    ShowMoreButton(limit: $lineLimit, total: invoice.lines.count)
                    LabeledContent("Veroton") { MoneyText(amount: invoice.net) }
                    LabeledContent("ALV") { MoneyText(amount: invoice.vat) }
                    LabeledContent("Yhteensä") { MoneyText(amount: invoice.gross).fontWeight(.semibold) }
                }
                Section("Maksut") {
                    if invoice.payments.isEmpty {
                        Text("Ei maksuja.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(invoice.payments.prefix(paymentLimit.visible(invoice.payments.count))) { payment in
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
                    ShowMoreButton(limit: $paymentLimit, total: invoice.payments.count)
                    if invoice.open > 0 && invoice.displayStatus != .draft && primaryAction(invoice) != .payment {
                        Button { sheet = .payment } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
                    }
                }
                if !duplicates.isEmpty {
                    Section("Tarkista maksu") {
                        ForEach(duplicates) { pair in duplicateRow(pair) }
                    }
                }
                if invoice.displayStatus == .overdue {
                    reminderSection(invoice)
                }
                if !invoice.activity.isEmpty {
                    Section("Historia") {
                        // Newest first: the server sends the oldest first, and only the first rows show.
                        ForEach(Array(invoice.activity.reversed()).prefix(activityLimit.visible(invoice.activity.count))) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.summary).font(.subheadline)
                                Text(Self.timestamp(item.createdAt)).font(.caption).foregroundStyle(Theme.ink2)
                            }
                        }
                        ShowMoreButton(limit: $activityLimit, total: invoice.activity.count)
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
        .overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast) { runToastAction() }.padding(.bottom, 8)
            }
        }
        .onDisappear { toastTask?.cancel() }
        .refreshable { await load() }
        .task { await load() }
        .disabled(busy)
        .sheet(item: $sheet, onDismiss: { Task { await load() } }) { kind in
            if let invoice = state.value {
                switch kind {
                case .payment: PaymentSheet(invoice: invoice)
                case .send: SendInvoiceSheet(invoice: invoice) { result in
                    if result.isWarning { warning = result.message; notice = nil } else { notice = result.message; warning = nil }
                }
                case .close: CloseReasonSheet { reason in Task { await setStatus(.close(reason: reason)) } }
                case .pdf: DocumentPreviewSheet(path: "/api/invoices/\(invoice.id)/pdf", fileName: "Lasku-\(invoice.number).pdf", cacheKey: invoice.updatedAt)
                case .edit: InvoiceFormView(existing: invoice)
                case .reminder:
                    if let reminder {
                        ReminderSheet(invoice: invoice, preview: reminder) { message in notice = message }
                    }
                case .reminderPdf:
                    DocumentPreviewSheet(path: "/api/invoices/\(invoice.id)/reminders/pdf", fileName: "muistutus-\(invoice.number).pdf")
                }
            }
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            switch confirm {
            case .delete: Button("Poista luonnos", role: .destructive) { Task { await deleteDraft() } }
            case .credit: Button("Luo hyvityslasku") { Task { await credit() } }
            case .markSent: Button("Merkitse lähetetyksi") { Task { await setStatus(.markSent) } }
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

    /// The invoice's next step as one visible button; the rarer actions stay in the ⋯ menu.
    private func primaryAction(_ invoice: Invoice) -> InvoicePrimaryAction? {
        InvoicePrimaryAction.for(status: invoice.displayStatus, open: invoice.open, isCreditNote: invoice.isCreditNote,
                                 reminderReady: reminder != nil && reminder?.waitNote() == nil)
    }

    private func perform(_ action: InvoicePrimaryAction) {
        switch action {
        case .send: sheet = .send
        case .reminder: sheet = .reminder
        case .payment: sheet = .payment
        case .markPaid: Task { await markPaid() }
        }
    }

    private func actions(_ invoice: Invoice) -> some View {
        Menu {
            if invoice.displayStatus == .draft {
                Button { sheet = .edit } label: { Label("Muokkaa", systemImage: "pencil") }
            }
            Button { sheet = .pdf } label: { Label("Avaa PDF", systemImage: "doc.richtext") }
            // The send check says what is missing, so the item shows without an address too (as on the web).
            if invoice.status != "credited" && primaryAction(invoice) != .send {
                Button { sheet = .send } label: { Label("Lähetä sähköpostilla", systemImage: "paperplane") }
            }
            if invoice.displayStatus == .overdue && reminder != nil && primaryAction(invoice) != .reminder {
                Button { sheet = .reminder } label: { Label("Lähetä maksumuistutus", systemImage: "bell") }
            }
            Button { UIPasteboard.general.string = invoice.reference } label: { Label("Kopioi viitenumero", systemImage: "doc.on.doc") }
            Button { Task { await duplicate() } } label: { Label("Kopioi luonnokseksi", systemImage: "plus.square.on.square") }
            if invoice.displayStatus == .draft {
                Button { confirm = .markSent } label: { Label("Merkitse lähetetyksi", systemImage: "checkmark.circle") }
            }
            if invoice.displayStatus != .draft && invoice.displayStatus != .credited && !invoice.isCreditNote {
                Button { confirm = .credit } label: { Label("Hyvitä", systemImage: "arrow.uturn.backward") }
            }
            if InvoiceStatusChange.canClose(status: invoice.status, open: invoice.open, isCreditNote: invoice.isCreditNote) {
                Button { sheet = .close } label: { Label("Sulje perustelulla", systemImage: "checkmark.seal") }
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
            duplicates = response.paymentDuplicates ?? []
            prefetchPdf(response.invoice)
            if response.invoice.displayStatus == .overdue {
                await loadReminder()
            } else {
                reminder = nil
                reminderFailed = false
            }
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

    @discardableResult
    private func setStatus(_ change: InvoiceStatusChange) async -> Bool {
        var done = false
        await run {
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/status", body: change)
            state = .loaded(r.invoice)
            done = true
        }
        return done
    }

    /// Reversible, so no dialog: done at once, with "Kumoa" for a few seconds (web T4).
    private func markPaid() async {
        guard await setStatus(.markPaid) else { return }
        showToast(InvoiceStatusChange.markedPaidText, action: "Kumoa") {
            if await setStatus(.reopen) { showToast(InvoiceStatusChange.reopenedText, action: nil, run: nil) }
        }
    }

    private func showToast(_ text: String, action: String?, run: (() async -> Void)?) {
        toastTask?.cancel()
        toastAction = run
        withAnimation(.snappy) { toast = Toast(text: text, actionLabel: action) }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation { toast = nil }
            toastAction = nil
        }
    }

    private func runToastAction() {
        let action = toastAction
        toastTask?.cancel()
        toastAction = nil
        withAnimation { toast = nil }
        if let action { Task { await action() } }
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
        let api = app.api, id = invoiceId
        app.removeInBackground([id]) {
            let _: Ignored = try await api.send("DELETE", "/api/invoices/\(id)", body: Optional<EmptyBody>.none)
        }
        dismiss()
    }

    private func deletePayment(_ payment: Invoice.Payment) async {
        await run {
            let r: InvoiceResponse = try await app.api.send("DELETE", "/api/invoices/\(invoiceId)/payments", query: ["paymentId": payment.id], body: Optional<EmptyBody>.none)
            state = .loaded(r.invoice)
        }
    }

    /// Only an overdue invoice has a reminder preview; a failure leaves a retry, not a dead button.
    /// The PDF starts downloading while the owner reads the screen, so "PDF" opens at once.
    /// Never for a draft: serving a draft's PDF marks it as having left the app on the server.
    private func prefetchPdf(_ invoice: Invoice) {
        guard invoice.status != "draft", invoice.displayStatus != .draft, prefetchedKey != invoice.updatedAt else { return }
        prefetchedKey = invoice.updatedAt
        DocumentCache.shared.prefetch(app, path: "/api/invoices/\(invoice.id)/pdf", fileName: "Lasku-\(invoice.number).pdf", key: invoice.updatedAt)
    }

    private func loadReminder() async {
        do {
            let response: ReminderPreviewResponse = try await app.api.get("/api/invoices/\(invoiceId)/reminders")
            reminder = response.reminder
            reminderFailed = false
        } catch is CancellationError {
        } catch {
            reminder = nil
            reminderFailed = true
        }
    }

    private func duplicateRow(_ pair: PaymentDuplicate) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(pair.summary).font(.subheadline)
            HStack(spacing: 10) {
                Button {
                    Task { await settle(pair, link: true) }
                } label: {
                    Text(duplicateBusy == pair.paymentId ? "Yhdistetään…" : "Sama maksu, yhdistä").frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                Button {
                    Task { await settle(pair, link: false) }
                } label: {
                    Text("Eri tuloja").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accentDark)
            }
            .disabled(duplicateBusy != nil)
        }
        .padding(.vertical, 4)
    }

    private func settle(_ pair: PaymentDuplicate, link: Bool) async {
        duplicateBusy = pair.paymentId
        failure = nil
        defer { duplicateBusy = nil }
        do {
            let body: PaymentLinkRequest = link
                ? .link(paymentId: pair.paymentId, transactionId: pair.transactionId)
                : .dismiss(paymentId: pair.paymentId, receiptId: pair.receiptId)
            let _: Ignored = try await app.api.send("POST", "/api/invoices/\(invoiceId)/payments/link", body: body)
            Haptics.success()
            notice = link ? "Maksu yhdistettiin pankkitapahtumaan" : "Merkitty erillisiksi tuloiksi"
            app.dataVersion += 1
            await load()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    @ViewBuilder
    private func reminderSection(_ invoice: Invoice) -> some View {
        if let reminder {
            Section("Muistutukset") {
                Text("Myöhässä \(reminder.daysLate) päivää · muistutus \(reminder.level)")
                    .font(.caption).foregroundStyle(Theme.ink2)
                LabeledContent("Avoin pääoma") { MoneyText(amount: reminder.open) }
                if reminder.interest > 0 { LabeledContent("Viivästyskorko") { MoneyText(amount: reminder.interest) } }
                if reminder.fee > 0 { LabeledContent("Muistutusmaksu") { MoneyText(amount: reminder.fee) } }
                LabeledContent("Maksettava yhteensä") { MoneyText(amount: reminder.total).fontWeight(.semibold) }
                Button { sheet = .reminderPdf } label: { Label("Avaa muistutus", systemImage: "doc.richtext") }
                if let wait = reminder.waitNote() {
                    Text(wait).font(.caption).foregroundStyle(Theme.ink2)
                } else {
                    Button { sheet = .reminder } label: { Label("Lähetä maksumuistutus", systemImage: "bell") }
                }
                ForEach(reminder.previousReminders) { previous in
                    Text("Muistutus \(previous.level) · \(APIDate.displayDay(previous.sentAt)) · \(Money.format(previous.total))")
                        .font(.caption).foregroundStyle(Theme.ink2)
                }
            }
        } else if reminderFailed {
            Section("Muistutukset") {
                Text("Muistutuksen tietoja ei saatu ladattua.").font(.footnote).foregroundStyle(Theme.ink2)
                Button { Task { await loadReminder() } } label: { Label("Yritä uudelleen", systemImage: "arrow.clockwise") }
            }
        }
    }

    static func number(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: ",")
    }

    static func timestamp(_ iso: String) -> String { APIDate.timestamp(iso) }
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
    @State private var bankRow: PaymentCandidate?
    @State private var useBankRow = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Summa", text: $amountText).keyboardType(.decimalPad)
                    DatePicker("Maksupäivä", selection: $date, in: ...Date(), displayedComponents: .date)
                    TextField("Lisätieto (valinnainen)", text: $note)
                } footer: {
                    Text("Avoinna \(Money.format(invoice.open))")
                }
                if let bankRow {
                    Section {
                        Toggle(isOn: $useBankRow) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Yhdistä tiliotteen maksuun")
                                Text(bankRow.summary + (bankRow.receiptNote.map { ". \($0)" } ?? ""))
                                    .font(.caption).foregroundStyle(Theme.ink2)
                            }
                        }
                        .tint(Theme.accent)
                    }
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
            .onAppear {
                if amountText.isEmpty { amountText = Money.format(invoice.open).replacingOccurrences(of: "\u{00A0}€", with: "") }
            }
            // A different payload needs its own idempotency key.
            .onChange(of: useBankRow) { _, _ in key = UUID().uuidString }
            .onChange(of: amountText) { _, _ in key = UUID().uuidString }
            .onChange(of: date) { _, _ in key = UUID().uuidString }
            .task(id: candidateKey) { await findBankRow() }
        }
        .presentationDetents([.medium, .large])
    }

    private var candidateKey: String { "\(amountText)|\(APIDate.dayString(date))" }

    /// Offers the incoming bank row with this amount and a nearby date, so the
    /// money is not counted a second time through an income receipt drafted from it.
    private func findBankRow() async {
        guard let amount = Money.parse(amountText), amount > 0 else { bankRow = nil; return }
        do {
            try await Task.sleep(nanoseconds: 300_000_000)
            let list: PaymentCandidates = try await app.api.get("/api/invoices/\(invoice.id)/payments/candidates",
                query: PaymentCandidates.query(amount: amount, paidDate: APIDate.dayString(date)))
            if list.candidates.first?.transactionId != bankRow?.transactionId { useBankRow = true }
            bankRow = list.candidates.first
        } catch is CancellationError {
        } catch {
            // The offer is a convenience; without it the payment is still recorded.
            bankRow = nil
        }
    }

    private func save() async {
        guard let amount = Money.parse(amountText), amount > 0 else { failure = "Anna summa."; return }
        let carriesRow = bankRow != nil && useBankRow
        if let tooMuch = PaymentEntryRules.overOpenMessage(amount: amount, open: invoice.open, carriesBankRow: carriesRow) {
            failure = tooMuch
            Haptics.error()
            return
        }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let body = PaymentEntry(amount: amount, paidDate: APIDate.dayString(date),
                                    transactionId: carriesRow ? bankRow?.transactionId : nil, note: note)
            let _: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoice.id)/payments", body: body, idempotencyKey: key)
            Haptics.success()
            app.dataVersion += 1
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// The payment reminder review: to whom, how much, then one "Lähetä muistutus".
struct ReminderSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    let preview: ReminderPreview
    let onSent: (String) -> Void
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Vastaanottaja", value: preview.recipient ?? "–")
                    LabeledContent("Avoin pääoma") { MoneyText(amount: preview.open) }
                    if preview.interest > 0 { LabeledContent("Viivästyskorko") { MoneyText(amount: preview.interest) } }
                    if preview.fee > 0 { LabeledContent("Muistutusmaksu") { MoneyText(amount: preview.fee) } }
                    LabeledContent("Maksettava yhteensä") { MoneyText(amount: preview.total).fontWeight(.semibold) }
                } header: {
                    Text("Muistutus \(preview.level) · myöhässä \(preview.daysLate) päivää")
                } footer: {
                    Text("Maksettava viimeistään \(APIDate.displayDay(preview.dueDate)).")
                }
                if let blocked = preview.blockedReason() {
                    Section { Text(blocked).foregroundStyle(Theme.danger) }
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle("Lähetä maksumuistutus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Lähetä") { Task { await send() } }.disabled(busy || preview.blockedReason() != nil)
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func send() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let result: ReminderSendResult = try await app.api.send("POST", "/api/invoices/\(invoice.id)/reminders", body: EmptyBody())
            Haptics.success()
            onSent(result.message)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// "Lähetä lasku": the server checks the send first (recipient, sum, due date, IBAN, attachment)
/// and names what blocks it, with the place to fix it; the send itself goes to the customer's address.
struct SendInvoiceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    let onSent: (InvoiceSendResult) -> Void
    @State private var check: Loadable<InvoiceSendPreview> = .idle
    @State private var busy = false
    @State private var failure: String?
    @State private var key = UUID().uuidString

    var body: some View {
        NavigationStack {
            Form {
                if let preview = check.value {
                    Section {
                        LabeledContent("Vastaanottaja", value: preview.recipient ?? "–")
                        LabeledContent("Summa") { MoneyText(amount: preview.gross) }
                        if preview.showsDueDate, let due = preview.dueDate {
                            LabeledContent("Eräpäivä", value: APIDate.displayDay(due))
                        }
                        if preview.showsIban {
                            LabeledContent("Tilinumero") {
                                HStack(spacing: 8) {
                                    Text(preview.iban ?? "–").textSelection(.enabled)
                                    if let iban = preview.iban {
                                        Button { UIPasteboard.general.string = iban; Haptics.selection() } label: {
                                            Image(systemName: "doc.on.doc")
                                        }
                                        .buttonStyle(.borderless)
                                        .accessibilityLabel("Kopioi IBAN")
                                    }
                                }
                            }
                        }
                        LabeledContent("Liite", value: preview.attachment)
                    }
                    if let blocked = preview.blockedReason {
                        Section {
                            Text(blocked).foregroundStyle(Theme.danger)
                            if let fix = preview.fix {
                                fixLink(fix)
                                if let note = fix.note { Text(note).font(.caption).foregroundStyle(Theme.ink2) }
                            }
                        }
                    }
                    if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
                    Section {
                        Button { Task { await send() } } label: {
                            HStack {
                                Spacer()
                                if busy { ProgressView() } else { Text("Lähetä") }
                                Spacer()
                            }
                        }
                        .buttonStyle(.primary)
                        .disabled(busy || !preview.canSend)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    }
                } else {
                    LoadState(state: check, retry: loadCheck) { (_: InvoiceSendPreview) in EmptyView() }
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle(invoice.isCreditNote ? "Lähetä hyvityslasku" : "Lähetä lasku")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() }.disabled(busy) }
            }
            // Back from a fix (seller details, the customer's e-mail, the mailbox): the check runs again.
            .onAppear { Task { await loadCheck() } }
            .appDestinations()
            .interactiveDismissDisabled(busy)
        }
    }

    @ViewBuilder
    private func fixLink(_ fix: InvoiceSendFix) -> some View {
        let label = Label(fix.title, systemImage: "arrow.right.circle").foregroundStyle(Theme.accentDark)
        switch fix {
        case .sellerDetails: NavigationLink { SellerDetailsScreen() } label: { label }
        case .customerEmail: NavigationLink(value: Route.customer(invoice.customer.id)) { label }
        case .connectMailbox: NavigationLink(value: Route.emailImport) { label }
        case .openPeriod(let month): NavigationLink(value: Route.monthClose(month)) { label }
        }
    }

    private func loadCheck() async {
        if check.value == nil { check = .loading }
        do {
            let response: InvoiceSendPreviewResponse = try await app.api.get("/api/invoices/\(invoice.id)/send")
            check = .loaded(response.preview)
            // A fresh check is a new send, unless a lost answer left it open whether the last one went.
            if failure == nil { key = UUID().uuidString }
        } catch is CancellationError {
        } catch {
            if check.value == nil { check = .failed(error.userMessage) } else { failure = error.userMessage }
        }
    }

    private func send() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            // The web sends `{}`: the address is the customer's, as the check showed.
            let result: InvoiceSendResult = try await app.api.send("POST", "/api/invoices/\(invoice.id)/send", body: EmptyBody(), idempotencyKey: key)
            if result.isWarning { Haptics.error() } else { Haptics.success() }
            onSent(result)
            dismiss()
        } catch {
            failure = InvoiceSendResult.failureMessage(error)
            Haptics.error()
        }
    }
}

/// "Sulje perustelulla": the open remainder is written off with a reason (cash, a credit loss).
struct CloseReasonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onClose: (String) -> Void
    @State private var reason = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Esim. käteinen tai luottotappio", text: $reason)
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.done)
                        .onSubmit(close)
                } header: {
                    Text("Perustelu")
                } footer: {
                    if let problem { Text(problem).foregroundStyle(Theme.danger) }
                }
                Section {
                    Button(action: close) { Text("Sulje perustelulla").frame(maxWidth: .infinity) }
                        .buttonStyle(.primary)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
            }
            .navigationTitle("Sulje perustelulla")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }

    private func close() {
        if let error = InvoiceStatusChange.closeReasonError(reason) {
            problem = error
            Haptics.error()
            return
        }
        onClose(reason)
        dismiss()
    }
}
