import SwiftUI
import Charts
import LashKirjaCore

struct KotiView: View {
    @Environment(AppModel.self) private var app
    @State private var model: KotiModel?
    /// Coming back to the tab does not ask the server again unless something changed.
    @State private var gate = ReloadGate()

    var body: some View {
        Group {
            if let model {
                KotiContent(model: model)
            } else {
                ProgressView()
            }
        }
        .task(id: app.dataVersion) {
            if model == nil {
                let app = self.app
                model = KotiModel(api: app.api, profile: { await app.cachedProfile() })
            }
            guard model?.state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await model?.load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }
}

/// Koti, top to bottom (`KotiLayout.sections`): the month's status, Rahatilanne, what needs
/// doing, the month's sales and costs, open invoices, the six-month history.
private struct KotiContent: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: KotiModel
    /// The bank row a receipt is being photographed for.
    @State private var captureFor: CaptureTarget?
    /// Täydennä: the pending receipt whose gaps the approval sheet asks for.
    @State private var approvalTarget: DashboardItem?
    /// "Avaa kuitti" from the approval sheet: pushed once the sheet has closed.
    @State private var openAfterApproval: String?
    /// Muistuta: the invoice and its reminder preview, once both have loaded.
    @State private var remindTarget: RemindTarget?
    /// The task row whose reminder is loading (its pill shows a spinner).
    @State private var remindLoading: String?
    /// Koti is a dashboard: five tasks, the rest on request, so the cards below stay in reach.
    @State private var taskLimit = ShowMore(step: 5)
    @Environment(\.dynamicTypeSize) private var typeSize

    struct CaptureTarget: Identifiable { let id = UUID(); let transactionId: String? }
    struct RemindTarget: Identifiable { let invoice: Invoice; let preview: ReminderPreview; var id: String { invoice.id } }

