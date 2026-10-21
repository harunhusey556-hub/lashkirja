import SwiftUI
import LashKirjaCore

struct InvoiceDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// The customer, a copy and a credit note open on the stack's path (G005, as M024).
    @Environment(\.openRoute) private var openRoute
    @Environment(\.dynamicTypeSize) private var typeSize
    let invoiceId: String
    @State private var state = ScreenLoad<Invoice>()
    @State private var sheet: SheetKind?
    @State private var confirm: ConfirmKind?
    /// Credit, copy, status changes, refund: one at a time, a second tap sends nothing.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    /// The primary's own request (Merkitse maksetuksi): its button shows the wait, the ⋯ menu the others'.
    @State private var primaryBusy = false
    @State private var duplicates: [PaymentDuplicate] = []
    @State private var duplicateBusy: String?
    @State private var reminder: ReminderPreview?
    @State private var reminderFailed = false
    /// Notices and failures alike: a line inserted above the tabs pushed them down once the screen
    /// had settled, and stayed until the next action (U045).
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
    /// Whether this server takes card payments at all (Stripe configured); nil until asked.
    @State private var posStatus: POSStatus?
    /// Card details and refund state of the card payments, by `posPaymentId`.
    @State private var cardPayments: [String: POSPaymentView] = [:]

    /// The credit note made by the credit sheet: pushed once the sheet has closed.
    @State private var creditedId: String?

    /// `preview` (the app's `invoicePreview`) is on screen in the first frame: painted from `load`
    /// instead, after an await, the push showed a spinner first (motion audit lasku-open).
    init(invoiceId: String, preview: InvoicePreview? = nil) {
        self.invoiceId = invoiceId
        guard let preview else { return }
        var shown = ScreenLoad<Invoice>()
        shown.succeed(preview.detail.invoice)
        _state = State(initialValue: shown)
        _duplicates = State(initialValue: preview.detail.paymentDuplicates ?? [])
        _reminder = State(initialValue: preview.reminder)
        _tab = State(initialValue: InvoiceDetailLayout.initialTab(overdue: preview.detail.invoice.displayStatus == .overdue))
    }

    enum SheetKind: Identifiable { case payment, card, send, pdf, edit, reminder, reminderPdf, close, credit; var id: Self { self } }
    enum ConfirmKind: Identifiable, Hashable { case delete, markSent, refund(Invoice.Payment); var id: Self { self } }

    var body: some View {
        List {
            if let invoice = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section { summaryCard(invoice).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                if let main = primaryAction(invoice) {
                    Section { actionBar(main).listRowBackground(Color.clear).listRowInsets(EdgeInsets()) }
                }
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
                .chipRowSection()
                tabContent(invoice, tab: tabs.contains { $0.tab == tab } ? tab : .lines)
            } else {
                ScreenStateView(state: state, retry: load) { (_: Invoice) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(state.value.map { $0.isCreditNote ? "Hyvityslasku \($0.number)" : "Lasku \($0.number)" } ?? "Lasku")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let invoice = state.value { ToolbarItem(placement: .topBarTrailing) { actions(invoice) } } }
        .overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast, action: { runToastAction() }, close: { closeToast() }).padding(.bottom, 8)
            }
        }
        .onDisappear { toastTask?.cancel() }
        .refreshable { await load(force: true) }
        .task { await load() }
        // An overdue invoice opens on its reminder, until the owner picks a tab.
        .onChange(of: state.value?.displayStatus) { _, status in
            if !tabChosen, let status { tab = InvoiceDetailLayout.initialTab(overdue: status == .overdue) }
        }
        .disabled(busy)
        .sheet(item: $sheet, onDismiss: {
            if let id = creditedId {
                creditedId = nil
                openRoute(.invoice(id))
            }
            Task { await load() }
        }) { kind in
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
                // A send that left but was not recorded stays, as a failure does: not said as a success.
                case .send: SendInvoiceSheet(invoice: invoice) { result in
                    if result.isWarning { fail(result.message) } else { say(result.message) }
                }
                case .close: CloseReasonSheet { reason in Task { await setStatus(.close(reason: reason)) } }
                case .credit: InvoiceCreditSheet(invoice: invoice) { id in creditedId = id }
                case .pdf: DocumentPreviewSheet(path: "/api/invoices/\(invoice.id)/pdf", fileName: "Lasku-\(invoice.number).pdf", cacheKey: invoice.updatedAt)
                case .edit: InvoiceFormView(existing: invoice, preview: app.invoiceFormPreview())
                case .reminder:
                    if let reminder {
                        ReminderSheet(invoice: invoice, preview: reminder) { message in say(message) }
                    }
                case .reminderPdf:
                    DocumentPreviewSheet(path: "/api/invoices/\(invoice.id)/reminders/pdf", fileName: "muistutus-\(invoice.number).pdf")
                }
            }
        }
        .confirmSheet(presenting: $confirm) { kind in confirmRequest(kind) }
    }

    private func confirmRequest(_ kind: ConfirmKind) -> ConfirmRequest {
        switch kind {
        case .delete:
            return ConfirmRequest(title: deleteDraftTitle, confirmTitle: "Poista luonnos",
                                  onConfirm: { Task { await deleteDraft() } })
        case .markSent:
            return ConfirmRequest(title: "Merkitäänkö lasku lähetetyksi ilman sähköpostia?", confirmTitle: "Merkitse lähetetyksi",
                                  isDestructive: false, onConfirm: { Task { await setStatus(.markSent) } })
        case .refund(let payment):
            return ConfirmRequest(title: "Palautetaanko korttimaksu \(Money.format(payment.amount))?",
                                  message: "Raha palautetaan asiakkaan kortille Stripen kautta.",
                                  confirmTitle: "Palauta maksu", onConfirm: { Task { await refund(payment) } })
        }
    }

    /// A draft has no number worth naming yet: the customer and the sum say which one goes.
    private var deleteDraftTitle: String {
        guard let invoice = state.value else { return "Poistetaanko luonnos?" }
        return "Poistetaanko luonnos · \(invoice.customer.name), \(Money.format(invoice.gross))?"
    }

    /// Amount, customer, where the invoice stands and the three dates, in one card.
    private func summaryCard(_ invoice: Invoice) -> some View {
        // At accessibility sizes these rows stack: side by side the badge and its line broke to
        // 'Myöhäs/sä' (U069), and the facts in thirds broke their labels and cut the reference to
        // '0…' (U070). The reference then has a line of its own, as wide as the card.
        let large = typeSize.isAccessibilitySize
        let statusRow = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
        let factsRow = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        return VStack(alignment: .leading, spacing: 12) {
            statusRow {
                let due = InvoiceDetailLayout.dueLine(status: invoice.displayStatus, dueDate: invoice.dueDate,
                                                      paidAt: invoice.paidAt, today: APIDate.dayString(Date()))
                // Late is said once, with its days, in the danger tag (U047): the badge beside the
                // line said "Myöhässä" again. A part credit keeps its badge, which says something else.
                if invoice.displayStatus == .overdue && !invoice.isPartlyCredited {
                    StatusBadge(status: .overdue, text: due)
                    if !large { Spacer(minLength: 8) }
                } else {
                    StatusBadge(status: invoice.displayStatus, partlyCredited: invoice.isPartlyCredited)
                    if !large { Spacer(minLength: 8) }
                    Text(due)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(invoice.displayStatus == .overdue ? Theme.danger : Theme.ink2)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                MoneyText(amount: invoice.gross).scaledFont(size: 34, weight: .bold, design: .rounded, relativeTo: .largeTitle).moneyHero()
                // A button, not a NavigationLink: a link would make the whole card one tap target.
                // It pushes onto the path as a link does: pushed beside it, the customer's own invoice
                // rows opened under the customer (G005).
                Button { openRoute(.customer(invoice.customer.id)) } label: {
                    HStack(spacing: 4) {
                        Text(invoice.customer.name).font(.headline).foregroundStyle(Theme.ink)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
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
            if let line = invoice.openAndCreditedLine {
                Text(line).font(.caption).foregroundStyle(Theme.ink2)
            }
            if let line = InvoiceSendState.line(status: invoice.status, sentAt: invoice.sentAt, sends: invoice.sends) {
                sendLine(line)
            }
            Divider()
            factsRow {
                fact("Laskun päivä", APIDate.displayDay(invoice.issueDate))
                fact("Eräpäivä", APIDate.displayDay(invoice.dueDate))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Viite").font(.caption).foregroundStyle(Theme.ink2)
                    Button {
                        UIPasteboard.general.string = invoice.reference
                        Haptics.success()
                        showToast("Viitenumero kopioitu.", action: nil, run: nil)
                    } label: {
                        HStack(spacing: 4) {
                            Text(invoice.reference).font(.subheadline.monospacedDigit()).lineLimitUnlessLarge().minimumScaleFactor(0.8)
                            Image(systemName: "doc.on.doc").font(.caption2)
                        }
                        .foregroundStyle(Theme.ink)
                        // The whole line copies, not only the digits.
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
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
                withMotion(.snappy) { tab = .history }
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

    /// The next step as the one big button; PDF, the e-mail, the payment and the copy are in the ⋯
    /// menu (U006 U015 U029 U046). Beside it as tiles they made five buttons, each also in the menu.
    private func actionBar(_ main: InvoicePrimaryAction) -> some View {
        Button { perform(main) } label: {
            Label(main.title, systemImage: main.symbol)
                .frame(maxWidth: .infinity)
                .opacity(primaryBusy ? 0 : 1)
                .overlay { if primaryBusy { ProgressView().tint(Theme.onInk) } }
        }
        .buttonStyle(.primary)
    }

    private func tabPicker(_ tabs: [InvoiceDetailLayout.TabItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(tabs) { item in
                    SectionChip(title: item.title, selected: item.tab == tab) {
                        tabChosen = true
                        withMotion(.snappy) { tab = item.tab }
                    }
                }
            }
            .padding(.horizontal, ChipRow.inset)
        }
        .accessibilityIdentifier("invoice-tabs")
        .chipRowScroll()
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
                // In ink: as a LabeledContent value it came out the pale secondary grey, the weakest
                // figure on the card (M099).
                LabeledContent("Yhteensä") { MoneyText(amount: invoice.gross).fontWeight(.semibold).foregroundStyle(Theme.ink) }
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
        case .markPaid:
            Task {
                primaryBusy = true
                await markPaid()
                primaryBusy = false
            }
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
            // Were tiles under the primary, the only place they were offered (U046).
            if invoice.open > 0 && invoice.displayStatus != .draft && primaryAction(invoice) != .payment {
                Button { sheet = .payment } label: { Label("Kirjaa maksu", systemImage: "eurosign.circle") }
            }
            if offersCardPayment(invoice) {
                Button { sheet = .card } label: { Label("Korttimaksu", systemImage: "wave.3.right.circle") }
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
                Button { sheet = .credit } label: { Label("Hyvitä", systemImage: "arrow.uturn.backward") }
            }
            if InvoiceStatusChange.canClose(status: invoice.status, open: invoice.open, isCreditNote: invoice.isCreditNote) {
                Button { sheet = .close } label: { Label("Sulje perustelulla", systemImage: "checkmark.seal") }
            }
            if invoice.displayStatus == .draft {
                Button(role: .destructive) { confirm = .delete } label: { Label("Poista luonnos", systemImage: "trash") }
            }
        } label: {
            // A menu action under way (Kopioi luonnokseksi) shows here: the screen said nothing until it failed.
            let waiting = busy && !primaryBusy
            Image(systemName: "ellipsis.circle")
                .opacity(waiting ? 0 : 1)
                .overlay { if waiting { ProgressView() } }
        }
        .accessibilityLabel("Toiminnot")
    }

    private func load() async { await load(force: false) }

    /// The cached invoice at once (opened before, nothing changed since), then the server's when
    /// stale; `force` (pull-to-refresh) always asks.
    private func load(force: Bool) async {
        let timing = ScreenTiming("Lasku")
        let path = "/api/invoices/\(invoiceId)"
        if state.value != nil { timing.painted(fromCache: true) }
        if state.value == nil, let cached: InvoiceDetailResponse = await app.cachedValue(path) {
            state.succeed(cached.invoice)
            duplicates = cached.paymentDuplicates ?? []
            // The reminder tab and its button come with the cached invoice, not a beat later.
            if cached.invoice.displayStatus == .overdue,
               let preview: ReminderPreviewResponse = await app.cachedValue("\(path)/reminders") {
                reminder = preview.reminder
            }
            timing.painted(fromCache: true)
        }
        state.begin()
        do {
            let response: InvoiceDetailResponse = try await app.cachedGet(path, force: force)
            state.succeed(response.invoice)
            timing.dataReady()
            duplicates = response.paymentDuplicates ?? []
            prefetchPdf(response.invoice)
            // The reminder first: it decides the opening tab's content and the main button.
            if response.invoice.displayStatus == .overdue {
                await loadReminder()
            } else {
                reminder = nil
                reminderFailed = false
            }
            app.rememberInvoiceDetail(response, reminder: reminder)
            await loadCardPayments(response.invoice)
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    private func run(_ work: () async throws -> Void) async {
        guard submit.begin() != nil else { return }
        closeFailure()
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do { try await work(); succeeded = true; Haptics.success() }
        catch { fail(error.userMessage); Haptics.error() }
    }

    /// Like `run`, handing over the attempt's Idempotency-Key and saying what happened to the
    /// action when the connection fails. A retry after a failure reuses the key, so the failure
    /// offers `retry`: repeated, the action cannot happen twice.
    private func runKeyed(notDone: String, maybeDone: String, retry: (() async -> Void)? = nil,
                          _ work: (String) async throws -> Void) async {
        guard let key = submit.begin() else { return }
        closeFailure()
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do { try await work(key); succeeded = true; Haptics.success() }
        catch {
            fail(WriteFailureCopy.message(for: error, notDone: notDone, maybeDone: maybeDone, retrySafe: true), retry: retry)
            Haptics.error()
        }
    }

    @discardableResult
    private func setStatus(_ change: InvoiceStatusChange) async -> Bool {
        var done = false
        await run {
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/status", body: change)
            state.succeed(r.invoice)
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

    /// What happened, over the bottom of the screen; gone after five seconds.
    private func say(_ text: String) { showToast(text, action: nil, run: nil) }

    /// A failure stays until it is closed or retried, with the retry only where repeating is safe.
    private func fail(_ text: String, retry: (() async -> Void)? = nil) {
        showToast(text, action: retry == nil ? nil : "Yritä uudelleen", stays: true, run: retry)
    }

    /// A new attempt: the last one's failure no longer stands.
    private func closeFailure() {
        if toast?.stays == true { closeToast() }
    }

    private func showToast(_ text: String, action: String?, stays: Bool = false, run: (() async -> Void)?) {
        toastTask?.cancel()
        toastAction = run
        withMotion(.snappy) { toast = Toast(text: text, actionLabel: action, stays: stays) }
        guard !stays else { return }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withMotion { toast = nil }
            toastAction = nil
        }
    }

    private func runToastAction() {
        let action = toastAction
        toastTask?.cancel()
        toastAction = nil
        withMotion { toast = nil }
        if let action { Task { await action() } }
    }

    private func closeToast() {
        toastTask?.cancel()
        toastAction = nil
        withMotion { toast = nil }
    }

    private func duplicate() async {
        await runKeyed(notDone: "Kopiota ei luotu.", maybeDone: "Kopio on voinut tallentua luonnoksiin.",
                       retry: { await duplicate() }) { key in
            let r: InvoiceResponse = try await app.api.send("POST", "/api/invoices/\(invoiceId)/duplicate", body: EmptyBody(), idempotencyKey: key)
            openRoute(.invoice(r.invoice.id))
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
            say(response.refundNotice)
        }
        await load()
    }

    private func deletePayment(_ payment: Invoice.Payment) async {
        await run {
            let r: InvoiceResponse = try await app.api.send("DELETE", "/api/invoices/\(invoiceId)/payments", query: ["paymentId": payment.id], body: Optional<EmptyBody>.none)
            state.succeed(r.invoice)
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
            let response: ReminderPreviewResponse = try await app.cachedGet("/api/invoices/\(invoiceId)/reminders")
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
        closeFailure()
        defer { duplicateBusy = nil }
        do {
            let body: PaymentLinkRequest = link
                ? .link(paymentId: pair.paymentId, transactionId: pair.transactionId)
                : .dismiss(paymentId: pair.paymentId, receiptId: pair.receiptId)
            let _: Ignored = try await app.api.send("POST", "/api/invoices/\(invoiceId)/payments/link", body: body)
            Haptics.success()
            say(link ? "Maksu yhdistettiin pankkitapahtumaan" : "Merkitty erillisiksi tuloiksi")
            app.dataVersion += 1
            await load()
        } catch {
            fail(error.userMessage)
            Haptics.error()
        }
    }

    @ViewBuilder
    private func reminderSection(_ invoice: Invoice) -> some View {
        if let reminder {
            Section {
                // The days late are the tag's above (U047): said here too, the state stood three times.
                Text("Muistutus \(reminder.level)")
                    .font(.caption).foregroundStyle(Theme.ink2)
                LabeledContent("Avoin pääoma") { MoneyText(amount: reminder.open) }
                if reminder.interest > 0 { LabeledContent("Viivästyskorko") { MoneyText(amount: reminder.interest) } }
                if reminder.fee > 0 { LabeledContent("Muistutusmaksu") { MoneyText(amount: reminder.fee) } }
                LabeledContent("Maksettava yhteensä") { MoneyText(amount: reminder.total).fontWeight(.semibold) }
                Button { sheet = .reminderPdf } label: { Label("Avaa muistutus", systemImage: "doc.richtext") }
                if let wait = reminder.waitNote() {
                    Text(wait).font(.caption).foregroundStyle(Theme.ink2)
                } else if primaryAction(invoice) != .reminder {
                    // Not twice: as the primary it is the button above the tabs (U015).
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
    /// The Helsinki day as the picker draws it: `Date()` drew the device's own day, which off Helsinki
    /// time can be another day than the Helsinki one it saved.
    @State private var date = APIDate.pickerDate(APIDate.dayString(Date())) ?? Date()
    @State private var note = ""
    /// One key until the payment is booked: a retry after a lost answer is replayed, never booked twice.
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var bankRow: PaymentCandidate?
    @State private var useBankRow = true
    /// The amount the sheet filled in itself: only a different one, or a note, is the owner's typing.
    @State private var prefilled = ""
    @State private var confirmDiscard = false
    private var dirty: Bool { amountText != prefilled || !note.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // Named beside the field: the open sum filled in at once hid the placeholder, the
                    // field's only name (U007).
                    LabeledContent("Summa (€)") {
                        TextField("Summa", text: $amountText)
                            .moneyInput()
                            .multilineTextAlignment(.trailing)
                    }
                    DatePicker("Maksupäivä", selection: $date, in: ...(APIDate.pickerDate(APIDate.dayString(Date())) ?? Date()),
                               displayedComponents: .date)
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
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle("Kirjaa maksu")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { InFlightLabel("Tallenna", inFlight: busy) }
                        .disabled(busy || Money.parse(amountText) == nil)
                }
            }
            .onAppear {
                if amountText.isEmpty {
                    amountText = Money.format(invoice.open).replacingOccurrences(of: "\u{00A0}€", with: "")
                    prefilled = amountText
                }
            }
            // The key stays the same when the form is edited after a failure: a refused attempt has
            // released it on the server, and one whose answer was lost must not be booked again
            // with other figures (the server refuses the changed retry instead).
            .task(id: candidateKey) { await findBankRow() }
        }
        // Full height, as the other editor sheets: the discard question stacked on a half-height
        // sheet pushed the form out of view, so "Jatka muokkausta" seemed to lead nowhere (U000).
        .presentationDetents([.large])
        .discardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
    }

    private var candidateKey: String { "\(amountText)|\(APIDate.pickerDay(date))" }

    /// Offers the incoming bank row with this amount and a nearby date, so the
    /// money is not counted a second time through an income receipt drafted from it.
    private func findBankRow() async {
        guard let amount = Money.parse(amountText), amount > 0 else { bankRow = nil; return }
        do {
            try await Task.sleep(nanoseconds: 300_000_000)
            let list: PaymentCandidates = try await app.api.get("/api/invoices/\(invoice.id)/payments/candidates",
                query: PaymentCandidates.query(amount: amount, paidDate: APIDate.pickerDay(date)))
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
            let body = PaymentEntry(amount: amount, paidDate: APIDate.pickerDay(date),
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

/// The payment reminder review: which invoice, to whom, how much, then one "Lähetä". What blocks it
/// comes first, with its fix one tap away (web ReminderSheet): from Koti without a mailbox the
/// sheet was a dead end, and it never named the invoice (X003).
struct ReminderSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let invoice: Invoice
    let onSent: (String) -> Void
    /// Read again each time the sheet shows: back from a fix (the mailbox, the customer's address)
    /// the block lifts.
    @State private var preview: ReminderPreview
    @State private var submit = SubmitGuard()
    private var busy: Bool { submit.inFlight }
    @State private var failure: String?
    @State private var path: [Route] = []

    init(invoice: Invoice, preview: ReminderPreview, onSent: @escaping (String) -> Void) {
        self.invoice = invoice
        self.onSent = onSent
        _preview = State(initialValue: preview)
    }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section {
                    if let blocked = preview.blockedReason() {
                        Text(blocked).foregroundStyle(Theme.danger)
                        if let fix = preview.blockFix { InvoiceFixLink(fix: fix, customerId: invoice.customer.id) }
                    }
                    LabeledContent("Vastaanottaja", value: preview.recipient ?? "–")
                } header: {
                    Text("Lasku \(invoice.number) · \(invoice.customer.name)")
                }
                Section {
                    LabeledContent("Avoin pääoma") { MoneyText(amount: preview.open) }
                    if preview.interest > 0 { LabeledContent("Viivästyskorko") { MoneyText(amount: preview.interest) } }
                    if preview.fee > 0 { LabeledContent("Muistutusmaksu") { MoneyText(amount: preview.fee) } }
                    LabeledContent("Maksettava yhteensä") { MoneyText(amount: preview.total).fontWeight(.semibold) }
                } header: {
                    Text("Muistutus \(preview.level) · myöhässä \(preview.daysLate) päivää")
                } footer: {
                    Text("Maksettava viimeistään \(APIDate.displayDay(preview.dueDate)).")
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            // The bar's Lähetä already says what happens; the long title was cut beside it (X002).
            .navigationTitle("Maksumuistutus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await send() } } label: { InFlightLabel("Lähetä", inFlight: busy) }
                        .disabled(busy || preview.blockedReason() != nil)
                }
            }
            .onAppear { Task { await recheck() } }
            .appDestinations()
            .interactiveDismissDisabled(busy)
        }
        // The fix's screen (the customer, the mailbox) opens within this sheet, not under it.
        .environment(\.openRoute, OpenRouteAction(stack: "reminder") { path.append($0) })
    }

    private func recheck() async {
        do {
            let fresh: ReminderPreviewResponse = try await app.cachedGet("/api/invoices/\(invoice.id)/reminders", force: true)
            preview = fresh.reminder
        } catch is CancellationError {
        } catch {
            // The block shown is the one the sheet opened with; said, so a fix that seems not to
            // lift it has its reason on screen.
            failure = error.userMessage
        }
    }

    private func send() async {
        // The same key on every retry of this reminder: a lost answer is replayed, not mailed twice.
        guard let key = submit.begin() else { return }
        failure = nil
        var succeeded = false
        defer { submit.finish(succeeded: succeeded) }
        do {
            let result: ReminderSendResult = try await app.api.send("POST", "/api/invoices/\(invoice.id)/reminders", body: EmptyBody(), idempotencyKey: key)
            succeeded = true
            Haptics.success()
            onSent(result.message)
            dismiss()
        } catch {
            failure = WriteFailureCopy.message(for: error, notDone: "Muistutusta ei lähetetty.", maybeDone: "Muistutus on voinut lähteä asiakkaalle.", retrySafe: true)
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
    @State private var check = ScreenLoad<InvoiceSendPreview>()
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
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                if let preview = check.value {
                    if let banner = check.banner {
                        Section { RefreshFailureBanner(failure: banner, retry: loadCheck) }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                    // What blocks the send, with its fix, before the message: below it the reason
                    // began at the screen's bottom edge, away from the bar's Lähetä (X028).
                    if let blocked = preview.blockedReason, !preview.canSend(typedRecipient: to) {
                        Section {
                            Text(blocked).foregroundStyle(Theme.danger)
                            if let fix = preview.fix {
                                InvoiceFixLink(fix: fix, customerId: invoice.customer.id)
                                if let note = fix.note { Text(note).font(.caption).foregroundStyle(Theme.ink2) }
                            }
                        }
                    }
                    if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
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
                                            Image(systemName: "doc.on.doc").tapTarget()
                                        }
                                        .buttonStyle(.borderless)
                                        .accessibilityLabel("Kopioi IBAN")
                                    }
                                }
                            }
                        }
                        LabeledContent("Liite", value: preview.attachment)
                    }
                } else {
                    ScreenStateView(state: check, retry: loadCheck) { (_: InvoiceSendPreview) in EmptyView() }
                        .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle(invoice.isCreditNote ? "Lähetä hyvityslasku" : "Lähetä lasku")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() }.disabled(busy) }
                // In the bar, as on the reminder and payment sheets: as the form's last section it
                // was below the first screen (X028).
                ToolbarItem(placement: .confirmationAction) {
                    Button { if let preview = check.value { Task { await send(preview) } } } label: {
                        InFlightLabel("Lähetä", inFlight: busy)
                    }
                    .disabled(!sendable)
                }
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
            .confirmSheet(
                isPresented: $askConvert,
                title: "Korvataanko tämän laskun tiedot paikkamerkeillä?",
                message: "Silloin malli sopii muillekin laskuille: esimerkiksi asiakkaan nimen tilalle tulee {asiakas}.",
                confirmTitle: "Korvaa paikkamerkeillä",
                isDestructive: false,
                secondary: ConfirmRequest.Action(title: "Tallenna sellaisenaan") { Task { await saveTemplate(convert: false) } }
            ) {
                Task { await saveTemplate(convert: true) }
            }
        }
        // A fix's screen (the customer) and what it opens stay within this sheet, not under it.
        .environment(\.openRoute, OpenRouteAction(stack: "send") { path.append($0) })
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
                                Image(systemName: "chevron.up.chevron.down").font(.caption2).accessibilityHidden(true)
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

    /// The bar's Lähetä: a check that has come back and lets it go, and text that can be sent.
    private var sendable: Bool {
        guard let preview = check.value else { return false }
        return !busy && !templateBusy && preview.canSend(typedRecipient: to) && textProblem(preview) == nil
    }

    private func loadCheck() async {
        check.begin()
        do {
            let response: InvoiceSendPreviewResponse = try await app.api.get("/api/invoices/\(invoice.id)/send")
            let preview = response.preview
            check.succeed(preview)
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
            check.fail(error)
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
            // This runs from the name alert's button; a sheet raised while the alert is still leaving
            // the screen is dropped, so the question waits until the alert is gone.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(400))
                askConvert = true
            }
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
            check.update { preview in
                preview.templates = (preview.templates ?? []) + [EmailTemplateRef(id: saved.template.id, name: saved.template.name, isDefault: saved.template.isDefault)]
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

/// Where a blocked send or reminder is fixed, pushed within the sheet that names the block (its
/// `appDestinations`); back on the sheet, the check runs again.
private struct InvoiceFixLink: View {
    let fix: InvoiceSendFix
    let customerId: String

    var body: some View {
        let label = Label(fix.title, systemImage: "arrow.right.circle").foregroundStyle(Theme.accentDark)
        switch fix {
        case .sellerDetails: NavigationLink { SellerDetailsScreen() } label: { label }
        case .customerEmail: NavigationLink(value: Route.customer(customerId)) { label }
        case .connectMailbox: NavigationLink(value: Route.emailImport) { label }
        case .openPeriod(let month): NavigationLink(value: Route.monthClose(month)) { label }
        }
    }
}

/// "Sulje perustelulla": the open remainder is written off with a reason (cash, a credit loss).
struct CloseReasonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onClose: (String) -> Void
    @State private var reason = ""
    @State private var problem: String?
    @State private var confirmDiscard = false
    private var dirty: Bool { !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

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
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .formKeyboard()
            .navigationTitle("Sulje perustelulla")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Peruuta") { if dirty { confirmDiscard = true } else { dismiss() } }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationBackground(Theme.canvas)
        .discardGuard(dirty: dirty, busy: false, asking: $confirmDiscard) { dismiss() }
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
