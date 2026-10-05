import SwiftUI
import LashKirjaCore

struct InvoiceDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoiceId: String
    @State private var state: Loadable<Invoice> = .idle
    @State private var sheet: SheetKind?
    @State private var confirm: ConfirmKind?
    /// Credit, copy, status changes, refund: one at a time, a second tap sends nothing.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
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
    /// One group at a time instead of rows, payments, reminder and history stacked down the screen.
    @State private var tab: InvoiceDetailLayout.Tab = .lines
    @State private var tabChosen = false
    @State private var customerRoute: Route?
    /// Whether this server takes card payments at all (Stripe configured); nil until asked.
    @State private var posStatus: POSStatus?
    /// Card details and refund state of the card payments, by `posPaymentId`.
    @State private var cardPayments: [String: POSPaymentView] = [:]

    enum SheetKind: Identifiable { case payment, card, send, pdf, edit, reminder, reminderPdf, close; var id: Self { self } }
    enum ConfirmKind: Identifiable, Hashable { case delete, credit, markSent, refund(Invoice.Payment); var id: Self { self } }

    var body: some View {
        List {
            if let invoice = state.value {
                Section { summaryCard(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                Section { actionBar(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger).font(.footnote) } }
                if let warning { Section { Text(warning).foregroundStyle(Theme.warning).font(.footnote) } }
                if let notice { Section { Text(notice).foregroundStyle(Theme.success).font(.footnote) } }
                // A possible double payment needs a decision, so it stays above the tabs.
                if !duplicates.isEmpty {
                    Section("Tarkista maksu") {
                        ForEach(duplicates) { pair in duplicateRow(pair) }
                    }
                }
                let tabs = InvoiceDetailLayout.tabs(payments: invoice.payments.count, activity: invoice.activity.count + invoice.sends.count,
                                                    overdue: invoice.displayStatus == .overdue)
                Section {
                    tabPicker(tabs)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                tabContent(invoice, tab: tabs.contains { $0.tab == tab } ? tab : .lines)
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
        .navigationDestination(item: $customerRoute) { route in RouteScreen(route: route) }
        .refreshable { await load() }
        .task { await load() }
        // An overdue invoice opens on its reminder, until the owner picks a tab.
        .onChange(of: state.value?.displayStatus) { _, status in
            if !tabChosen, let status { tab = InvoiceDetailLayout.initialTab(overdue: status == .overdue) }
        }
        .disabled(busy)
        .sheet(item: $sheet, onDismiss: { Task { await load() } }) { kind in
            if let invoice = state.value {
                switch kind {
                case .payment: PaymentSheet(invoice: invoice)
                case .card: POSPaymentSheet(invoice: invoice) {
                    // After the card sheet has gone: one sheet at a time.
                    Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        sheet = .send
                    }
                }
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
            case .refund(let payment): Button("Palauta maksu", role: .destructive) { Task { await refund(payment) } }
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
        case .refund(let payment): "Palautetaanko korttimaksu \(Money.format(payment.amount))? Raha palautetaan asiakkaan kortille Stripen kautta."
        case nil: ""
        }
    }

    /// Amount, customer, where the invoice stands and the three dates, in one card.
    private func summaryCard(_ invoice: Invoice) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                StatusBadge(status: invoice.displayStatus)
                Spacer(minLength: 8)
                Text(InvoiceDetailLayout.dueLine(status: invoice.displayStatus, dueDate: invoice.dueDate,
                                                 paidAt: invoice.paidAt, today: APIDate.dayString(Date())))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(invoice.displayStatus == .overdue ? Theme.danger : Theme.ink2)
            }
            VStack(alignment: .leading, spacing: 2) {
                MoneyText(amount: invoice.gross).font(.system(size: 34, weight: .bold, design: .rounded))
                // A button, not a NavigationLink: a link would make the whole card one tap target.
                Button { customerRoute = .customer(invoice.customer.id) } label: {
                    HStack(spacing: 4) {
                        Text(invoice.customer.name).font(.headline).foregroundStyle(Theme.ink)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
                    }
                }
                .buttonStyle(.borderless)
            }
            if let fraction = InvoiceDetailLayout.paidFraction(gross: invoice.gross, paid: invoice.paid) {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: fraction).tint(Theme.success)
                    Text("Maksettu \(Money.format(invoice.paid)) · avoinna \(Money.format(invoice.open))")
                        .font(.caption).foregroundStyle(Theme.ink2)
                }
            }
            if let line = InvoiceSendState.line(status: invoice.status, sentAt: invoice.sentAt, sends: invoice.sends) {
                sendLine(line)
            }
            Divider()
            HStack(alignment: .top, spacing: 12) {
                fact("Päivätty", APIDate.displayDay(invoice.issueDate))
                fact("Eräpäivä", APIDate.displayDay(invoice.dueDate))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Viite").font(.caption).foregroundStyle(Theme.ink2)
                    Button {
                        UIPasteboard.general.string = invoice.reference
                        Haptics.success()
                        showToast("Viitenumero kopioitu.", action: nil, run: nil)
                    } label: {
                        HStack(spacing: 4) {
                            Text(invoice.reference).font(.subheadline.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.8)
                            Image(systemName: "doc.on.doc").font(.caption2)
                        }
                        .foregroundStyle(Theme.ink)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Kopioi viitenumero \(invoice.reference)")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let barcode = invoice.barcode {
                Button { copyBarcode(barcode) } label: {
                    Label("Kopioi virtuaaliviivakoodi", systemImage: "barcode")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.borderless)
            }
            if let issue = invoice.barcodeIssue, !issue.isEmpty {
                Text(issue).font(.caption).foregroundStyle(Theme.ink2)
            }
            if let reason = invoice.closedReason, !reason.isEmpty {
                Text("Suljettu: \(reason)").font(.caption).foregroundStyle(Theme.ink2)
            }
        }
        .padding(16)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }

    /// Whether the invoice reached the customer. The line opens Historia, where every attempt is;
    /// a plain failure also offers the send sheet again.
    private func sendLine(_ line: InvoiceSendState.Line) -> some View {
        let color: Color = switch line.tone {
        case .muted: Theme.ink2
        case .warning: Theme.warning
        case .danger: Theme.danger
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button {
                tabChosen = true
                withAnimation(.snappy) { tab = .history }
            } label: {
                Label(line.text, systemImage: line.tone == .muted ? "paperplane" : "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(color)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            if line.canRetry {
                Button("Yritä uudelleen") { sheet = .send }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    private func copyBarcode(_ barcode: String) {
        UIPasteboard.general.string = barcode
        Haptics.success()
        showToast("Virtuaaliviivakoodi kopioitu.", action: nil, run: nil)
    }

    private func fact(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(Theme.ink2)
            Text(value).font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The next step as the one big button, and PDF / send / copy within a thumb's reach
    /// instead of behind the ⋯ menu.
    private func actionBar(_ invoice: Invoice) -> some View {
        VStack(spacing: 10) {
            if let main = primaryAction(invoice) {
                Button { perform(main) } label: {
                    Label(main.title, systemImage: main.symbol).frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
            }
            HStack(spacing: 10) {
                quickAction("PDF", symbol: "doc.richtext") { sheet = .pdf }
                if invoice.status != "credited" && primaryAction(invoice) != .send {
                    quickAction("Lähetä", symbol: "paperplane") { sheet = .send }
                }
                if invoice.open > 0 && invoice.displayStatus != .draft && primaryAction(invoice) != .payment {
                    quickAction("Maksu", symbol: "eurosign.circle") { sheet = .payment }
                }
                if offersCardPayment(invoice) {
                    quickAction("Korttimaksu", symbol: "wave.3.right.circle") { sheet = .card }
                }
                if invoice.displayStatus == .draft {
                    quickAction("Muokkaa", symbol: "pencil") { sheet = .edit }
                } else {
                    quickAction("Kopioi", symbol: "plus.square.on.square") { Task { await duplicate() } }
                }
            }
        }
    }

    private func quickAction(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.body.weight(.semibold))
                Text(title).font(.caption)
            }
            .foregroundStyle(Theme.accent)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.borderless)
    }

    private func tabPicker(_ tabs: [InvoiceDetailLayout.TabItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(tabs) { item in
                    SectionChip(title: item.title, selected: item.tab == tab) {
                        tabChosen = true
                        withAnimation(.snappy) { tab = item.tab }
                    }
                }
            }
        }
    }

    @ViewBuilder private func tabContent(_ invoice: Invoice, tab: InvoiceDetailLayout.Tab) -> some View {
        switch tab {
        case .lines:
            Section {
                ForEach(invoice.lines.prefix(lineLimit.visible(invoice.lines.count))) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(line.description)
                            Spacer()
                            MoneyText(amount: line.net)
                        }
                        Text("\(Self.number(line.quantity)) \(line.unit) × \(Money.format(line.unitPrice)) · ALV \(Self.number(line.vatRate)) %")
                            .font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                ShowMoreButton(limit: $lineLimit, total: invoice.lines.count)
                LabeledContent("Veroton") { MoneyText(amount: invoice.net) }.font(.subheadline)
                LabeledContent("ALV") { MoneyText(amount: invoice.vat) }.font(.subheadline)
                LabeledContent("Yhteensä") { MoneyText(amount: invoice.gross).fontWeight(.semibold) }
            }
        case .payments:
            Section {
                if invoice.payments.isEmpty {
                    Text("Ei maksuja.").foregroundStyle(Theme.ink2)
                }
                ForEach(invoice.payments.prefix(paymentLimit.visible(invoice.payments.count))) { payment in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(APIDate.displayDay(payment.paidDate))
                            if payment.isCardPayment {
                                Label(cardLabel(payment), systemImage: "wave.3.right.circle")
                                    .font(.caption).foregroundStyle(Theme.ink2)
                            }
                            if let note = payment.note { Text(note).font(.caption).foregroundStyle(Theme.ink2) }
                        }
                        Spacer()
                        MoneyText(amount: payment.amount)
                    }
                    // A card payment is undone by refunding it through Stripe; the server refuses a delete.
                    .swipeActions {
                        if payment.isCardPayment {
                            if canRefund(payment) {
                                Button("Palauta maksu") { confirm = .refund(payment) }.tint(Theme.accentFill)
                            }
                        } else {
                            Button("Poista", role: .destructive) { Task { await deletePayment(payment) } }
                        }
                    }
                    .contextMenu {
                        if payment.isCardPayment && canRefund(payment) {
                            Button { confirm = .refund(payment) } label: { Label("Palauta maksu", systemImage: "arrow.uturn.backward") }
                        }
                    }
                }
                ShowMoreButton(limit: $paymentLimit, total: invoice.payments.count)
                if invoice.open > 0 && invoice.displayStatus != .draft {
                    Button { sheet = .payment } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
                }
            }
        case .reminder:
            reminderSection(invoice)
        case .history:
            Section {
                // Events and send attempts in one feed, newest first, as on the web.
                let items = InvoiceSendState.history(activity: invoice.activity, sends: invoice.sends)
                ForEach(items.prefix(activityLimit.visible(items.count))) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline)
                            .foregroundStyle(item.tone == .danger ? Theme.danger : item.tone == .warning ? Theme.warning : Theme.ink)
                        Text(item.meta).font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                ShowMoreButton(limit: $activityLimit, total: items.count)
            }
        }
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
            if let barcode = invoice.barcode {
                Button { copyBarcode(barcode) } label: { Label("Kopioi virtuaaliviivakoodi", systemImage: "barcode") }
            }
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
            await loadCardPayments(response.invoice)
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
        guard submit.begin() != nil else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do { try await work(); succeeded = true; Haptics.success() }
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

    /// Card payments need Stripe on the server, a sent invoice and money still open; whether the
    /// owner's account and this iPhone are ready is explained in the sheet itself.
    private func offersCardPayment(_ invoice: Invoice) -> Bool {
        posStatus?.enabled == true && invoice.open > 0 && !invoice.isCreditNote
            && (invoice.displayStatus == .sent || invoice.displayStatus == .overdue)
    }

    private func cardLabel(_ payment: Invoice.Payment) -> String {
        let view = payment.posPaymentId.flatMap { cardPayments[$0] }
        let label = POSCard.label(brand: payment.cardBrand ?? view?.cardBrand, last4: payment.cardLast4 ?? view?.cardLast4) ?? "Korttimaksu"
        if let view, view.refunded > 0 { return "\(label) · palautettu \(Money.format(view.refunded))" }
        return label
    }

    private func canRefund(_ payment: Invoice.Payment) -> Bool {
        guard let id = payment.posPaymentId else { return false }
        return cardPayments[id]?.isRefundable ?? true
    }

    /// The POS status (once per screen) and, when the invoice has card payments, their card details.
    private func loadCardPayments(_ invoice: Invoice) async {
        let pos = POSCoordinator.shared
        pos.bind(app)
        if posStatus == nil {
            if let known = pos.status { posStatus = known } else { posStatus = await pos.refreshStatus() }
        }
        guard invoice.payments.contains(where: \.isCardPayment) else { return }
        if let list: POSPaymentsResponse = try? await app.api.get("/api/pos/payments", query: ["invoiceId": invoice.id]) {
            cardPayments = Dictionary(list.payments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
    }

    /// The whole remaining amount back to the customer's card; the server then reduces the invoice
    /// payment so the open balance is right again.
    private func refund(_ payment: Invoice.Payment) async {
        guard let posId = payment.posPaymentId else { return }
        await run {
            let response: POSFinalizeResponse = try await app.api.send("POST", "/api/pos/payments/\(posId)/refund", body: POSRefundRequest(),
                                                                       idempotencyKey: "pos-refund-\(posId)-\(payment.id)")
            notice = response.refundNotice
            warning = nil
        }
        await load()
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
            Section {
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
            Section {
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
    /// One key until the payment is booked: a retry after a lost answer is replayed, never booked twice.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
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
                    Button { Task { await save() } } label: { InFlightLabel("Tallenna", inFlight: busy) }
                        .disabled(busy || Money.parse(amountText) == nil)
                }
            }
            .onAppear {
                if amountText.isEmpty { amountText = Money.format(invoice.open).replacingOccurrences(of: "\u{00A0}€", with: "") }
            }
            // The key stays the same when the form is edited after a failure: a refused attempt has
            // released it on the server, and one whose answer was lost must not be booked again
            // with other figures (the server refuses the changed retry instead).
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
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let body = PaymentEntry(amount: amount, paidDate: APIDate.dayString(date),
                                    transactionId: carriesRow ? bankRow?.transactionId : nil, note: note)
            let _: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoice.id)/payments", body: body, idempotencyKey: key)
            succeeded = true
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
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
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
                    Button { Task { await send() } } label: { InFlightLabel("Lähetä", inFlight: busy) }
                        .disabled(busy || preview.blockedReason() != nil)
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func send() async {
        // The reminder route takes no Idempotency-Key: the guard is what keeps a second tap from mailing twice.
        guard submit.begin() != nil else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let result: ReminderSendResult = try await app.api.send("POST", "/api/invoices/\(invoice.id)/reminders", body: EmptyBody())
            succeeded = true
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
/// and names what blocks it, with the place to fix it. The check also hands over the subject and
/// message (the default template or the built-in text, filled for this invoice) to edit before sending.
struct SendInvoiceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    let onSent: (InvoiceSendResult) -> Void
    @State private var check: Loadable<InvoiceSendPreview> = .idle
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var to = ""
    @State private var subject = ""
    @State private var message = ""
    @State private var templateId: String?
    /// The text is filled once; a check run again (back from a fix) keeps what the owner typed.
    @State private var filled = false
    @State private var templateBusy = false
    @State private var askName = false
    @State private var templateName = ""
    @State private var askConvert = false
    @State private var templateNotice: String?

    var body: some View {
        NavigationStack {
            Form {
                if let preview = check.value {
                    mailSection(preview)
                    Section {
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
                    if let blocked = preview.blockedReason, !preview.canSend(typedRecipient: to) {
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
                        Button { Task { await send(preview) } } label: {
                            HStack {
                                Spacer()
                                if busy { ProgressView() } else { Text("Lähetä") }
                                Spacer()
                            }
                        }
                        .buttonStyle(.primary)
                        .disabled(busy || templateBusy || !preview.canSend(typedRecipient: to) || textProblem(preview) != nil)
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
            .alert("Tallenna mallina", isPresented: $askName) {
                TextField("Mallin nimi", text: $templateName)
                Button("Tallenna") { nameChosen() }
                Button("Peruuta", role: .cancel) {}
            } message: {
                Text("Malli löytyy myöhemmin kohdasta Asetukset → Sähköpostimallit.")
            }
            .confirmationDialog("Korvataanko tämän laskun tiedot paikkamerkeillä?", isPresented: $askConvert, titleVisibility: .visible) {
                Button("Korvaa paikkamerkeillä") { Task { await saveTemplate(convert: true) } }
                Button("Tallenna sellaisenaan") { Task { await saveTemplate(convert: false) } }
                Button("Peruuta", role: .cancel) {}
            } message: {
                Text("Silloin malli sopii muillekin laskuille: esimerkiksi asiakkaan nimen tilalle tulee {asiakas}.")
            }
        }
    }

    /// To, template, subject and message. A server without the text fields gets the old fixed recipient row.
    @ViewBuilder
    private func mailSection(_ preview: InvoiceSendPreview) -> some View {
        if preview.subject == nil || preview.message == nil {
            Section { LabeledContent("Vastaanottaja", value: preview.recipient ?? "–") }
        } else {
            Section {
                LabeledContent("Vastaanottaja") {
                    TextField("Asiakkaan sähköposti", text: $to)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                }
                if let templates = preview.templates, !templates.isEmpty {
                    Menu {
                        ForEach(templates) { template in
                            Button { Task { await applyTemplate(template.id) } } label: {
                                if template.id == templateId { Label(template.name, systemImage: "checkmark") } else { Text(template.name) }
                            }
                        }
                    } label: {
                        LabeledContent("Malli") {
                            HStack(spacing: 4) {
                                if templateBusy { ProgressView() }
                                Text(templates.first { $0.id == templateId }?.name ?? "Valitse")
                                Image(systemName: "chevron.up.chevron.down").font(.caption2)
                            }
                            .foregroundStyle(Theme.accent)
                        }
                    }
                    .disabled(templateBusy || busy)
                }
                TextField("Aihe", text: $subject)
                    .textInputAutocapitalization(.sentences)
                TextEditor(text: $message)
                    .frame(minHeight: 160)
                    .accessibilityLabel("Viesti")
                Button { templateName = ""; askName = true } label: {
                    Label("Tallenna mallina", systemImage: "square.and.arrow.down")
                }
                .disabled(templateBusy || busy || textProblem(preview) != nil)
            } header: {
                Text("Viesti")
            } footer: {
                if let problem = textProblem(preview) {
                    Text(problem).foregroundStyle(Theme.danger)
                } else if let templateNotice {
                    Text(templateNotice).foregroundStyle(Theme.success)
                } else {
                    Text("PDF-lasku tulee liitteeksi. Paikkamerkit, kuten {asiakas} tai {summa}, täytetään lähetettäessä.")
                }
            }
        }
    }

    /// Only what the owner can fix here; an empty address is the server's block, said in its own section.
    private func textProblem(_ preview: InvoiceSendPreview) -> String? {
        guard preview.subject != nil, preview.message != nil else { return nil }
        if !to.trimmingCharacters(in: .whitespaces).isEmpty, let bad = InvoiceMailText.recipientError(to) { return bad }
        return InvoiceMailText.subjectError(subject) ?? InvoiceMailText.messageError(message)
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
            let preview = response.preview
            check = .loaded(preview)
            if !filled {
                to = preview.recipient ?? ""
                subject = preview.subject ?? ""
                message = preview.message ?? ""
                templateId = preview.templateId
                filled = true
            } else if to.trimmingCharacters(in: .whitespaces).isEmpty {
                // Back from adding the customer's address: it fills the empty field.
                to = preview.recipient ?? ""
            }
            // A fresh check is a new send, unless a lost answer left it open whether the last one went.
            if failure == nil { submit.renew() }
        } catch is CancellationError {
        } catch {
            if check.value == nil { check = .failed(error.userMessage) } else { failure = error.userMessage }
        }
    }

    /// The chosen template, filled for this invoice by the server; it replaces the text in the editor.
    private func applyTemplate(_ id: String) async {
        templateBusy = true
        templateNotice = nil
        defer { templateBusy = false }
        do {
            let response: InvoiceSendPreviewResponse = try await app.api.get("/api/invoices/\(invoice.id)/send", query: ["templateId": id])
            subject = response.preview.subject ?? subject
            message = response.preview.message ?? message
            templateId = id
            Haptics.selection()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func nameChosen() {
        if let problem = InvoiceMailText.nameError(templateName) {
            templateNotice = nil
            failure = problem
            Haptics.error()
            return
        }
        let values = check.value?.placeholders ?? [:]
        if EmailTemplateText.hasInvoiceValues(subject + "\n" + message, values: values) {
            askConvert = true
        } else {
            Task { await saveTemplate(convert: false) }
        }
    }

    private func saveTemplate(convert: Bool) async {
        let values = check.value?.placeholders ?? [:]
        let draft = EmailTemplateDraft(
            name: templateName,
            subject: convert ? EmailTemplateText.toPlaceholders(subject, values: values) : subject,
            body: convert ? EmailTemplateText.toPlaceholders(message, values: values) : message,
            isDefault: false
        )
        if let problem = draft.problem { failure = problem; Haptics.error(); return }
        templateBusy = true
        failure = nil
        defer { templateBusy = false }
        do {
            let saved: EmailTemplateResponse = try await app.api.send("POST", "/api/invoice-email-templates", body: draft)
            if var preview = check.value {
                preview.templates = (preview.templates ?? []) + [EmailTemplateRef(id: saved.template.id, name: saved.template.name, isDefault: saved.template.isDefault)]
                check = .loaded(preview)
            }
            templateId = saved.template.id
            templateNotice = "Malli \(saved.template.name) tallennettiin."
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func send(_ preview: InvoiceSendPreview) async {
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let result: InvoiceSendResult
            if preview.subject == nil || preview.message == nil {
                // A server without editable text: the customer's address and its own text, as before.
                result = try await app.api.send("POST", "/api/invoices/\(invoice.id)/send", body: EmptyBody(), idempotencyKey: key)
            } else {
                let body = InvoiceSendBody(recipient: preview.recipient, to: to, subject: subject, message: message)
                result = try await app.api.send("POST", "/api/invoices/\(invoice.id)/send", body: body, idempotencyKey: key)
            }
            succeeded = true
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
