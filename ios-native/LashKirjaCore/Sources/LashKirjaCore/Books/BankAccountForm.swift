import Foundation

/// IBAN handling, the same rules as the web's lib/iban.ts (ISO 13616 mod-97).
public enum BankIBAN {
    static let lengths: [String: Int] = [
        "AT": 20, "BE": 16, "CH": 21, "CZ": 24, "DE": 22, "DK": 18, "EE": 20, "ES": 24, "FI": 18,
        "FR": 27, "GB": 22, "IE": 22, "IS": 26, "IT": 27, "LT": 20, "LU": 20, "LV": 21, "NL": 18,
        "NO": 15, "PL": 28, "PT": 25, "SE": 24, "SI": 19, "SK": 24,
    ]

    public static func normalize(_ value: String) -> String {
        String(value.unicodeScalars.filter { ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) }.map(Character.init)).uppercased()
    }

    public static func isValid(_ value: String?) -> Bool {
        guard let value else { return false }
        let iban = normalize(value)
        guard iban.range(of: #"^[A-Z]{2}[0-9]{2}[0-9A-Z]{10,30}$"#, options: .regularExpression) != nil else { return false }
        if let expected = lengths[String(iban.prefix(2))], iban.count != expected { return false }
        let rearranged = iban.dropFirst(4) + iban.prefix(4)
        var remainder = 0
        for ch in rearranged {
            let digits: String
            if let d = ch.wholeNumberValue { digits = String(d) } else { digits = String(Int(ch.asciiValue!) - 55) }
            for d in digits { remainder = (remainder * 10 + d.wholeNumberValue!) % 97 }
        }
        return remainder == 1
    }

    /// "FI21 1234 5600 0007 85".
    public static func format(_ value: String) -> String {
        let n = normalize(value)
        var out = ""
        for (i, ch) in n.enumerated() {
            if i > 0 && i % 4 == 0 { out.append(" ") }
            out.append(ch)
        }
        return out
    }

    /// "FI•••• 0785".
    public static func mask(_ value: String) -> String {
        let n = normalize(value)
        guard n.count > 6 else { return n }
        return "\(n.prefix(2))•••• \(n.suffix(4))"
    }
}

/// What `POST /api/bank-accounts` and `PATCH /api/bank-accounts/[id]` take.
public struct BankAccountPayload: Encodable, Sendable, Equatable {
    public let name: String
    public let bankName: String?
    public let iban: String?
    public let bic: String?
    public let currency: String
    public let openingBalance: Decimal
    public let openingDate: String

    enum CodingKeys: String, CodingKey { case name, bankName, iban, bic, currency, openingBalance, openingDate }

    /// Empty optional fields go as null, so an edit can clear them.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(bankName, forKey: .bankName)
        try c.encode(iban, forKey: .iban)
        try c.encode(bic, forKey: .bic)
        try c.encode(currency, forKey: .currency)
        try c.encode(openingBalance, forKey: .openingBalance)
        try c.encode(openingDate, forKey: .openingDate)
    }
}

/// The add/edit form of a ledger bank account, validated as the web's BankAccountForm.
public struct BankAccountDraft: Sendable, Equatable {
    public struct Errors: Error, Sendable, Equatable {
        public var name: String?
        public var iban: String?
        public var openingBalance: String?
        public var openingDate: String?
        public var currency: String?
        public init() {}
        public var isEmpty: Bool { [name, iban, openingBalance, openingDate, currency].allSatisfy { $0 == nil } }
        /// The first problem, for a one-line message.
        public var first: String? { [name, iban, openingBalance, openingDate, currency].compactMap { $0 }.first }
    }

    public var name = ""
    public var bankName = ""
    public var iban = ""
    public var bic = ""
    public var currency = "EUR"
    public var openingBalance = "0"
    public var openingDate: String

    public init(today: Date = Date()) { openingDate = APIDate.dayString(today) }

    public init(account: BankAccount) {
        self.init()
        name = account.name
        bankName = account.bankName ?? ""
        iban = account.iban.map(BankIBAN.format) ?? ""
        bic = account.bic ?? ""
        currency = account.currency ?? "EUR"
        openingBalance = Money.format(account.openingBalance ?? 0).replacingOccurrences(of: "\u{00A0}€", with: "")
        if let date = account.openingDate { openingDate = String(date.prefix(10)) }
    }

