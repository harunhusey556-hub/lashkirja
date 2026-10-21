import SwiftUI
import LashKirjaCore

enum AppTab: Hashable, CaseIterable {
    case koti, myynti, kirjanpito, raportit, add

    var title: String {
        switch self {
        case .koti: "Koti"
        case .myynti: "Myynti"
        case .kirjanpito: "Kirjanpito"
        case .raportit: "Raportit"
        case .add: "Lisää"
        }
    }

    var symbol: String {
        switch self {
        case .koti: "house"
        case .myynti: "doc.text"
        case .kirjanpito: "book"
        case .raportit: "chart.bar"
        case .add: "plus"
        }
    }
}

/// Every pushed screen.
enum Route: Hashable {
    case placeholder(String)
    case invoice(String)
    case customers
    case customer(String)
    case receipts
    case receipt(String)
    case bankFeed
    case bankAccounts
    case alv(String)
    case settings
    case purchaseInvoices
    case purchaseInvoice(String)
    case statement(String)
    case recurringInvoices
    case periods
    /// Kirjanpito: the double-entry books (tuloslaskelma, tase, saldoluettelo, päiväkirja).
    case ledger
    case workQueue
    case privacy
    case help
    case passkeys
    /// Asetukset: Laitteet and Sähköpostimallit, built at the push with what Asetukset warmed.
    case devices
    case emailTemplates
    case changeEmail
    case emailImport
    /// Kuitit opened on a month and tab (`/kuitit?month=…&type=…`).
    case receiptsFiltered(month: String, tab: String)
    /// Pankki on a month, only rows needing action, or with one row's sheet open.
    case bankFeedFiltered(month: String?, onlyOpen: Bool, focus: String?)
    case newInvoice
    case reports
    case invoices
    /// Tiliotteet: import a file and browse the statement files, newest first.
    case statements
    /// Kuukauden sulku opened on one month (from Koti's status card).
    case monthClose(String)
    /// Kuitit of one report category: a year or month, Tulot/Menot and the category ("" = all).
    case receiptsCategory(period: String, tab: String, category: String)
    /// Kuitit of a year or month without a VAT breakdown (Raportit's "Ilman ALV-erittelyä").
    case receiptsMissingVat(period: String)
    /// Sähköposti: what mail sync brought in, the bills and the archived non-bills.
    case emailInbox
    /// Pankki by its old link name (`/pankki`, the hub that stood before the rows): opens the bank
    /// rows, as `bankFeed` does, so older links and replies keep working.
    case bankHub
    /// Myynti opened on a period ("YYYY" / "YYYY-MM", "" = any), a status chip ("" = Kaikki) or one customer.
    case invoicesFiltered(month: String, status: String, customerId: String)
    /// Ostolaskut opened on one status chip, without changing the chip the owner last chose.
    case purchaseInvoicesFiltered(status: String)
    /// Toistuvat ostolaskut: rent and other routine bills made into purchase invoices each period.
    case recurringPurchases
    /// Kohdista ostolaskujen maksut: open ostolaskut with the bank payment proposed for each.
    case purchaseMatch
}

extension Route {
    /// An in-app link from an assistant reply or a server item ("/kuitit?month=…", "/laskut/lasku?id=…"),
    /// read by `AppLink` so the filters the web puts in the link are kept.
    static func fromHref(_ href: String) -> Route? {
        guard let link = AppLink.parse(href) else { return nil }
        switch link {
        case .receipts(let month, let type, let category):
            if !category.isEmpty { return .receiptsCategory(period: month, tab: type, category: category) }
            return month.isEmpty && type.isEmpty ? .receipts : .receiptsFiltered(month: month, tab: type)
        case .receipt(let id): return .receipt(id)
        case .bankFeed(let month, let onlyOpen, let row):
            return month == nil && !onlyOpen && row == nil ? .bankFeed : .bankFeedFiltered(month: month, onlyOpen: onlyOpen, focus: row)
        case .statement(let id): return .statement(id)
        case .bankAccounts: return .bankAccounts
        case .alv(let period): return .alv(period ?? MonthKey.current())
        case .invoices: return .invoices
        case .invoicesFiltered(let month, let status, let customerId):
            return .invoicesFiltered(month: month, status: status, customerId: customerId)
        case .invoice(let id): return .invoice(id)
        case .newInvoice: return .newInvoice
        case .customers: return .customers
        case .customer(let id): return .customer(id)
        case .purchaseInvoices: return .purchaseInvoices
        case .purchaseInvoice(let id): return .purchaseInvoice(id)
        case .purchaseMatch: return .purchaseMatch
        case .recurringInvoices: return .recurringInvoices
        case .periods: return .periods
        case .workQueue: return .workQueue
        case .reports: return .reports
        case .settings: return .settings
        case .privacy: return .privacy
        case .help: return .help
        case .emailImport: return .emailImport
        case .bankHub: return .bankFeed
        case .statements: return .statements
        case .emailInbox: return .emailInbox
        }
    }
}

