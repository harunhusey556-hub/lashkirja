import Foundation

/// Koti's wording, shared by the view and its tests.
public enum Koti {
    public static func headline(blocking: Int) -> String {
        switch blocking {
        case ..<1: "Kaikki kunnossa"
        case 1: "1 asia ennen kuun loppua"
        default: "\(blocking) asiaa ennen kuun loppua"
        }
    }

    public static func accounts(_ count: Int) -> String {
        "\(count) \(count == 1 ? "tili" : "tiliä")"
    }

    /// The balances and open invoices are as of today, whichever month is shown (web F26).
    public static func positionTitle(atCurrentMonth: Bool) -> String {
        atCurrentMonth ? "Rahatilanne" : "Rahatilanne tänään"
    }

    /// "ALV-arvio · maksettavaa": the status card's one VAT line.
    public static func vatLine(isRefund: Bool?) -> String {
        "ALV-arvio · \(isRefund == true ? "palautusta" : "maksettavaa")"
    }

    // MARK: Rahatilanne rows (web `lib/koti-bank.ts` and the Avoimet laskut rows)

    /// The bank's state as the dashboard reports it; an unknown value counts by its accounts.
    public enum BankState: String, Sendable { case none, connected, reconnect, unscoped }

    public static func bankState(_ bank: Dashboard.BankSummary?) -> BankState {
        guard let bank else { return .none }
        return BankState(rawValue: bank.state) ?? (bank.accountCount > 0 ? .connected : .none)
    }

    /// A connected bank with a known balance gets the Rahatilanne card; every other state
    /// keeps a Pankkitilit row that says what to do.
    public static func showsBalanceCard(_ bank: Dashboard.BankSummary?) -> Bool {
        guard let bank else { return false }
        return bankState(bank) == .connected && bank.accountCount > 0 && bank.hasBalance
    }

    public struct PositionRow: Equatable, Sendable, Identifiable {
        public enum Kind: Hashable, Sendable { case bank, receivables, payables }
        public enum Tone: Equatable, Sendable { case normal, warning, danger }
        public let kind: Kind
        public let title: String
        public let amount: Decimal?
        public let secondary: String
        public let tone: Tone
        /// A bank to reconnect or to scope opens the account list, where that is done.
        public let fixesBank: Bool
        public var id: Kind { kind }
        public var accessibilityLabel: String {
            [title, amount.map { Money.format($0) }, secondary].compactMap { $0 }.joined(separator: ", ")
        }
    }

    /// The Pankkitilit row when there is no balance card; nil without any bank.
    public static func bankRow(_ bank: Dashboard.BankSummary?) -> PositionRow? {
        guard let bank, !showsBalanceCard(bank) else { return nil }
        let count = bank.accountCount
        let amount = count > 0 && bank.hasBalance ? bank.totalBalance : nil
        switch bankState(bank) {
        case .none:
            return nil
        case .reconnect:
            return PositionRow(kind: .bank, title: "Pankkitilit", amount: amount,
                               secondary: "Yhteys vanhentunut — yhdistä uudelleen", tone: .warning, fixesBank: true)
        case .unscoped:
            return PositionRow(kind: .bank, title: "Pankkitilit", amount: nil,
                               secondary: "Valitse kirjanpitoon kuuluvat tilit", tone: .normal, fixesBank: true)
        case .connected:
            guard count > 0 else { return nil }
            return PositionRow(kind: .bank, title: "Pankkitilit", amount: amount,
                               secondary: "\(accounts(count)) · saldo ei vielä haettu", tone: .normal, fixesBank: false)
        }
    }

    /// Avoimet myyntilaskut / ostolaskut, only while something is open. What is late is said
    /// in the danger colour with its count, so it is seen before the total.
    public static func openRow(_ totals: Dashboard.OpenTotals?, kind: PositionRow.Kind) -> PositionRow? {
        guard let totals, totals.totalOpen > 0, kind != .bank else { return nil }
        let title = kind == .receivables ? "Avoimet myyntilaskut" : "Avoimet ostolaskut"
        guard totals.overdue > 0 || totals.overdueCount > 0 else {
            return PositionRow(kind: kind, title: title, amount: totals.totalOpen,
                               secondary: "Ei myöhässä olevia", tone: .normal, fixesBank: false)
        }
        let count = totals.overdueCount
        let secondary = count > 0
            ? "\(count) \(count == 1 ? "lasku" : "laskua") myöhässä · \(Money.format(totals.overdue))"
            : "\(Money.format(totals.overdue)) myöhässä"
        return PositionRow(kind: kind, title: title, amount: totals.totalOpen, secondary: secondary, tone: .danger, fixesBank: false)
    }

    /// The rows under Rahatilanne. Open invoices are left out when they did not load
    /// (`sectionErrors.position`): their zeros would not be true.
    public static func positionRows(_ d: Dashboard) -> [PositionRow] {
        let positionFailed = d.sectionErrors?["position"] != nil
        return [
            bankRow(d.bank),
            positionFailed ? nil : openRow(d.receivables, kind: .receivables),
            positionFailed ? nil : openRow(d.payables, kind: .payables),
        ].compactMap { $0 }
    }

    /// The heading over the rows: with the balance card above them they are the open invoices.
    public static func positionsTitle(hasBalanceCard: Bool, atCurrentMonth: Bool) -> String {
        hasBalanceCard ? "Avoimet laskut" : positionTitle(atCurrentMonth: atCurrentMonth)
    }

    // MARK: Hoidettu automaattisesti (web `lib/koti-handled.ts`)

    public enum HandledTarget: Equatable, Sendable { case receipts, bankFeed, recurringInvoices }

    /// "14 tapahtumaa tällä viikolla".
    public static func handledTitle(count: Int) -> String {
        "\(count) \(count == 1 ? "tapahtuma" : "tapahtumaa") tällä viikolla"
    }

    /// The server's labels carry their counts: "12 kuittia sähköpostista ja 2 maksua kohdistettu viitenumerolla".
    public static func handledDetail(labels: [String]) -> String {
        guard labels.count > 1, let last = labels.last else { return labels.first ?? "" }
        return "\(labels.dropLast().joined(separator: ", ")) ja \(last)"
    }

    /// The list holding the biggest part (the parts come biggest first).
    public static func handledTarget(firstKind: String?) -> HandledTarget {
        switch firstKind {
        case "reference_payment": .bankFeed
        case "recurring_invoice": .recurringInvoices
        default: .receipts
        }
    }

    // MARK: Tulot ja menot

    /// The month next to `month` among the chart's months (VoiceOver's swipe up / down).
    public static func adjacentMonth(_ months: [String], from month: String, step: Int) -> String? {
        let sorted = months.sorted()
        guard let i = sorted.firstIndex(of: month) else { return nil }
        let j = i + step
        return sorted.indices.contains(j) ? sorted[j] : nil
    }

    public static func cashflowSummary(_ rows: [Dashboard.CashflowMonth], selected: String) -> String {
        let head = "Tulot ja menot, \(rows.count) kuukautta."
        guard let row = rows.first(where: { $0.month == selected }) else { return head }
        return "\(head) \(MonthKey.name(selected)): tulot \(Money.format(row.income)), menot \(Money.format(row.expenses))."
    }

    /// The parts of the dashboard that did not load, in a steady order.
    public static func failedSections(_ errors: [String: String]?) -> [String] {
        (errors ?? [:]).sorted { $0.key < $1.key }.map(\.value)
    }
}
