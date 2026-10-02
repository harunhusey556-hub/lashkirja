import Foundation

/// A web path from an assistant reply or a server item, read the way the web app routes it,
/// filters included (`/kuitit?month=…&type=tulo`, `/pankki/tapahtumat?nayta=toimet`).
public enum AppLink: Equatable, Sendable {
    case receipts(month: String, type: String)
    case receipt(String)
    case bankFeed(month: String?, onlyOpen: Bool, transactionId: String?)
    case statement(String)
    case bankAccounts
    case alv(String?)
    case invoices
    case invoice(String)
    case newInvoice
    case customers
    case customer(String)
    case purchaseInvoices
    case purchaseInvoice(String)
    case recurringInvoices
    case periods
    case workQueue
    case reports
    case settings
    case privacy
    case help
    case emailImport
    /// Pankki: balances and recent rows (`/pankki`).
    case bankHub
    /// Tiliotteet: statement files (`/tiliotteet`, `/pankki/tiliotteet`).
    case statements
    /// Sähköposti: what mail sync brought in.
    case emailInbox

    public static func parse(_ href: String) -> AppLink? {
        guard href.hasPrefix("/") else { return nil }
        let withoutFragment = href.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? href
        let parts = withoutFragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(parts.first ?? "")
        var params: [String: String] = [:]
        if parts.count > 1 {
            for pair in parts[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard let key = kv.first else { continue }
                let raw = kv.count > 1 ? String(kv[1]) : ""
                params[String(key)] = (raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding) ?? raw
            }
        }
        let id = params["id"].flatMap { $0.isEmpty ? nil : $0 }
        let month = params["month"].flatMap { $0.isEmpty ? nil : $0 }
        switch path {
        case "/kuitit": return .receipts(month: month ?? "", type: params["type"] ?? "")
        case "/kuitit/kuitti": return id.map(AppLink.receipt)
        case "/pankki/tapahtumat":
            return .bankFeed(month: month, onlyOpen: params["nayta"] == "toimet", transactionId: params["rivi"])
        case "/pankki/taydennys": return .bankFeed(month: nil, onlyOpen: true, transactionId: nil)
        case "/pankki/tapahtumat/tiliote": return id.map(AppLink.statement)
        case "/kirjanpito/pankkitilit": return .bankAccounts
        case "/kirjanpito/alv": return .alv(params["period"])
        // The pre-restructure ALV path, still cited by older replies.
        case "/alv-raportti": return .alv(params["period"] ?? month)
        case "/laskut": return .invoices
        case "/laskut/lasku": return id.map(AppLink.invoice)
        case "/laskut/uusi": return .newInvoice
        case "/asiakkaat": return .customers
        case "/asiakkaat/asiakas": return id.map(AppLink.customer) ?? .customers
        case "/kirjanpito/ostolaskut": return id.map(AppLink.purchaseInvoice) ?? .purchaseInvoices
        case "/toistuvat": return .recurringInvoices
        case "/kirjanpito/kaudet", "/kirjanpito/kuukausi": return .periods
        case "/tyot": return .workQueue
        case "/raportit": return .reports
        case "/asetukset", "/asetukset/laskutus", "/asetukset/yritys", "/asetukset/profiili": return .settings
        case "/asetukset/tietosuoja": return .privacy
        case "/asetukset/ohje": return .help
        case "/asetukset/sahkoposti": return .emailImport
        case "/pankki": return .bankHub
        case "/tiliotteet", "/pankki/tiliotteet": return .statements
        case "/sahkoposti": return .emailInbox
        default: return nil
        }
    }
}
