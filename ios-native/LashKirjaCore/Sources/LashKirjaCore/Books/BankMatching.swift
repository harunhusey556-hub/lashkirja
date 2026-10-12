import Foundation

/// One receipt the matcher offers for a bank row (`/api/matching/candidates`,
/// and the statement GET's inline `matchCandidates`).
public struct BankMatchCandidate: Decodable, Sendable, Hashable {
    public struct Receipt: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let vendor: String?
        public let date: String?
        public let totalAmount: Decimal?

        public init(id: String, vendor: String?, date: String?, totalAmount: Decimal?) {
            self.id = id
            self.vendor = vendor
            self.date = date
            self.totalAmount = totalAmount
        }
    }

    public let score: Double
    public let reasons: [String]?
    /// Finnish reasons ("summa sama", "nimi vastaa", "veloitettu 2 päivää oston jälkeen").
    public let explanation: [String]?
    public let receipt: Receipt?

    /// "87 %" as the web shows it.
    public var percent: Int { Int((score * 100).rounded()) }

    /// "Miksi: summa sama · nimi vastaa", or nil when the server gave no reasons.
    public var why: String? { BankMatchText.why(explanation ?? []) }
}

/// `Transaction.matchReasons`: a JSON array stored as text (the statement GET)
/// or sent as an array. Codes ("viite", "amount") are for the program; the
/// "fi:" entries are the Finnish reasons for people. Anything unreadable is empty.
public struct MatchReasons: Decodable, Sendable, Hashable {
    public let entries: [String]

    public init(entries: [String]) { self.entries = entries }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let list = try? container.decode([String].self) {
            entries = list
        } else if let text = try? container.decode(String.self),
                  let data = text.data(using: .utf8),
                  let list = try? JSONDecoder().decode([String].self, from: data) {
            entries = list
        } else {
            entries = []
        }
    }

    /// The Finnish reasons, without the "fi:" prefix.
    public var finnish: [String] {
        entries.filter { $0.hasPrefix("fi:") }.map { String($0.dropFirst(3)) }.filter { !$0.isEmpty }
    }

    /// The AI review confirmed this suggestion.
    public var reviewed: Bool { entries.contains("ai") }
}

public struct BankMatchCandidates: Decodable, Sendable {
    public let candidates: [BankMatchCandidate]
    /// Candidates whose receipt still exists.
    public var usable: [BankMatchCandidate] { candidates.filter { $0.receipt != nil } }
}

public enum BankMatchText {
    /// "K-Market · 12,50 € · 1.10.2026", the web's receiptLabel.
    public static func receiptLabel(_ r: BankMatchCandidate.Receipt) -> String {
        var parts = [r.vendor.flatMap { $0.isEmpty ? nil : $0 } ?? "Kuitti"]
        if let amount = r.totalAmount { parts.append(Money.format(amount)) }
        if let date = r.date { parts.append(APIDate.displayDay(date)) }
        return parts.joined(separator: " · ")
    }

    /// "Miksi: viite täsmää · summa sama · maksettu 3 päivää eräpäivän jälkeen".
    /// Older chat cards stored codes; they read as Finnish, and internal ones are dropped.
    private static let codeText: [String: String?] = [
        "viite": "viite täsmää", "amount": "summa sama", "vendor": "nimi vastaa", "iban": "tilinumero sama",
        "date": nil, "competing": nil, "ai": nil, "manual": nil, "auto_income": nil, "approved": nil,
    ]

    public static func why(_ reasons: [String]) -> String? {
        let parts = reasons
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { reason -> String? in codeText.keys.contains(reason) ? codeText[reason] ?? nil : reason }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : "Miksi: " + parts.joined(separator: " · ")
    }
}

/// `POST /api/matching/run`.
public struct BankMatchRunResult: Decodable, Sendable {
    public let autoConfirmed: Int?
    public let suggested: Int?
    public let draftsCreated: Int?

