import Foundation

/// `GET /api/bank-accounts` read for the Pankki hub: the ledger accounts plus the server's
/// combined position (OWN-18), so the total counts connected-only accounts the way Koti does.
public struct BankHubPosition: Decodable, Sendable {
    public struct ConnectedAccount: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let iban: String?
        public let label: String?
        public let aspspName: String?
        public let currency: String?
        public let balance: Decimal?
        public let balanceAt: String?

        enum CodingKeys: String, CodingKey { case id, iban, label, aspspName, currency, balance, balanceAt }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            iban = try c.decodeIfPresent(String.self, forKey: .iban)
            label = try c.decodeIfPresent(String.self, forKey: .label)
            aspspName = try c.decodeIfPresent(String.self, forKey: .aspspName)
            currency = try c.decodeIfPresent(String.self, forKey: .currency)
            balance = try c.decodeMoneyIfPresent(.balance)
            balanceAt = try c.decodeIfPresent(String.self, forKey: .balanceAt)
        }
    }

    public struct Combined: Decodable, Sendable {
        /// "none", "connected", "reconnect" or "unscoped".
        public let state: String
        public let accountCount: Int
        public let totalBalance: Decimal
        public let excludedCurrencies: [String]
        public let reconnectBank: String?

        enum CodingKeys: String, CodingKey { case state, accountCount, totalBalance, excludedCurrencies, reconnectBank }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decode(String.self, forKey: .state)
            accountCount = try c.decodeIfPresent(Int.self, forKey: .accountCount) ?? 0
            totalBalance = try c.decodeMoney(.totalBalance)
            excludedCurrencies = try c.decodeIfPresent([String].self, forKey: .excludedCurrencies) ?? []
            reconnectBank = try c.decodeIfPresent(String.self, forKey: .reconnectBank)
        }
    }

    public let accounts: [BankAccount]
    public let totalBalance: Decimal
    public let needsAttention: Int
    public let connectedAccounts: [ConnectedAccount]
    /// Missing on an older server; the ledger total is used then.
    public let combined: Combined?

    enum CodingKeys: String, CodingKey { case accounts, totalBalance, needsAttention, connected, combined }
    private struct Connected: Decodable { let accounts: [ConnectedAccount]? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try c.decode([BankAccount].self, forKey: .accounts)
        totalBalance = try c.decodeMoney(.totalBalance)
        needsAttention = try c.decodeIfPresent(Int.self, forKey: .needsAttention) ?? 0
        connectedAccounts = try c.decodeIfPresent(Connected.self, forKey: .connected)?.accounts ?? []
        combined = try c.decodeIfPresent(Combined.self, forKey: .combined)
    }
}

/// The Pankki hub's figures, worked out from the statement list and the bank position.
public enum BankHub {
    /// One account line of the balance card: a ledger account or a connected-only one.
    public struct AccountLine: Sendable, Hashable, Identifiable {
        public let id: String
        public let name: String
        public let bank: String?
        public let balance: Decimal?
        /// "Viimeisin tapahtuma 30.9.2026" or "Pankin saldo 2.10.2026 klo 8.05".
        public let asOf: String?
        public let needsCheck: Bool
    }

    public struct MonthTotals: Sendable, Equatable {
        public var income: Decimal = 0
        public var expenses: Decimal = 0
        /// Own transfers and salaries, signed; kept out of income and expenses like the tiliote totals.
        public var transfers: Decimal = 0
        public var count = 0
        public var net: Decimal { income - expenses }
        public init() {}
    }