    var body: some View {
        ScrollView {
            LoadState(state: model.state, retry: model.load) { dashboard in
                let sections = KotiLayout.sections(.init(dashboard: dashboard, atCurrentMonth: model.atCurrentMonth,
                                                         hasTasks: !model.visibleItems.isEmpty, failedJobs: model.failedJobs,
                                                         onboardingOpen: OnboardingGate.shared.isSnoozed))
                VStack(alignment: .leading, spacing: 12) {
                    header(dashboard)
                    ForEach(sections, id: \.self) { section in
                        sectionView(section, dashboard)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
        }
        .background(Theme.canvas)
        .refreshable { await model.load() }
        // Another month has its own tasks: back to the first five.
        .onChange(of: model.month) { _, _ in taskLimit.reset() }
        .fullScreenCover(item: $captureFor, onDismiss: { Task { await model.load() } }) { target in
            CaptureFlow(transactionId: target.transactionId)
        }
        .sheet(item: $approvalTarget, onDismiss: {
            guard let id = openAfterApproval else { return }
            openAfterApproval = nil
            app.pendingRoute = PendingRoute(tab: .koti, route: .receipt(id))
        }) { item in
            KotiApprovalSheet(item: item, approve: { model.approve(item) }, openReceipt: { openAfterApproval = item.receiptId })
        }
        .sheet(item: $remindTarget) { target in
            ReminderSheet(invoice: target.invoice, preview: target.preview) { message in model.say(message) }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast) { model.undo() }.padding(.bottom, 8)
            }
        }
        .navigationTitle(MonthKey.title(model.month, currentYear: String(MonthKey.current().prefix(4))))
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                Button { Task { await model.step(-1) } } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("Edellinen kuukausi")
                Button { Task { await model.step(1) } } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel("Seuraava kuukausi")
                    .disabled(model.atCurrentMonth)
            }
        }
    }

    @ViewBuilder private func sectionView(_ section: KotiSection, _ d: Dashboard) -> some View {
        switch section {
        case .onboarding:
            OnboardingResumeCard { OnboardingGate.shared.resume() }
        case .vatThreshold:
            if let notice = Koti.vatThreshold(d) { VatThresholdCard(notice: notice) }
        case .status:
            statusCard(d)
        case .partialFailure:
            PartialFailureNotice(messages: Koti.failedSections(d.sectionErrors)) { await model.load() }
        case .setup:
            if let setup = d.setup {
                if Koti.isFreshAccount(d) {
                    FirstRunCard(progress: Koti.setupProgress(setup), capture: { captureFor = CaptureTarget(transactionId: nil) })
                } else {
                    SetupCard(setup: setup, capture: { captureFor = CaptureTarget(transactionId: nil) })
                }
            }
        case .firstRunNote:
            FirstRunNote()
        case .balance:
            if let bank = d.bank {
                BalanceCard(bank: bank, trend: BalanceTrend(d.bankTrend),
                            title: Koti.positionTitle(atCurrentMonth: model.atCurrentMonth))
            }
        case .tasks:
            tasks
        case .failedJobs:
            failedJobsRow
        case .money:
            moneyCards(d)
        case .positions:
            positions(Koti.positionRows(d),
                      title: Koti.positionsTitle(hasBalanceCard: Koti.showsBalanceCard(d.bank), atCurrentMonth: model.atCurrentMonth))
        case .cashflow:
            CashflowCard(months: d.cashflow, selected: d.month) { month in Task { await model.show(month: month) } }
        case .handled:
            if let handled = d.handled { HandledCard(handled: handled) }
        }
    }

    /// By the hour of the owner's clock, as on the web; without a name there is no line.
    @ViewBuilder private func header(_ d: Dashboard) -> some View {
        if let greeting = Koti.greeting(at: Date(), firstName: d.firstName) {
            Text(greeting)
                .font(.subheadline)
                .foregroundStyle(Theme.ink2)
        }
    }

    /// The month's checklist, and the VAT estimate as one line under it.
    private func statusCard(_ d: Dashboard) -> some View {
        let blocking = max(0, (d.blockingTotal ?? 0) - (d.items.count - model.visibleItems.count))
        let status = Koti.monthStatus(done: d.events?.done ?? d.matching.matched,
                                      total: d.events?.total ?? d.matching.matchable, blocking: blocking)
        return Card {
            NavigationLink(value: Route.monthClose(d.month)) {
                HStack(alignment: .center, spacing: 14) {
                    // Nothing counted is not 100 %: an empty ring with no figure instead.
                    if let progress = status.progress {
                        ProgressRing(progress: progress)
                            .frame(width: 44, height: 44)
                    } else {
                        Circle().stroke(Theme.line, lineWidth: 5)
                            .frame(width: 44, height: 44)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(status.headline).font(.headline).foregroundStyle(Theme.ink)
                        if let detail = status.detail {
                            Text(detail).font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    Spacer(minLength: 8)
                    Chevron()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if model.atCurrentMonth, let previous = d.previousMonth {
                Divider()
                NavigationLink(value: Route.monthClose(previous.month)) {
                    HStack(spacing: 8) {
                        Image(systemName: "calendar.badge.checkmark").foregroundStyle(Theme.ink2).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Koti.previousMonthLine(previous)).font(.subheadline).foregroundStyle(Theme.ink)
                            Text("Kuukauden sulkeminen").font(.caption).foregroundStyle(Theme.ink2)
                        }
                        Spacer(minLength: 8)
                        Chevron()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if let due = model.vatDue {
                Divider()
                vatDueRow(due, figures: model.vatFigures)
            }
        }
    }

    /// ALV-ilmoitus (web FP-4): the return due, its deadline and state, and the period's figure.
    /// Opens the ALV screen on that period.
    private func vatDueRow(_ due: KotiVatDue, figures: VatDueFigures?) -> some View {
        let secondary = Koti.vatDueSecondary(due, figures)
        return NavigationLink(value: Route.alv(due.lastMonth)) {
            HStack(spacing: 8) {
                Image(systemName: "percent").foregroundStyle(Theme.ink2).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Koti.vatDueTitle).font(.subheadline).foregroundStyle(Theme.ink)
                    Text(secondary).font(.caption).foregroundStyle(Theme.ink2)
                    ForEach(Koti.vatDueNotes(figures), id: \.self) { note in
                        Text(note).font(.caption).foregroundStyle(Theme.warning)
                    }
                }
                Spacer(minLength: 8)
                if let figures {
                    MoneyText(amount: figures.amount).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                }
                Chevron()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }

    /// Shown only while an import or a fetch has failed; the queue has the reason and the retry.
    private var failedJobsRow: some View {
        NavigationLink(value: Route.workQueue) {
            HStack(spacing: 12) {
                RowIcon(symbol: "exclamationmark.triangle", tint: Theme.danger)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tuonnit ja virheet").font(.body).foregroundStyle(Theme.ink)
                    Text(JobsQueue.failedSummary(model.failedJobs)).font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Myynti and Kulut side by side; stacked at the largest text sizes so the figures fit.
    private func moneyCards(_ d: Dashboard) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            ForEach([MoneyTrend.Metric.income, .expenses], id: \.self) { metric in
                let income = metric == .income
                let amount = income ? d.income : d.expenses
                // As on the web: the card opens the month's sales (its invoices when it has any) or
                // costs, from the books' basis.
                let route = Route.forDrill(.koti(income: income, source: d.source, invoiceCount: d.invoiceCount, month: d.month))
                NavigationLink(value: route) {
                    MoneyCard(title: income ? "Myynti \(MonthKey.name(d.month).lowercased())" : "Kulut",
                              amount: amount,
                              tint: income ? Theme.success : Theme.accent,
                              trend: MoneyTrend.make(rows: d.cashflow, month: d.month, source: d.source, metric: metric, value: amount),
                              income: income)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var tasks: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Tarvitaan sinulta")
            let items = model.visibleItems
            VStack(spacing: 0) {
                ForEach(Array(items.prefix(taskLimit.visible(items.count)).enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().padding(.leading, 60) }
                    taskRow(item)
                        .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
                }
                if taskLimit.buttonTitle(total: items.count) != nil {
                    Divider().padding(.leading, 16)
                    ShowMoreButton(limit: $taskLimit, total: items.count)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                        .buttonStyle(.plain)
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .animation(.snappy, value: model.visibleItems)
        }
    }

    /// A row opens what it is about (the receipt, the bank row, the invoice); its pill
    /// (Hyväksy, Kohdista, Kuvaa kuitti) stays its own button inside the link.
    @ViewBuilder private func taskRow(_ item: DashboardItem) -> some View {
        let row = TaskRow(item: item, busy: remindLoading == item.id,
                          approve: { model.approve(item) }, complete: { approvalTarget = item },
                          confirm: { model.confirmMatch(item) },
                          capture: { captureFor = CaptureTarget(transactionId: item.transactionId) },
                          remind: { openReminder(item) })
        if let route = Route.forItem(item, month: model.month) {
            NavigationLink(value: route) {
                row.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            row
        }
    }

    /// Muistuta (web ReminderSheet): the invoice and its reminder preview load together, then the
    /// sheet opens; a failure is said in the toast and the row stays.
    private func openReminder(_ item: DashboardItem) {
        guard let invoiceId = item.invoiceId, remindLoading == nil else { return }
        let api = app.api
        remindLoading = item.id
        Task {
            defer { remindLoading = nil }
            do {
                async let detail: InvoiceDetailResponse = api.get("/api/invoices/\(invoiceId)")
                async let preview: ReminderPreviewResponse = api.get("/api/invoices/\(invoiceId)/reminders")
                let (invoice, reminder) = try await (detail.invoice, preview.reminder)
                remindTarget = RemindTarget(invoice: invoice, preview: reminder)
            } catch is CancellationError {
            } catch {
                model.say(error.userMessage)
                Haptics.error()
            }
        }
    }

    /// Pankkitilit (when there is no balance card), Avoimet myyntilaskut and ostolaskut.
    private func positions(_ rows: [Koti.PositionRow], title: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: title)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().padding(.leading, 60) }
                    NavigationLink(value: route(row)) {
                        PositionRowView(row: row).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        }
    }

    private func route(_ row: Koti.PositionRow) -> Route {
        switch row.kind {
        case .bank: row.fixesBank ? Route.bankAccounts : Route.bankHub
        case .receivables: .invoices
        // Every status, not the chip left on last time: the open total must not open the paid bills.
        case .payables: .purchaseInvoicesFiltered(status: PurchaseFilter.all.rawValue)
        }
    }
}

/// The small grey heading over a group of rows.
private struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.ink2)
            .padding(.leading, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The round tinted icon that starts a list row.
private struct RowIcon: View {
    let symbol: String
    let tint: Color
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 36, height: 36)
            .background(tint.opacity(0.12), in: Circle())
            .accessibilityHidden(true)
    }
}

struct ProgressRing: View {
    let progress: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 5)
            Circle().trim(from: 0, to: progress).stroke(Theme.success, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90))
            Text("\(Int((progress * 100).rounded())) %").font(.caption2.weight(.semibold)).monospacedDigit()
                .minimumScaleFactor(0.6).lineLimit(1)
        }
        .animation(reduceMotion ? nil : .snappy, value: progress)
    }
}

private struct MoneyCard: View {
    let title: String
    let amount: Decimal
    let tint: Color
    let trend: MoneyTrend
    let income: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text(title).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if !trend.points.isEmpty {
                    Sparkline(values: trend.points, tint: tint)
                        .frame(width: 36, height: 18)
                        .accessibilityLabel("\(income ? "Tulot" : "Menot"), viimeiset \(trend.points.count) kuukautta")
                }
            }
            MoneyText(amount: amount).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                .minimumScaleFactor(0.7).lineLimit(1)
            if let percent = trend.percent {
                Text("\(percent > 0 ? "+" : "")\(percent) % vs. \(MonthKey.name(trend.previousMonth).lowercased())")
                    .font(.caption)
                    .foregroundStyle(income ? Theme.success : Theme.ink2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// A quiet trend line with its last point marked (the web's Sparkline): direction, not values.
private struct Sparkline: View {
    let values: [Double]
    let tint: Color
    var body: some View {
        GeometryReader { proxy in
            if let geometry = MoneyTrend.geometry(values) {
                let size = proxy.size
                let points = geometry.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
                ZStack(alignment: .topLeading) {
                    Path { path in
                        guard let first = points.first else { return }
                        path.move(to: first)
                        for point in points.dropFirst() { path.addLine(to: point) }
                    }
                    .stroke(tint, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    if let last = points.last {
                        Circle().fill(tint).frame(width: 7, height: 7).position(last)
                    }
                }
            }
        }
        .accessibilityElement()
    }
}

private struct TaskRow: View {
    let item: DashboardItem
    let busy: Bool
    let approve: () -> Void
    let complete: () -> Void
    let confirm: () -> Void
    let capture: () -> Void
    let remind: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .background(tint.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(item.party).font(.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let amount = item.amount { MoneyText(amount: amount).font(.subheadline.weight(.semibold)) }
                actionButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    @ViewBuilder private var actionButton: some View {
        let action = Koti.taskAction(item)
        switch action {
        case .approve:
            pill(action, run: approve)
        case .complete:
            pill(action, run: complete)
        case .match:
            pill(action, run: confirm)
        case .remind:
            pill(action, run: remind)
        case .capture:
            Button(action: capture) {
                Text(action.label ?? "").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            .background(Theme.ink, in: Capsule())
            .foregroundStyle(Theme.onInk)
        case .open(let label):
            // Not a button: the tap goes through to the row's link, which opens the item.
            pillLabel(label).allowsHitTesting(false)
        case .none:
            EmptyView()
        }
    }

    private func pill(_ action: Koti.TaskAction, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            ZStack {
                pillLabel(action.label ?? "").opacity(busy ? 0 : 1)
                if busy { ProgressView().controlSize(.mini) }
            }
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("\(action.label ?? ""): \(item.party)")
    }

    private func pillLabel(_ title: String) -> some View {
        Text(title).font(.caption.bold()).padding(.horizontal, 12).padding(.vertical, 5)
            .background(Theme.accentSoft, in: Capsule())
            .foregroundStyle(Theme.accentDark)
    }

    private var symbol: String {
        switch item.kind {
        case .pendingReceipt: item.fromBank ? "tag" : "doc.text.magnifyingglass"
        case .missingReceipt: "camera"
        case .overdueInvoice: "exclamationmark.circle"
        case .invoiceMatch, .receiptMatch: "link"
        case .vatGap: "percent"
        case .paymentDuplicate: "doc.on.doc"
        case .draftInvoice: "doc.text"
        case .unknown: "circle"
        }
    }

    private var tint: Color {
        switch item.kind {
        case .missingReceipt: Theme.success
        case .overdueInvoice, .paymentDuplicate: Theme.danger
        default: Theme.accent
        }
    }

    private var subtitle: String {
        let day = (item.date ?? item.dueDate ?? item.paidDate ?? item.issueDate).map(APIDate.displayDay)
        switch item.kind {
        case .pendingReceipt: return Koti.pendingSubtitle(item)
        case .missingReceipt: return ["Kuitti puuttuu", day].compactMap { $0 }.joined(separator: " · ")
        case .overdueInvoice: return Koti.overdueSubtitle(item)
        case .invoiceMatch: return "Maksu laskulle \(item.number ?? 0)"
        case .receiptMatch: return "Kuittiehdotus · \(day ?? "")"
        case .vatGap: return "ALV puuttuu"
        case .paymentDuplicate: return "Mahdollinen kaksoismaksu"
        case .draftInvoice: return "Lähettämätön lasku"
        case .unknown: return ""
        }
    }
}

/// Each open step leads to where it is done: the camera, the bank connection, the seller details.
private struct SetupCard: View {
    let setup: Dashboard.Setup
    let capture: () -> Void
    var body: some View {
        Card {
            Text("Käyttöönotto").font(.headline)
            if setup.receipts {
                step("Kuvaa ensimmäinen kuitti", done: true)
            } else {
                Button(action: capture) { step("Kuvaa ensimmäinen kuitti", done: false) }
                    .buttonStyle(.plain)
            }
            if setup.bank {
                step("Yhdistä pankki", done: true)
            } else {
                NavigationLink(value: Route.bankAccounts) { step("Yhdistä pankki", done: false) }
                    .buttonStyle(.plain)
            }
            if setup.seller {
                step("Täydennä laskuttajan tiedot", done: true)
            } else {
                NavigationLink(value: Route.settings) { step("Täydennä laskuttajan tiedot", done: false) }
                    .buttonStyle(.plain)
            }
        }
    }
    private func step(_ title: String, done: Bool) -> some View {
        HStack {
            Label(title, systemImage: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? Theme.success : Theme.ink)
                .font(.subheadline)
            Spacer()
            if !done { Chevron() }
        }
        .contentShape(Rectangle())
    }
}

/// Aloitetaan (TF-06): a brand-new account's three steps, why each is worth doing and how far
/// along they are. The next step carries the one filled button; the others are plain rows that
/// open the same places as Käyttöönotto (the camera, the bank connection, the seller details).
private struct FirstRunCard: View {
    let progress: Koti.SetupProgress
    let capture: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Koti.firstRunTitle).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Text(progress.label).font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.ink2)
                        .accessibilityLabel(progress.accessibilityLabel)
                }
                Text(Koti.firstRunLead).font(.subheadline).foregroundStyle(Theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The count above says the same to VoiceOver.
            ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                .tint(Theme.success)
                .accessibilityHidden(true)
            VStack(spacing: 0) {
                ForEach(Array(progress.rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().padding(.leading, 48) }
                    stepRow(row)
                }
            }
        }
    }

    @ViewBuilder private func stepRow(_ row: Koti.SetupProgress.Row) -> some View {
        let label = progress.rowAccessibilityLabel(row)
        if row.done {
            content(row, isNext: false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
        } else if row.step == progress.next {
            VStack(alignment: .leading, spacing: 10) {
                content(row, isNext: true)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(label)
                stepLink(row.step) {
                    Text(row.step.actionTitle).font(.body.weight(.semibold)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
            }
            .padding(.bottom, 10)
        } else {
            stepLink(row.step) { content(row, isNext: false) }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
        }
    }

    private func content(_ row: Koti.SetupProgress.Row, isNext: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RowIcon(symbol: row.done ? "checkmark" : row.step.symbol,
                    tint: row.done ? Theme.success : (isNext ? Theme.accent : Theme.ink2))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.step.title).font(.body.weight(isNext ? .semibold : .regular))
                    .foregroundStyle(row.done ? Theme.ink2 : Theme.ink)
                Text(row.step.benefit).font(.caption).foregroundStyle(Theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if !row.done && !isNext { Chevron().padding(.top, 4) }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// Where a step is done: the same routes as Käyttöönotto.
    @ViewBuilder private func stepLink<Label: View>(_ step: Koti.SetupStep, @ViewBuilder label: () -> Label) -> some View {
        let shown = label()
        switch step {
        case .receipt: Button(action: capture) { shown }
        case .bank: NavigationLink(value: Route.bankAccounts) { shown }
        case .seller: NavigationLink(value: Route.settings) { shown }
        }
    }
}

/// What Koti will show once something is in the books, said once instead of 0,00 € cards.
private struct FirstRunNote: View {
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "chart.bar.doc.horizontal").foregroundStyle(Theme.ink2).accessibilityHidden(true)
            Text(Koti.firstRunNote).font(.subheadline).foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.line))
    }
}

/// The quiet "opens something" mark on a tappable card row.
private struct Chevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.ink2)
            .accessibilityHidden(true)
    }
}


/// Rahatilanne (web `BalanceTrendCard`): today's balance as the hero figure, the change since
/// last month, and the month-end line. Dragging across the line reads a month (the figure and
/// its words follow the finger); letting go returns to today. The heading part opens the bank.
private struct BalanceCard: View {
    let bank: Dashboard.BankSummary
    let trend: BalanceTrend
    let title: String
    /// The month being read on the line; nil shows today.
    @State private var selected: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Only the heading is the link: a drag on the chart must never open the bank.
            NavigationLink(value: Route.bankHub) {
                heading.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title). \(trend.accessibilitySummary(total: bank.totalBalance))")
            .accessibilityHint("Avaa pankin")
            if trend.canDraw, let domain = trend.yDomain {
                chart(domain)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Rectangle().fill(Theme.line).frame(height: 1)
                    Text(BalanceTrend.emptyText).font(.caption).foregroundStyle(Theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .onChange(of: trend) { selected = nil }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Chevron()
            }
            Text(trend.caption(selected: selected, accountCount: bank.accountCount, currentMonth: MonthKey.current()))
                .font(.caption).foregroundStyle(Theme.ink2)
            MoneyText(amount: trend.hero(selected: selected, total: bank.totalBalance))
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let line = trend.changeLine(selected: selected) {
                let direction = trend.direction(selected: selected)
                HStack(spacing: 4) {
                    Image(systemName: symbol(direction)).font(.caption.weight(.semibold)).accessibilityHidden(true)
                    Text(line).font(.caption).monospacedDigit()
                }
                .foregroundStyle(direction == .up ? Theme.success : Theme.ink2)
            }
        }
    }

    private func chart(_ domain: ClosedRange<Double>) -> some View {
        let marked = trend.points.first { $0.month == selected } ?? trend.points.last
        return Chart {
            ForEach(trend.points) { point in
                AreaMark(x: .value("Kuukausi", point.month),
                         yStart: .value("Pohja", domain.lowerBound),
                         yEnd: .value("Saldo", point.value))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(LinearGradient(colors: [Theme.accent.opacity(0.22), Theme.accent.opacity(0)],
                                                    startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Kuukausi", point.month), y: .value("Saldo", point.value))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Theme.accent)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            if let selected {
                RuleMark(x: .value("Kuukausi", selected))
                    .foregroundStyle(Theme.ink2)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
            }
            if let marked {
                // The point being read (or today's): a dot with a surface ring.
                PointMark(x: .value("Kuukausi", marked.month), y: .value("Saldo", marked.value))
                    .symbol {
                        Circle().fill(Theme.accent).frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Theme.surface, lineWidth: 2))
                    }
            }
        }
        .chartYScale(domain: domain)
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks { value in
                AxisValueLabel {
                    if let month = value.as(String.self) {
                        Text(MonthKey.short(month))
                            .fontWeight(month == selected ? .semibold : .regular)
                            .foregroundStyle(month == selected ? Theme.ink : Theme.ink2)
                    }
                }
            }
        }
        .chartXSelection(value: $selected)
        .sensoryFeedback(.selection, trigger: selected)
        .frame(height: 140)
        // The heading reads the whole line out; the drag is a visual extra.
        .accessibilityHidden(true)
    }

    private func symbol(_ direction: BalanceTrend.Direction?) -> String {
        switch direction {
        case .up: "arrow.up.right"
        case .down: "arrow.down.right"
        case .flat, nil: "minus"
        }
    }
}

