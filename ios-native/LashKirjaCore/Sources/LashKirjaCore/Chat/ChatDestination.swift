import Foundation

/// A screen an assistant reply points to, shown as a tappable card under the reply.
public struct ChatDestination: Equatable, Sendable, Identifiable {
    /// The href the card opens (the source's own; a bank card opens the Pankki hub instead).
    public let href: String
    public let link: AppLink
    public let title: String
    /// One line under the title.
    public let detail: String
    /// SF Symbol name.
    public let symbol: String
    /// The server marked it as something to do there ("Uusi lasku", "Yhdistä pankki").
    public let isAction: Bool
    /// The live bank card: balance and accounts, opens the Pankki hub.
    public let isBank: Bool

    public var id: String { href }

    /// The cards for a reply's sources, in their order: unknown hrefs are left out, a screen
    /// cited twice shows once, and every general bank link folds into one bank card.
    public static func cards(_ sources: [ChatSource]) -> [ChatDestination] {
        var cards: [ChatDestination] = []
        var seen: [AppLink] = []
        var hasBank = false
        for source in sources {
            guard let card = make(source), !seen.contains(card.link) else { continue }
            if card.isBank {
                if hasBank { continue }
                hasBank = true
            }
            seen.append(card.link)
            cards.append(card)
        }
        return cards
    }

    public static func make(_ source: ChatSource) -> ChatDestination? {
        guard let link = AppLink.parse(source.href) else { return nil }
        let action = source.kind == "action"
        let label = source.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let bank = isGeneralBank(link, action: action)
        let fallback = info(link)
        return ChatDestination(
            href: source.href,
            link: link,
            title: bank ? "Pankki" : (label.isEmpty ? fallback.title : label),
            detail: bank ? "Saldot ja tilitapahtumat" : fallback.detail,
            symbol: fallback.symbol,
            isAction: action,
            isBank: bank
        )
    }

    /// Bank links that are about the bank as a whole. A link to one row or one statement file
    /// keeps its own card (it opens that row), and so does an action such as "Yhdistä pankki",
    /// which is done on the bank accounts screen.
    static func isGeneralBank(_ link: AppLink, action: Bool) -> Bool {
        switch link {
        case .bankHub, .statements: return true
        case .bankAccounts: return !action
        case .bankFeed(_, _, let row): return row == nil && !action
        default: return false
        }
    }

    /// "Syyskuu 2026" for a "2026-09" key; other keys as they are.
    static func monthLabel(_ key: String) -> String {
        let name = MonthKey.name(key)
        guard name != key, key.count >= 4 else { return key }
        return "\(name) \(key.prefix(4))"
    }

    static func info(_ link: AppLink) -> (title: String, detail: String, symbol: String) {
        switch link {
        case .receipts(let month, let type, _):
            var detail = month.isEmpty ? "Ladatut kuitit ja niiden tiedot" : monthLabel(month)
            if type == "tulo" { detail += " · tulot" }
            if type == "meno" { detail += " · menot" }
            return ("Kuitit", detail, "receipt")
        case .receipt: return ("Kuitti", "Kuitin tiedot ja kohdistus", "receipt")
        case .bankFeed(let month, let onlyOpen, let row):
            if row != nil { return ("Pankkitapahtuma", "Avaa tapahtuma ja sen kuitti", "arrow.left.arrow.right") }
            let detail = onlyOpen ? "Tapahtumat, jotka odottavat sinua" : (month.map(monthLabel) ?? "Pankkitapahtumat ja kohdistukset")
            return ("Pankkitapahtumat", detail, "arrow.left.arrow.right")
        case .statement: return ("Tiliote", "Tiliotteen tapahtumat", "doc.plaintext")
        case .bankAccounts: return ("Pankkitilit", "Pankkitilit ja pankkiyhteys", "building.columns")
        case .alv(let period): return ("ALV-ilmoitus", period.map { "Kausi \(monthLabel($0))" } ?? "ALV-laskelma ja ilmoitus", "percent")
        case .invoices: return ("Laskut", "Myyntilaskut ja niiden tila", "doc.text")
        case .invoicesFiltered(let month, _, _):
            return ("Laskut", month.isEmpty ? "Myyntilaskut ja niiden tila" : monthLabel(month), "doc.text")
        case .invoice: return ("Lasku", "Laskun tiedot", "doc.text")
        case .newInvoice: return ("Uusi lasku", "Luo ja lähetä myyntilasku", "square.and.pencil")
        case .customers: return ("Asiakkaat", "Asiakasrekisteri", "person.2")
        case .customer: return ("Asiakas", "Asiakkaan tiedot ja laskut", "person")
        case .purchaseInvoices: return ("Ostolaskut", "Saapuneet laskut", "tray.and.arrow.down")
        case .purchaseInvoice: return ("Ostolasku", "Ostolaskun tiedot", "tray.and.arrow.down")
        case .recurringInvoices: return ("Toistuvat laskut", "Säännöllisesti lähtevät laskut", "arrow.triangle.2.circlepath")
        case .periods: return ("Kuukauden sulku", "Kuukausien tarkistus ja sulkeminen", "calendar")
        case .workQueue: return ("Tehtävät", "Asiat, jotka odottavat sinua", "checklist")
        case .reports: return ("Raportit", "Tuloslaskelma, tase ja viennit", "chart.bar")
        case .settings: return ("Asetukset", "Profiili, yritys ja laskutus", "gearshape")
        case .privacy: return ("Tietosuoja", "Omat tiedot ja niiden käsittely", "hand.raised")
        case .help: return ("Ohje", "Ohjeet ja vastauksia", "questionmark.circle")
        case .emailImport: return ("Sähköpostituonti", "Postilaatikon yhdistäminen", "envelope.badge")
        case .bankHub: return ("Pankki", "Saldot ja tilitapahtumat", "building.columns")
        case .statements: return ("Tiliotteet", "Tuo ja selaa tiliotteita", "doc.plaintext")
        case .emailInbox: return ("Sähköposti", "Sähköpostista tulleet laskut", "envelope")
        }
    }
}

/// The live bank card's figures from `GET /api/bank-accounts`, as the Pankki hub counts them.
public struct ChatBankSummary: Equatable, Sendable {
    public let total: Decimal
    public let accountCount: Int
    /// The hub's connection notice (expired consent, no account chosen).
    public let notice: String?

    public init(total: Decimal, accountCount: Int, notice: String? = nil) {
        self.total = total
        self.accountCount = accountCount
        self.notice = notice
    }

    public init(_ position: BankHubPosition) {
        total = BankHub.total(position)
        accountCount = BankHub.accountLines(position, statements: []).count
        notice = BankHub.connectionNotice(position)
    }

    /// "2 tiliä", "1 tili", or a nudge when there is no account yet.
    public var accountsLabel: String {
        switch accountCount {
        case 0: "Ei pankkitilejä vielä"
        case 1: "1 tili"
        default: "\(accountCount) tiliä"
        }
    }
}

/// Links inside a reply's text (`[Kuitit](/kuitit?month=…)`).
public enum ChatInlineLink {
    /// The in-app href a tapped link names, or nil for a web address the system should open.
    /// Markdown turns "/kuitit" into a URL without a scheme or host.
    public static func inAppHref(_ url: URL) -> String? {
        guard url.scheme == nil, url.host == nil else { return nil }
        let href = url.absoluteString
        guard href.hasPrefix("/"), !href.hasPrefix("//") else { return nil }
        return href
    }
}
