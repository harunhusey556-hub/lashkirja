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
}

extension Route {
    /// An in-app link from an assistant reply ("/kuitit", "/laskut/lasku?id=…").
    static func fromHref(_ href: String) -> Route? {
        let parts = href.split(separator: "?", maxSplits: 1)
        let path = String(parts.first ?? "")
        let query = parts.count > 1 ? String(parts[1]) : ""
        let id = query.split(separator: "&").first { $0.hasPrefix("id=") }.map { String($0.dropFirst(3)) }
        switch path {
        case "/kuitit": return .receipts
        case "/kuitit/kuitti": return id.map(Route.receipt)
        case "/pankki/tapahtumat": return .bankFeed
        case "/kirjanpito/pankkitilit": return .bankAccounts
        case "/kirjanpito/alv": return .alv(query.split(separator: "&").first { $0.hasPrefix("period=") }.map { String($0.dropFirst(7)) } ?? MonthKey.current())
        case "/laskut/lasku": return id.map(Route.invoice)
        case "/asiakkaat": return .customers
        case "/asetukset", "/asetukset/laskutus": return .settings
        default: return nil
        }
    }
}

extension View {
    func appDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
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
            }
        }
    }
}
