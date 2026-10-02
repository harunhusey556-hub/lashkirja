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

private struct KotiContent: View {
    @Bindable var model: KotiModel
    /// The bank row a receipt is being photographed for.
    @State private var captureFor: CaptureTarget?

    struct CaptureTarget: Identifiable { let id = UUID(); let transactionId: String? }

    var body: some View {
        ScrollView {
            LoadState(state: model.state, retry: model.load) { dashboard in
                VStack(alignment: .leading, spacing: 20) {
                    header(dashboard)
                    statusCard(dashboard)
                    moneyCards(dashboard)
                    if !model.visibleItems.isEmpty { tasks }
                    if model.failedJobs > 0 { failedJobsRow }
                    if model.atCurrentMonth, let setup = dashboard.setup, setup.empty || !setup.receipts || !setup.bank {
                        SetupCard(setup: setup, capture: { captureFor = CaptureTarget(transactionId: nil) })
                    }
                    if let bank = dashboard.bank, bank.accountCount > 0 {
                        NavigationLink(value: Route.bankHub) {
                            BankCard(bank: bank, trend: dashboard.bankTrend).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if dashboard.cashflow.contains(where: { $0.income != 0 || $0.expenses != 0 }) { CashflowCard(months: dashboard.cashflow, selected: dashboard.month) }
                    if let handled = dashboard.handled { HandledCard(handled: handled) }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
        }
        .background(Theme.canvas)
        .refreshable { await model.load() }
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

    private func header(_ d: Dashboard) -> some View {
        Text(d.firstName.map { "Hyvää päivää, \($0)" } ?? "Hyvää päivää")
            .font(.subheadline)
            .foregroundStyle(Theme.ink2)
    }

    private func statusCard(_ d: Dashboard) -> some View {
        let blocking = max(0, (d.blockingTotal ?? 0) - (d.items.count - model.visibleItems.count))
        let done = d.events?.done ?? d.matching.matched
        let total = d.events?.total ?? d.matching.matchable
        return Card {
            // The month's checklist: what is still open and the close itself.
            NavigationLink(value: Route.monthClose(d.month)) {
                HStack(alignment: .center, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(Koti.headline(blocking: blocking)).font(.headline).foregroundStyle(Theme.ink)
                        if total > 0 {
                            Text("\(done) / \(total) tapahtumaa on kunnossa").font(.subheadline).foregroundStyle(Theme.ink2)
                        }
                    }
                    Spacer()
                    ProgressRing(progress: total > 0 ? Double(done) / Double(total) : 1)
                        .frame(width: 52, height: 52)
                    Chevron()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let vat = d.estimatedVat, d.vat?.registered == true {
                Divider()
                NavigationLink(value: Route.alv(d.month)) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text("ALV-arvio").font(.subheadline).foregroundStyle(Theme.ink)
                            Text(d.isRefund == true ? "palautusta" : "maksettavaa").font(.caption).foregroundStyle(Theme.ink2)
                        }
                        Spacer()
                        MoneyText(amount: vat).font(.headline).foregroundStyle(Theme.ink)
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
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.danger)
                    .frame(width: 36, height: 36)
                    .background(Theme.danger.opacity(0.12), in: Circle())
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

    private func moneyCards(_ d: Dashboard) -> some View {
        HStack(spacing: 12) {
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
            Text("Tarvitaan sinulta").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2).padding(.leading, 4)
            VStack(spacing: 0) {
                ForEach(Array(model.visibleItems.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Divider().padding(.leading, 60) }
                    taskRow(item)
                        .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
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
}

struct ProgressRing: View {
    let progress: Double
    var body: some View {
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 5)
            Circle().trim(from: 0, to: progress).stroke(Theme.success, style: StrokeStyle(lineWidth: 5, lineCap: .round)).rotationEffect(.degrees(-90))
            Text("\(Int((progress * 100).rounded())) %").font(.caption2.weight(.semibold)).monospacedDigit()
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

private struct BankCard: View {
    let bank: Dashboard.BankSummary
    let trend: Dashboard.BankTrend?
    var body: some View {
        Card {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Rahatilanne").font(.subheadline).foregroundStyle(Theme.ink2)
                    MoneyText(amount: bank.totalBalance).font(.title2.weight(.semibold))
                }
                Spacer()
                Text("\(bank.accountCount) tiliä").font(.caption).foregroundStyle(Theme.ink2)
                Chevron()
            }
            if let points = trend?.points, points.count > 1 {
                Chart(points) { point in
                    LineMark(x: .value("Kuukausi", MonthKey.short(point.month)), y: .value("Saldo", NSDecimalNumber(decimal: point.balance).doubleValue))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Theme.accent)
                    AreaMark(x: .value("Kuukausi", MonthKey.short(point.month)), y: .value("Saldo", NSDecimalNumber(decimal: point.balance).doubleValue))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Theme.accent.opacity(0.12))
                }
                .chartYAxis(.hidden)
                .frame(height: 90)
            }
        }
    }
}

private struct CashflowCard: View {
    let months: [Dashboard.CashflowMonth]
    let selected: String
    var body: some View {
        Card {
            Text("Tulot ja menot, 6 kk").font(.subheadline).foregroundStyle(Theme.ink2)
            Chart {
                ForEach(months) { m in
                    BarMark(x: .value("Kuukausi", MonthKey.short(m.month)), y: .value("Tulot", NSDecimalNumber(decimal: m.income).doubleValue))
                        .foregroundStyle(Theme.success.opacity(m.month == selected ? 1 : 0.55))
                        .position(by: .value("Laji", "Tulot"))
                    BarMark(x: .value("Kuukausi", MonthKey.short(m.month)), y: .value("Menot", NSDecimalNumber(decimal: m.expenses).doubleValue))
                        .foregroundStyle(Theme.ink2.opacity(m.month == selected ? 0.9 : 0.4))
                        .position(by: .value("Laji", "Menot"))
                }
            }
            .frame(height: 140)
        }
    }
}

private struct HandledCard: View {
    let handled: Dashboard.Handled
    var body: some View {
        Card {
            Label("Hoidettu automaattisesti", systemImage: "sparkles").font(.subheadline.weight(.semibold))
            ForEach(handled.parts, id: \.kind) { part in
                Text("\(part.count) \(part.label)").font(.caption).foregroundStyle(Theme.ink2)
            }
        }
    }
}