/// One row under Rahatilanne: what it is, how much, and what is late (in the danger colour).
private struct PositionRowView: View {
    let row: Koti.PositionRow

    var body: some View {
        HStack(spacing: 12) {
            RowIcon(symbol: symbol, tint: row.tone == .danger ? Theme.danger : row.tone == .warning ? Theme.warning : Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.body).foregroundStyle(Theme.ink)
                Text(row.secondary)
                    .font(.caption)
                    .foregroundStyle(row.tone == .danger ? Theme.danger : row.tone == .warning ? Theme.warning : Theme.ink2)
            }
            Spacer(minLength: 8)
            if let amount = row.amount {
                MoneyText(amount: amount).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            Chevron()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    private var symbol: String {
        switch row.kind {
        case .bank: "building.columns"
        case .receivables: "arrow.down.circle"
        case .payables: "doc.text"
        }
    }
}

/// Tulot ja menot over the six months up to this one. Tapping a bar opens that month on Koti
/// (the month's own cards lead on to the rows); VoiceOver swipes up and down for the same.
private struct CashflowCard: View {
    let months: [Dashboard.CashflowMonth]
    let selected: String
    let select: (String) -> Void

    var body: some View {
        Card {
            HStack(spacing: 12) {
                Text("Tulot ja menot, 6 kk").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                legend("Tulot", Theme.success)
                legend("Menot", Theme.ink2)
            }
            Chart {
                ForEach(months) { m in
                    BarMark(x: .value("Kuukausi", m.month), y: .value("Tulot", NSDecimalNumber(decimal: m.income).doubleValue))
                        .foregroundStyle(Theme.success.opacity(m.month == selected ? 1 : 0.45))
                        .position(by: .value("Laji", "Tulot"))
                        .cornerRadius(2)
                    BarMark(x: .value("Kuukausi", m.month), y: .value("Menot", NSDecimalNumber(decimal: m.expenses).doubleValue))
                        .foregroundStyle(Theme.ink2.opacity(m.month == selected ? 0.9 : 0.35))
                        .position(by: .value("Laji", "Menot"))
                        .cornerRadius(2)
                }
            }
            .chartXAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        if let month = value.as(String.self) {
                            Text(MonthKey.short(month))
                                .fontWeight(month == selected ? .semibold : .regular)
                                .foregroundStyle(month == selected ? Theme.ink : Theme.ink2)
                        }
                    }
                }
            }
            .chartYAxis { AxisMarks(values: .automatic(desiredCount: 3)) }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onTapGesture { location in
                            guard let plot = proxy.plotFrame else { return }
                            let x = location.x - geometry[plot].origin.x
                            if let month = proxy.value(atX: x, as: String.self) { select(month) }
                        }
                }
            }
            .frame(height: 150)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Koti.cashflowSummary(months, selected: selected))
            .accessibilityHint("Pyyhkäise ylös tai alas vaihtaaksesi kuukautta")
            .accessibilityAdjustableAction { direction in
                let step = direction == .increment ? 1 : -1
                if let month = Koti.adjacentMonth(months.map(\.month), from: selected, step: step) { select(month) }
            }
        }
    }

    private func legend(_ title: String, _ tint: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text(title).font(.caption).foregroundStyle(Theme.ink2)
        }
        .accessibilityHidden(true)
    }
}