    /// What the web says after "Etsi kuitteja uudelleen"; nil when nothing changed.
    public var summary: String? {
        var parts: [String] = []
        if let n = autoConfirmed, n > 0 { parts.append("\(n) kohdistettu automaattisesti") }
        if let n = suggested, n > 0 { parts.append("\(n) ehdotusta odottaa") }
        if let n = draftsCreated, n > 0 { parts.append(n == 1 ? "1 uusi myyntiehdotus odottaa" : "\(n) uutta myyntiehdotusta odottaa") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// `POST /api/matching/confirm-all` body; a missing scope is left out (the schema is strict).
public struct BankConfirmAllRequest: Encodable, Sendable {
    public let statementId: String?
    public let periodMonth: String?

    public init(statementId: String? = nil, periodMonth: String? = nil) {
        self.statementId = statementId
        self.periodMonth = periodMonth
    }
}

public struct BankConfirmAllResult: Decodable, Sendable {
    public let confirmed: Int?
    public var message: String? {
        guard let n = confirmed, n > 0 else { return nil }
        return "\(n) kuittia kohdistettu"
    }
}

extension BankFeed {
    /// The months offered in the feed's month picker, newest first.
    public static func monthChoices(current: String = MonthKey.current(), count: Int = 12) -> [String] {
        (0..<max(count, 0)).map { MonthKey.shift(current, by: -$0) }
    }

    /// The `GET /api/statements` query: `month` only when one is chosen.
    public static func query(month: String?) -> [String: String] {
        guard let month, !month.isEmpty else { return [:] }
        return ["month": month]
    }

    /// Why the matcher suggested the row's receipt, as the sheet shows it.
    public static func matchWhy(_ row: BankTransaction) -> String? {
        BankMatchText.why(row.matchReasons?.finnish ?? [])
    }

    /// Kuitti suggestions that "Kohdista kaikki" would link (sales are approved one by one).
    public static func confirmableSuggestions(_ rows: [BankTransaction]) -> Int {
        rows.filter { state(of: $0) == .suggested }.count
    }

    /// What "Hyväksy kuittiehdotukset" is about to link, shown before it does: the pairs, the
    /// money they cover and how many of them disagree on the amount by more than a fee.
    public struct ConfirmPreview: Sendable, Equatable, Identifiable {
        public struct Pair: Sendable, Equatable, Identifiable {
            public let id: String
            public let counterparty: String
            public let date: String?
            public let amount: Decimal
            public let receiptVendor: String
            public let receiptTotal: Decimal?
            /// Bank amount minus receipt total when it is more than a fee (`ReceiptMatchText.amountGap`).
            public let gap: Decimal?
        }
        public let pairs: [Pair]
        public var id: String { pairs.map(\.id).joined(separator: ",") }
        public var count: Int { pairs.count }
        /// The bank rows' money, as a positive sum.
        public var total: Decimal { pairs.reduce(0) { $0 + abs($1.amount) } }
        public var mismatched: Int { pairs.filter { $0.gap != nil }.count }
    }

    public static func confirmPreview(_ rows: [BankTransaction]) -> ConfirmPreview {
        ConfirmPreview(pairs: rows.filter { state(of: $0) == .suggested }.map { row in
            ConfirmPreview.Pair(
                id: row.id,
                counterparty: row.counterparty?.isEmpty == false ? row.counterparty! : "Pankkitapahtuma",
                date: row.date,
                amount: row.amount,
                receiptVendor: row.suggestedReceipt?.vendor?.isEmpty == false ? row.suggestedReceipt!.vendor! : "Kuitti",
                receiptTotal: row.suggestedReceipt?.totalAmount,
                gap: ReceiptMatchText.amountGap(bank: row.amount, receiptTotal: row.suggestedReceipt?.totalAmount)
            )
        })
    }

    /// Whether "Etsi kuitti" makes sense for a row: open, and not a transfer or salary.
    public static func canSearchReceipts(_ row: BankTransaction) -> Bool {
        if row.type == "oma_siirto" || row.type == "palkka" { return false }
        return row.matchStatus == "unmatched" || row.matchStatus == "suggested"
    }
}