extension Route {
    /// Where a "Tarvitaan sinulta" / month-close row leads, one rule for Koti and Kuukauden sulku:
    /// a receipt row to its receipt, a bank row to that row's sheet (the web sends it to the
    /// action list), an invoice row to the invoice.
    static func forItem(_ item: DashboardItem, month: String? = nil) -> Route? {
        switch item.kind {
        case .pendingReceipt, .vatGap:
            return item.receiptId.map(Route.receipt)
        case .missingReceipt, .receiptMatch:
            return .bankFeedFiltered(month: month, onlyOpen: true, focus: item.transactionId)
        case .invoiceMatch, .paymentDuplicate, .draftInvoice, .overdueInvoice:
            return item.invoiceId.map(Route.invoice)
        case .unknown:
            return nil
        }
    }

    /// Koti's "Näytä kaikki (N)" under a kind (web `KIND_LIST`): the list holding all of that kind.
    /// Bank rows open Pankki on the month's rows that need action (Q1: Pankki is the rows).
    static func forShowAll(_ kind: DashboardItem.Kind, month: String) -> Route? {
        switch kind {
        case .pendingReceipt: return .receipts
        // The month's receipts without a VAT breakdown, the list the server counted.
        case .vatGap: return .receiptsMissingVat(period: month)
        case .missingReceipt, .receiptMatch: return .bankFeedFiltered(month: month, onlyOpen: true, focus: nil)
        case .invoiceMatch: return .invoices
        case .paymentDuplicate: return .workQueue
        case .draftInvoice: return .invoicesFiltered(month: month, status: SalesFilter.draft.rawValue, customerId: "")
        case .overdueInvoice: return .invoicesFiltered(month: "", status: SalesFilter.overdue.rawValue, customerId: "")
        case .unknown: return nil
        }
    }
}

extension Route {
    /// The list behind a report figure (Raportit, Koti's cards, the ALV fields).
    static func forDrill(_ drill: ReportDrill) -> Route {
        switch drill {
        case .receipts(let period, let tab, let category):
            .receiptsCategory(period: period, tab: tab, category: category)
        case .receiptsMissingVat(let period):
            .receiptsMissingVat(period: period)
        case .invoices(let period, let status):
            .invoicesFiltered(month: period, status: status.rawValue, customerId: "")
        case .bankFeed(let month):
            .bankFeedFiltered(month: month, onlyOpen: false, focus: nil)
        case .purchaseInvoices:
            // Every status: the VAT figure counts paid and open purchase invoices alike.
            .purchaseInvoicesFiltered(status: PurchaseFilter.all.rawValue)
        }
    }
}

extension View {
    func appDestinations() -> some View {
        // Pushed screens use the small inline title: the large one costs a phone screen ~50 pt.
        navigationDestination(for: Route.self) { route in
            RouteScreen(route: route).navigationBarTitleDisplayMode(.inline)
                .motionProbe(String(describing: route))
                .onAppear { EventLog.shared.log(.screen(String(describing: route))) }
        }
    }
}

/// Opens a route from code (a tile, a created invoice) on the path of the stack the screen is in,
/// as a NavigationLink would. A screen pushed with `navigationDestination(item:)` sits outside
/// that path, and whatever it then pushed by value landed under it: the customer opened under
/// Asiakkaat, and Back skipped the list (M024).
struct OpenRouteAction: Equatable {
    /// The stack it pushes onto. Two actions for one stack push the same way, so a container's body
    /// running again is no change for the screens that read this one.
    let stack: String
    let push: @MainActor (Route) -> Void

    @MainActor func callAsFunction(_ route: Route) { push(route) }

    static func == (lhs: OpenRouteAction, rhs: OpenRouteAction) -> Bool { lhs.stack == rhs.stack }
}

