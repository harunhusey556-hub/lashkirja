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
    /// Pankki: balances, the month's money in and out, and the bank rows in one place.
    case bankHub
    /// Myynti opened on a period ("YYYY" / "YYYY-MM", "" = any), a status chip ("" = Kaikki) or one customer.
    case invoicesFiltered(month: String, status: String, customerId: String)
    /// Ostolaskut opened on one status chip, without changing the chip the owner last chose.
    case purchaseInvoicesFiltered(status: String)
    /// Toistuvat ostolaskut: rent and other routine bills made into purchase invoices each period.
    case recurringPurchases
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
        case .recurringInvoices: return .recurringInvoices
        case .periods: return .periods
        case .workQueue: return .workQueue
        case .reports: return .reports
        case .settings: return .settings
        case .privacy: return .privacy
        case .help: return .help
        case .emailImport: return .emailImport
        case .bankHub: return .bankHub
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
                .onAppear { EventLog.shared.log(.screen(String(describing: route))) }
        }
    }
}

/// The screen a route opens; also used by `navigationDestination(item:)` where a sheet hands a
/// route back to the screen under it (BankRowSheet's "Avaa kuitti").
struct RouteScreen: View {
    @Environment(AppModel.self) private var app
    let route: Route

    var body: some View {
        switch route {
        case .placeholder(let title): PlaceholderScreen(title: title)
        case .invoice(let id): InvoiceDetailView(invoiceId: id)
        case .customers: CustomersView()
        case .customer(let id): CustomerDetailView(customerId: id)
        case .receipts: ReceiptsView()
        case .receipt(let id): ReceiptDetailView(receiptId: id)
        case .bankFeed: BankFeedView()
        case .bankAccounts: BankAccountsView()
        case .alv(let period): AlvView(period: period)
        case .settings: SettingsView()
        case .purchaseInvoices: PurchaseInvoicesView()
        case .purchaseInvoice(let id): PurchaseInvoiceDetailView(purchaseInvoiceId: id)
        case .statement(let id): StatementDetailView(statementId: id)
        case .recurringInvoices: RecurringInvoicesView()
        case .periods: PeriodsView()
        case .ledger: LedgerView()
        case .workQueue: WorkQueueView()
        case .privacy: PrivacyView()
        case .help: HelpView()
        case .passkeys: PasskeysView()
        case .changeEmail: ChangeEmailView()
        case .emailImport:
            // A connected or removed mailbox changes the profile other screens read from AppModel.
            EmailImportView { app.profileChanged($0) }
        case .receiptsFiltered(let month, let tab): ReceiptsView(month: month, tab: ReceiptTab(rawValue: tab) ?? .all, drilled: true)
        case .bankFeedFiltered(let month, let onlyOpen, let focus): BankFeedView(month: month, onlyOpen: onlyOpen, focusTransactionId: focus)
        case .newInvoice: MyyntiView(openNewInvoice: true)
        case .reports: RaportitView()
        case .invoices: MyyntiView()
        case .statements: StatementsView()
        case .monthClose(let month): PeriodsView(month: month)
        case .receiptsCategory(let period, let tab, let category):
            ReceiptsView(month: period, tab: ReceiptTab(rawValue: tab) ?? .all, category: category, drilled: true)
        case .receiptsMissingVat(let period):
            ReceiptsView(month: period, missingVat: true, drilled: true)
        case .emailInbox: EmailInboxView()
        case .bankHub: BankHubView()
        case .invoicesFiltered(let month, let status, let customerId):
            MyyntiView(scope: InvoiceScope(month: month, customerId: customerId), status: SalesFilter(rawValue: status) ?? .all)
        case .purchaseInvoicesFiltered(let status): PurchaseInvoicesView(status: PurchaseFilter(rawValue: status))
        case .recurringPurchases: RecurringPurchasesView()
        }
    }
}
