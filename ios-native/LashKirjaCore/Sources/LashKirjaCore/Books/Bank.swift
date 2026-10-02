import Foundation

public struct BankAccount: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let bankName: String?
    public let iban: String?
    public let currency: String?
    public let balance: Decimal?
    public let archivedAt: String?
    public let bic: String?
    public let openingBalance: Decimal?
    public let openingDate: String?
    public let isDefault: Bool?
    public let statementCount: Int?
    public let mismatchCount: Int?
    public let lastReconciledMonth: String?

    enum CodingKeys: String, CodingKey {
        case id, name, bankName, iban, currency, archivedAt
        case bic, openingBalance, openingDate, isDefault, statementCount, mismatchCount, lastReconciledMonth
        case balance = "currentBalance"
    }
}

public struct BankAccountsOverview: Decodable, Sendable {
    public let accounts: [BankAccount]
    public let totalBalance: Decimal
    public let needsAttention: Int
    public let archivedCount: Int?
}

public struct BankConnection: Decodable, Sendable, Identifiable, Hashable {
    public struct Account: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        /// The bank's own name for the account (`label` on the server; `name` on old payloads).
        public let name: String?
        public let iban: String?
        public let currency: String?
        public let inScope: Bool?
        public let balance: Decimal?
        public let balanceAt: String?

        enum CodingKeys: String, CodingKey { case id, name, label, iban, currency, inScope, balance, balanceAt }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .label) ?? c.decodeIfPresent(String.self, forKey: .name)
            iban = try c.decodeIfPresent(String.self, forKey: .iban)
            currency = try c.decodeIfPresent(String.self, forKey: .currency)
            inScope = try c.decodeIfPresent(Bool.self, forKey: .inScope)
            balance = try c.decodeMoneyIfPresent(.balance)
            balanceAt = try c.decodeIfPresent(String.self, forKey: .balanceAt)
        }

        public init(id: String, name: String?, iban: String?, currency: String? = "EUR", inScope: Bool?, balance: Decimal? = nil, balanceAt: String? = nil) {
            self.id = id
            self.name = name
            self.iban = iban
            self.currency = currency
            self.inScope = inScope
            self.balance = balance
            self.balanceAt = balanceAt
        }
    }
    public let id: String
    public let aspspName: String
    public let aspspLogo: String?
    public let psuType: String?
    public let status: String
    public let validUntil: String?
    /// The last attempt, failed or not.
    public let lastSyncAt: String?
    /// The last fetch that went through; a failed attempt never moves it.
    public let lastSuccessAt: String?
    public let lastError: String?
    public let accounts: [Account]?
    /// "YYYY-MM-DD": the earliest day fetched or asked for; nil = all the bank allows.
    public let historyFrom: String?
    /// How many days back the bank gives rows, when known.
    public let historyLimitDays: Int?
    /// False on a server that does not report the fetch window yet: the window controls stay hidden,
    /// since its PATCH would reject `historyFrom`.
    public let reportsHistory: Bool

    enum CodingKeys: String, CodingKey {
        case id, aspspName, aspspLogo, psuType, status, validUntil, lastSyncAt, lastSuccessAt, lastError, accounts, historyFrom, historyLimitDays
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        aspspName = try c.decode(String.self, forKey: .aspspName)
        aspspLogo = try c.decodeIfPresent(String.self, forKey: .aspspLogo)
        psuType = try c.decodeIfPresent(String.self, forKey: .psuType)
        status = try c.decode(String.self, forKey: .status)
        validUntil = try c.decodeIfPresent(String.self, forKey: .validUntil)
        lastSyncAt = try c.decodeIfPresent(String.self, forKey: .lastSyncAt)
        lastSuccessAt = try c.decodeIfPresent(String.self, forKey: .lastSuccessAt)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        accounts = try c.decodeIfPresent([Account].self, forKey: .accounts)
        historyFrom = try c.decodeIfPresent(String.self, forKey: .historyFrom)
        historyLimitDays = try c.decodeIfPresent(Int.self, forKey: .historyLimitDays)
        reportsHistory = c.contains(.historyFrom)
    }

    public init(id: String, aspspName: String, status: String = "active", accounts: [Account]?,
                historyFrom: String? = nil, historyLimitDays: Int? = nil, reportsHistory: Bool = true,
                validUntil: String? = nil, lastSyncAt: String? = nil, lastSuccessAt: String? = nil,
                lastError: String? = nil, psuType: String? = nil) {
        self.id = id
        self.aspspName = aspspName
        self.aspspLogo = nil
        self.psuType = psuType
        self.status = status
        self.validUntil = validUntil
        self.lastSyncAt = lastSyncAt
        self.lastSuccessAt = lastSuccessAt
        self.lastError = lastError
        self.accounts = accounts
        self.historyFrom = historyFrom
        self.historyLimitDays = historyLimitDays
        self.reportsHistory = reportsHistory
    }
}

public struct BankConnections: Decodable, Sendable {
    public let enabled: Bool
    public let ready: Bool
    public let message: String?
    public let connections: [BankConnection]
}

public struct Aspsp: Decodable, Sendable, Identifiable, Hashable {
    public let name: String
    public let country: String
    public let logo: String?
    public let psuTypes: [String]
    public let beta: Bool?
    public var id: String { name }
}

public struct AspspList: Decodable, Sendable { public let aspsps: [Aspsp] }

/// Bank picker search, the same as the web: each typed word starts a word of
/// the name, Finnish letters match their plain forms ("saasto" → Säästöpankki).
public enum BankSearch {
    static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "fi_FI"))
    }
    static func words(_ text: String) -> [String] {
        fold(text).split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    }
    public static func matches(_ name: String, _ query: String) -> Bool {
        let typed = words(query)
        if typed.isEmpty { return true }
        let nameWords = words(name)
        let joined = nameWords.joined()
        return typed.allSatisfy { part in nameWords.contains { $0.hasPrefix(part) } || joined.hasPrefix(typed.joined()) }
    }
}