/// What the app did for the owner this week; opens the list holding the biggest part.
private struct HandledCard: View {
    let handled: Dashboard.Handled

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                RowIcon(symbol: "sparkles", tint: Theme.success)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hoidettu automaattisesti").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink2)
                    Text(Koti.handledTitle(count: handled.count)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(Koti.handledDetail(labels: handled.parts.map(\.label))).font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var route: Route {
        switch Koti.handledTarget(firstKind: handled.parts.first?.kind) {
        case .receipts: .receipts
        case .bankFeed: .bankFeed
        case .recurringInvoices: .recurringInvoices
        }
    }
}

/// One card for every part of the dashboard that did not load, with one retry (web VS-31).
private struct PartialFailureNotice: View {
    let messages: [String]
    let retry: () async -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Theme.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Osa tiedoista jäi lataamatta").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                ForEach(messages, id: \.self) { message in
                    Text(message).font(.caption).foregroundStyle(Theme.ink2)
                }
                Button("Yritä uudelleen") { Task { await retry() } }
                    .font(.caption.bold())
                    .foregroundStyle(Theme.accentDark)
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// The onboarding was skipped with "Ohita nyt" (web OnboardingResumeCard): one tap reopens the
/// questions where they were left.
private struct OnboardingResumeCard: View {
    let resume: () -> Void

    var body: some View {
        Button(action: resume) {
            HStack(spacing: 12) {
                RowIcon(symbol: "sparkles", tint: Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(OnboardingResume.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(OnboardingResume.detail).font(.caption).foregroundStyle(Theme.ink2)
                }
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// ALV-raja lähestyy / ylittynyt (web :1118-1137), outside the VAT register only. Opens the
/// company settings, where ALV-rekisterissä is switched on once registered in OmaVero.
private struct VatThresholdCard: View {
    let notice: Koti.VatThresholdNotice

    var body: some View {
        let tint = notice.exceeded ? Theme.danger : Theme.warning
        NavigationLink(value: Route.settings) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(tint).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(notice.title).font(.subheadline.weight(.semibold)).foregroundStyle(notice.exceeded ? Theme.danger : Theme.ink)
                    Text(notice.body).font(.caption).foregroundStyle(Theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Chevron()
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(tint.opacity(0.3)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}