    public func validate() -> Result<BankAccountPayload, Errors> {
        var errors = Errors()
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedName.isEmpty { errors.name = "Anna tilille nimi." }
        else if trimmedName.count > 80 { errors.name = "Nimi on liian pitkä (max 80 merkkiä)." }

        let normalizedIban = BankIBAN.normalize(iban)
        if !normalizedIban.isEmpty && !BankIBAN.isValid(normalizedIban) { errors.iban = "IBAN ei ole kelvollinen." }

        let balance = Money.parse(openingBalance)
        if let balance {
            var value = balance
            var rounded = Decimal()
            NSDecimalRound(&rounded, &value, 2, .plain)
            if rounded != balance { errors.openingBalance = "Enintään kaksi desimaalia." }
        } else {
            errors.openingBalance = "Anna summa, esim. 1250,50."
        }

        if APIDate.day(openingDate) == nil { errors.openingDate = "Valitse avauspäivä." }

        let code = currency.trimmingCharacters(in: .whitespaces).uppercased()
        if code.count != 3 { errors.currency = "Valuutta on kolme kirjainta (esim. EUR)." }

        guard errors.isEmpty, let balance else { return .failure(errors) }
        let bankTrimmed = bankName.trimmingCharacters(in: .whitespaces)
        let bicTrimmed = bic.replacingOccurrences(of: " ", with: "").uppercased()
        return .success(BankAccountPayload(
            name: trimmedName,
            bankName: bankTrimmed.isEmpty ? nil : bankTrimmed,
            iban: normalizedIban.isEmpty ? nil : normalizedIban,
            bic: bicTrimmed.isEmpty ? nil : bicTrimmed,
            currency: code,
            openingBalance: balance,
            openingDate: openingDate
        ))
    }
}

public enum BankAccountText {
    /// "Nordea · FI•••• 0785 · Oletus · 2 tiliotetta", the web's accountSecondary.
    public static func subtitle(_ a: BankAccount) -> String {
        let parts = [a.bankName, a.iban.map(BankIBAN.mask), a.currency.flatMap { $0 == "EUR" ? nil : $0 }]
            .compactMap { $0 }.filter { !$0.isEmpty }
        let base = parts.isEmpty ? "Ei IBANia" : parts.joined(separator: " · ")
        var flags: [String] = []
        if a.isDefault == true { flags.append("Oletus") }
        if a.archivedAt != nil { flags.append("Arkistoitu") }
        if let n = a.mismatchCount, n > 0 { flags.append("\(n) kk ei täsmää") }
        if let m = a.lastReconciledMonth { flags.append("Saldo täsmää \(StatementText.month(m))") }
        if let n = a.statementCount { flags.append(n == 1 ? "1 tiliote" : "\(n) tiliotetta") }
        return flags.isEmpty ? base : "\(base) · \(flags.joined(separator: " · "))"
    }

    /// The remove confirmation's body.
    public static func removeDescription(_ a: BankAccount) -> String {
        let n = a.statementCount ?? 0
        return n > 0 ? "\(a.name) – tilillä on \(n) tiliotetta, joten se arkistoidaan poiston sijaan." : a.name
    }
}

/// `DELETE /api/bank-accounts/[id]`: deleted, or archived when tiliotteet hang on it.
public struct BankAccountRemoval: Decodable, Sendable {
    public let deleted: Bool?
    public let archived: Bool
    public let statementCount: Int?
    public var message: String {
        archived ? "Tilillä on \(statementCount ?? 0) tiliotetta, joten se arkistoitiin poiston sijaan." : "Pankkitili poistettiin."
    }
}

/// `PUT /api/bank-accounts/[id]/balances`: the bank's closing balance of a month.
public struct BankBalanceInput: Encodable, Sendable, Equatable {
    public let month: String
    public let closingBalance: Decimal

    public static func make(month: String, amount: String) throws -> BankBalanceInput {
        guard month.range(of: #"^\d{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil else {
            throw LKError(status: 0, message: "Kuukausi puuttuu tai on virheellinen (YYYY-MM).")
        }
        guard let value = Money.parse(amount) else { throw LKError(status: 0, message: "Anna summa, esim. 1250,50.") }
        return BankBalanceInput(month: month, closingBalance: value)
    }
}

/// `GET /api/bank-accounts/[id]`: the month-by-month balances of one account.
public struct BankRollforward: Decodable, Sendable {
    public struct Month: Decodable, Sendable, Identifiable, Hashable {
        public let month: String
        public let income: Decimal?
        public let expense: Decimal?
        public let net: Decimal?
        public let txCount: Int?
        public let computedClosing: Decimal
        public let reportedClosing: Decimal?
        public let difference: Decimal?
        public let status: String
        public var id: String { month }

        public var statusLabel: String {
            switch status {
            case "reconciled": "Saldo täsmää"
            case "mismatch": "Ero"
            default: "Ei saldoa"
            }
        }
    }
    public struct Excluded: Decodable, Sendable {
        public let undatedTxCount: Int?
        public let preOpeningTxCount: Int?
        public let preOpeningAmount: Decimal?
    }
    public let months: [Month]
    public let currentBalance: Decimal?
    public let excluded: Excluded?
}