    /// The recent-rows filter chips: by direction of money, as the row's sign shows it.
    public enum Filter: String, CaseIterable, Identifiable, Sendable {
        case all, expenses, income
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .all: "Kaikki"
            case .expenses: "Menot"
            case .income: "Tulot"
            }
        }
        public func matches(_ row: BankTransaction) -> Bool {
            switch self {
            case .all: true
            case .expenses: row.amount < 0
            case .income: row.amount > 0
            }
        }
    }

    /// A row with the month the feed files it under, so a tap opens the feed on that month.
    public struct RecentRow: Sendable, Hashable, Identifiable {
        public let row: BankTransaction
        public let month: String
        public var id: String { row.id }
    }

    public static let recentLimit = 10

    /// The month a row is listed under: its statement's month, as in `BankFeed.months` and the
    /// server's `?month=` filter, so the drill-down shows the same rows.
    static func month(of row: BankTransaction, in statement: Statement) -> String {
        statement.periodMonth ?? row.date.map(APIDate.monthOf) ?? ""
    }

    /// Income and expenses by row type, the same split as the server's statement totals.
    public static func totals(_ statements: [Statement], month: String) -> MonthTotals {
        var totals = MonthTotals()
        for statement in statements {
            for row in statement.transactions where Self.month(of: row, in: statement) == month {
                totals.count += 1
                switch row.type {
                case "tulo": totals.income += row.amount
                case "meno": totals.expenses += abs(row.amount)
                case "oma_siirto", "palkka": totals.transfers += row.amount
                default: break
                }
            }
        }
        return totals
    }

    /// The newest rows first, undated last.
    public static func recent(_ statements: [Statement], filter: Filter, limit: Int = recentLimit) -> [RecentRow] {
        let rows = statements.flatMap { statement in
            statement.transactions.filter(filter.matches).map { RecentRow(row: $0, month: month(of: $0, in: statement)) }
        }
        let sorted = rows.sorted { a, b in
            switch (a.row.date, b.row.date) {
            case let (x?, y?) where x != y: return x > y
            case (nil, _?): return false
            case (_?, nil): return true
            default: return a.row.id < b.row.id
            }
        }
        return Array(sorted.prefix(max(limit, 0)))
    }

    /// The oldest month with rows; the month stepper stops there.
    public static func oldestMonth(_ statements: [Statement]) -> String? {
        statements.flatMap { s in s.transactions.map { month(of: $0, in: s) } }.filter { !$0.isEmpty }.min()
    }

    /// The month the hub opens on: this month once it has rows, else the latest month that has,
    /// so early in a month the card does not open on zeros.
    public static func startMonth(_ statements: [Statement], current: String = MonthKey.current()) -> String {
        if totals(statements, month: current).count > 0 { return current }
        let latest = statements.flatMap { s in s.transactions.map { month(of: $0, in: s) } }.filter { !$0.isEmpty && $0 < current }.max()
        return latest ?? current
    }

    public static func canStepBack(_ month: String, oldest: String?) -> Bool {
        guard let oldest else { return false }
        return month > oldest
    }

    public static func canStepForward(_ month: String, current: String = MonthKey.current()) -> Bool {
        month < current
    }

    /// The total across accounts in use: the server's combined figure when it sends one.
    public static func total(_ position: BankHubPosition) -> Decimal {
        position.combined?.totalBalance ?? position.totalBalance
    }

    /// Ledger accounts in use, then accounts known only through the bank connection.
    public static func accountLines(_ position: BankHubPosition, statements: [Statement]) -> [AccountLine] {
        let ledger = position.accounts.filter { $0.archivedAt == nil }.map { account in
            let latest = statements.filter { $0.bankAccount?.id == account.id }
                .flatMap(\.transactions).compactMap(\.date).max()
            return AccountLine(
                id: account.id,
                name: account.name,
                bank: account.bankName.flatMap { $0.isEmpty ? nil : $0 },
                balance: account.balance,
                asOf: latest.map { "Viimeisin tapahtuma \(APIDate.displayDay($0))" },
                needsCheck: (account.mismatchCount ?? 0) > 0
            )
        }
        let connected = position.connectedAccounts.map { account in
            AccountLine(
                id: "connected-\(account.id)",
                name: account.label.flatMap { $0.isEmpty ? nil : $0 } ?? account.iban.map(BankIBAN.mask) ?? "Pankkitili",
                bank: account.aspspName,
                balance: account.balance,
                asOf: account.balanceAt.map { "Pankin saldo \(APIDate.timestamp($0))" },
                needsCheck: false
            )
        }
        return ledger + connected
    }

    /// Nothing to show yet: no account, no connection waiting and no imported rows.
    public static func isEmpty(_ position: BankHubPosition?, statements: [Statement]) -> Bool {
        let noRows = statements.allSatisfy { $0.transactions.isEmpty }
        guard let position else { return noRows }
        let state = position.combined?.state ?? "none"
        return noRows && position.accounts.allSatisfy { $0.archivedAt != nil }
            && position.connectedAccounts.isEmpty && (state == "none" || state == "connected")
    }

    /// A line under the total when the connection needs the owner.
    public static func connectionNotice(_ position: BankHubPosition) -> String? {
        switch position.combined?.state {
        case "reconnect":
            let bank = position.combined?.reconnectBank.map { " (\($0))" } ?? ""
            return "Pankkiyhteys\(bank) on vanhentunut. Yhdistä pankki uudelleen."
        case "unscoped":
            return "Pankki on yhdistetty, mutta yhtään tiliä ei ole valittu kirjanpitoon."
        default:
            return nil
        }
    }
}
