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
        public let name: String?
        public let iban: String?
        public let inScope: Bool?
    }
    public let id: String
    public let aspspName: String
    public let aspspLogo: String?
    public let psuType: String?
    public let status: String
    public let validUntil: String?
    public let lastSyncAt: String?
    public let lastError: String?
    public let accounts: [Account]?
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