extension EnvironmentValues {
    /// Set on every stack that has `appDestinations()` and a screen that opens routes from code
    /// (the tabs, the assistant, Asetukset, the send sheet). Elsewhere (TabPrebuild's offscreen
    /// copies) nothing is pushed.
    @Entry var openRoute: OpenRouteAction = OpenRouteAction(stack: "") { _ in }
}

/// The screen a route opens; also used by the `navigationDestination(item:)` pushes that are still
/// outside the path (PeriodsView's "Täydennä"). A sheet's hand-off (BankRowSheet's "Avaa kuitti")
/// goes through `openRoute`.
struct RouteScreen: View {
    @Environment(AppModel.self) private var app
    let route: Route

    var body: some View {
        switch route {
        case .placeholder(let title): PlaceholderScreen(title: title)
        case .invoice(let id): InvoiceDetailView(invoiceId: id, preview: app.invoicePreview(id))
        case .customers: CustomersView()
        case .customer(let id): CustomerDetailView(customerId: id, detail: app.lastPainted(CustomerDetailView.path(id)), row: app.customerPreview(id))
        case .receipts: ReceiptsView()
        case .receipt(let id): ReceiptDetailView(receiptId: id)
        case .bankFeed, .bankHub: BankFeedView()
        case .bankAccounts: BankAccountsView(overview: app.lastPainted("/api/bank-accounts"), connections: app.lastPainted("/api/bank/connections"))
        case .alv(let period): AlvView(period: period)
        case .settings: SettingsView()
        case .purchaseInvoices: PurchaseInvoicesView()
        case .purchaseInvoice(let id): PurchaseInvoiceDetailView(purchaseInvoiceId: id)
        case .statement(let id): StatementDetailView(statementId: id)
        case .recurringInvoices: RecurringInvoicesView(preview: app.lastPainted("/api/recurring-invoices"))
        case .periods: PeriodsView(preview: app.periodsPreview(month: PeriodClose.startMonth(nil, current: MonthKey.current())))
        case .ledger: LedgerView()
        case .workQueue: WorkQueueView()
        case .privacy: PrivacyView()
        case .help: HelpView()
        case .passkeys: PasskeysView(preview: app.lastPainted(PasskeyScreen.listPath))
        case .devices: DevicesView(preview: app.lastPainted(DevicesView.path))
        case .emailTemplates: EmailTemplatesView(preview: app.lastPainted(EmailTemplatesView.path, query: EmailTemplatesView.query))
        case .changeEmail: ChangeEmailView()
        case .emailImport:
            // A connected or removed mailbox changes the profile other screens read from AppModel.
            EmailImportView { app.profileChanged($0) }
        case .receiptsFiltered(let month, let tab):
            let chip = ReceiptTab(rawValue: tab) ?? .all
            ReceiptsView(month: month, tab: chip, drilled: true, preview: app.receiptsPreview(.drilled(month: month, tab: chip)))
        case .bankFeedFiltered(let month, let onlyOpen, let focus): BankFeedView(month: month, onlyOpen: onlyOpen, focusTransactionId: focus)
        case .newInvoice: MyyntiView(openNewInvoice: true, preview: app.salesPreview())
        case .reports: RaportitView()
        case .invoices: MyyntiView(preview: app.salesPreview())
        case .statements: StatementsView()
        case .monthClose(let month):
            PeriodsView(month: month, preview: app.periodsPreview(month: PeriodClose.startMonth(month, current: MonthKey.current())))
        case .receiptsCategory(let period, let tab, let category):
            let chip = ReceiptTab(rawValue: tab) ?? .all
            ReceiptsView(month: period, tab: chip, category: category, drilled: true,
                         preview: app.receiptsPreview(.drilled(month: period, tab: chip, category: category)))
        case .receiptsMissingVat(let period):
            ReceiptsView(month: period, missingVat: true, drilled: true, preview: app.receiptsPreview(.drilled(month: period, missingVat: true)))
        case .emailInbox: EmailInboxView()
        case .invoicesFiltered(let month, let status, let customerId):
            let scope = InvoiceScope(month: month, customerId: customerId), filter = SalesFilter(rawValue: status) ?? .all
            MyyntiView(scope: scope, status: filter, preview: app.salesPreview(scope: scope, filter: filter))
        case .purchaseInvoicesFiltered(let status): PurchaseInvoicesView(status: PurchaseFilter(rawValue: status))
        case .recurringPurchases: RecurringPurchasesView()
        case .purchaseMatch: PurchaseMatchView()
        }
    }
}
