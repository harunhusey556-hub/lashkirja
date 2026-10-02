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
            if model == nil { model = KotiModel(api: app.api) }
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
    @Bindable var model: KotiModel
    /// The bank row a receipt is being photographed for.
    @State private var captureFor: CaptureTarget?
    /// Koti is a dashboard: five tasks, the rest on request, so the cards below stay in reach.
    @State private var taskLimit = ShowMore(step: 5)
    @Environment(\.dynamicTypeSize) private var typeSize

    struct CaptureTarget: Identifiable { let id = UUID(); let transactionId: String? }

    var body: some View {
        ScrollView {
            LoadState(state: model.state, retry: model.load) { dashboard in
                let sections = KotiLayout.sections(.init(dashboard: dashboard, atCurrentMonth: model.atCurrentMonth,
                                                         hasTasks: !model.visibleItems.isEmpty, failedJobs: model.failedJobs))
                VStack(alignment: .leading, spacing: 16) {
                    header(dashboard)
                    ForEach(sections, id: \.self) { section in
                        sectionView(section, dashboard)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
        }
        .background(Theme.canvas)
        .refreshable { await model.load() }
        // Another month has its own tasks: back to the first five.
        .onChange(of: model.month) { _, _ in taskLimit.reset() }
        .fullScreenCover(item: $captureFor, onDismiss: { Task { await model.load() } }) { target in
            CaptureFlow(transactionId: target.transactionId)
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
        case .status:
            statusCard(d)
        case .partialFailure:
            PartialFailureNotice(messages: Koti.failedSections(d.sectionErrors)) { await model.load() }
        case .setup:
            if let setup = d.setup {
                SetupCard(setup: setup, capture: { captureFor = CaptureTarget(transactionId: nil) })
            }
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

    private func header(_ d: Dashboard) -> some View {
        Text(d.firstName.map { "Hyvää päivää, \($0)" } ?? "Hyvää päivää")
            .font(.subheadline)
            .foregroundStyle(Theme.ink2)
    }

    /// The month's checklist, and the VAT estimate as one line under it.
    private func statusCard(_ d: Dashboard) -> some View {
        let blocking = max(0, (d.blockingTotal ?? 0) - (d.items.count - model.visibleItems.count))
        let done = d.events?.done ?? d.matching.matched
        let total = d.events?.total ?? d.matching.matchable
        return Card {
            NavigationLink(value: Route.monthClose(d.month)) {
                HStack(alignment: .center, spacing: 14) {
                    ProgressRing(progress: total > 0 ? Double(done) / Double(total) : 1)
                        .frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Koti.headline(blocking: blocking)).font(.headline).foregroundStyle(Theme.ink)
                        if total > 0 {
                            Text("\(done) / \(total) tapahtumaa on kunnossa").font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    Spacer(minLength: 8)
                    Chevron()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let vat = d.estimatedVat, d.vat?.registered == true {
                Divider()
                NavigationLink(value: Route.alv(d.month)) {
                    HStack(spacing: 8) {
                        Text(Koti.vatLine(isRefund: d.isRefund)).font(.subheadline).foregroundStyle(Theme.ink2)
                        Spacer(minLength: 8)
                        MoneyText(amount: vat).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        Chevron()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
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
                // As on the web: the card opens the month's sales or costs, from the books' basis.
                let route: Route = d.source == "tiliote"
                    ? .bankFeedFiltered(month: d.month, onlyOpen: false, focus: nil)
                    : .receiptsFiltered(month: d.month, tab: income ? "tulo" : "meno")
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
        let row = TaskRow(item: item, approve: { model.approve(item) }, confirm: { model.confirmMatch(item) }, capture: { captureFor = CaptureTarget(transactionId: item.transactionId) })
        if let route = Route.forItem(item, month: model.month) {
            NavigationLink(value: route) {
                row.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            row
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
        case .payables: .purchaseInvoices
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
    var body: some View {
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 5)
            Circle().trim(from: 0, to: progress).stroke(Theme.success, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90))
            Text("\(Int((progress * 100).rounded())) %").font(.caption2.weight(.semibold)).monospacedDigit()
                .minimumScaleFactor(0.6).lineLimit(1)
        }
        .animation(.snappy, value: progress)
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
    let approve: () -> Void
    let confirm: () -> Void
    let capture: () -> Void

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
        switch item.kind {
        case .pendingReceipt where item.gaps.isEmpty:
            pill("Hyväksy", action: approve)
        case .invoiceMatch:
            pill("Kohdista", action: confirm)
        case .missingReceipt:
            Button(action: capture) {
                Text("Kuvaa kuitti").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            .background(Theme.ink, in: Capsule())
            .foregroundStyle(Theme.onInk)
        default:
            EmptyView()
        }
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.bold()).padding(.horizontal, 12).padding(.vertical, 5)
        }
        .buttonStyle(.plain)
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
        case .pendingReceipt:
            let rate = item.vatRate.map { "ALV \(NSDecimalNumber(decimal: $0).stringValue.replacingOccurrences(of: ".", with: ",")) %" }
            return [item.category, rate].compactMap { $0 }.joined(separator: " · ")
        case .missingReceipt: return ["Kuitti puuttuu", day].compactMap { $0 }.joined(separator: " · ")
        case .overdueInvoice: return "Lasku \(item.number ?? 0) · \(item.daysLate ?? 0) pv myöhässä"
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
