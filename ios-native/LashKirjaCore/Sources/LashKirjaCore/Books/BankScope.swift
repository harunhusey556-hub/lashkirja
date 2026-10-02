import Foundation

/// Which connected accounts belong to the books (`PATCH /api/bank/connections/[id]`).
public enum BankScope {
    /// One account's choice, as the PATCH takes it.
    public struct Change: Encodable, Sendable, Equatable {
        public let id: String
        public let inScope: Bool
        public init(id: String, inScope: Bool) {
            self.id = id
            self.inScope = inScope
        }
    }

    public struct Body: Encodable, Sendable, Equatable {
        public let accounts: [Change]
    }

    public static let atLeastOneMessage =
        "Valitse ainakin yksi tili. Pankista haetaan tapahtumat vain kirjanpitoon valituilta tileiltä."

    public static func accounts(_ connection: BankConnection) -> [BankConnection.Account] {
        connection.accounts ?? []
    }

    public static func inScopeIDs(_ connection: BankConnection) -> Set<String> {
        Set(accounts(connection).filter { $0.inScope == true }.map(\.id))
    }

    /// The server's "unscoped": a working connection with accounts, none chosen for the books.
    public static func isUnscoped(_ connection: BankConnection) -> Bool {
        connection.status == "active" && !accounts(connection).isEmpty && inScopeIDs(connection).isEmpty
    }

    public static func unscoped(_ connections: [BankConnection]) -> [BankConnection] {
        connections.filter(isUnscoped)
    }

    /// Right after consent: new accounts never join the books by themselves, so ask while the owner is here.
    public static func shouldAskAfterConnect(_ connection: BankConnection) -> Bool {
        let all = accounts(connection)
        return !all.isEmpty && inScopeIDs(connection).count < all.count
    }

    /// Nil when the selection can be saved, else why not.
    public static func problem(selected: Set<String>, in connection: BankConnection) -> String? {
        let known = Set(accounts(connection).map(\.id))
        return selected.intersection(known).isEmpty ? atLeastOneMessage : nil
    }

    /// Every account with its new choice: the server takes one to a hundred, and sending all keeps
    /// the request independent of what the screen loaded earlier.
    public static func body(selected: Set<String>, in connection: BankConnection) -> Body {
        Body(accounts: accounts(connection).map { Change(id: $0.id, inScope: selected.contains($0.id)) })
    }

    public static func title(_ account: BankConnection.Account) -> String {
        if let name = account.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return "Tili"
    }

    public static func iban(_ account: BankConnection.Account) -> String? {
        guard let iban = account.iban, !iban.isEmpty else { return nil }
        return BankIBAN.format(iban)
    }

    /// "2/3 tiliä kirjanpidossa", or the call to choose when none is.
    public static func summary(_ connection: BankConnection) -> String {
        let all = accounts(connection).count
        let chosen = inScopeIDs(connection).count
        if all == 0 { return "Pankki ei antanut tilejä" }
        if chosen == 0 { return "Yhtään tiliä ei ole valittu kirjanpitoon" }
        if chosen == all { return all == 1 ? "Tili on kirjanpidossa" : "Kaikki \(all) tiliä kirjanpidossa" }
        return "\(chosen)/\(all) tiliä kirjanpidossa"
    }
}

/// `POST /api/bank/connections/[id]/sync`.
public struct BankSyncResult: Decodable, Sendable, Equatable {
    public let imported: Int
    public let skipped: Int
    public let notice: String?

    enum CodingKeys: String, CodingKey { case imported, skipped, notice }

    public init(imported: Int, skipped: Int = 0, notice: String? = nil) {
        self.imported = imported
        self.skipped = skipped
        self.notice = notice
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        imported = try c.decodeIfPresent(Int.self, forKey: .imported) ?? 0
        skipped = try c.decodeIfPresent(Int.self, forKey: .skipped) ?? 0
        notice = try c.decodeIfPresent(String.self, forKey: .notice)
    }

    /// "Haettiin 12 tapahtumaa." plus the server's note, if any.
    public var summary: String {
        let head: String
        switch imported {
        case 0: head = "Ei uusia tapahtumia."
        case 1: head = "Haettiin 1 tapahtuma."
        default: head = "Haettiin \(imported) tapahtumaa."
        }
        guard let notice = notice?.trimmingCharacters(in: .whitespacesAndNewlines), !notice.isEmpty else { return head }
        return "\(head) \(notice)"
    }
}

/// "Mistä lähtien haetaan?": the first sync's start, and later fetching older rows.
public enum BankHistory {
    public struct Choice: Sendable, Hashable, Identifiable {
        public let key: String
        public let label: String
        public let hint: String?
        /// "YYYY-MM-DD", or nil for everything the bank allows.
        public let from: String?
        public var id: String { key }
    }

    /// The web's default ("Vuoden alusta", marked Suositus).
    public static let defaultKey = "year"

    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Helsinki")!
        return c
    }

    public static func currentDay() -> String { APIDate.dayString(Date()) }

    private static func parts(_ day: String) -> (year: Int, month: Int)? {
        let bits = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard bits.count == 3 else { return nil }
        return (bits[0], bits[1])
    }

    private static func firstOfMonth(year: Int, month: Int, minus back: Int) -> String {
        let index = year * 12 + (month - 1) - back
        return String(format: "%04d-%02d-01", index / 12, index % 12 + 1)
    }

    /// The same four choices as the web's BankPickerSheet, in Helsinki time.
    public static func connectChoices(today: String = currentDay()) -> [Choice] {
        guard let p = parts(today) else { return [] }
        let (year, month) = p
        return [
            Choice(key: "month", label: "Tämä kuukausi", hint: nil, from: firstOfMonth(year: year, month: month, minus: 0)),
            Choice(key: "year", label: "Vuoden \(year) alusta", hint: "Suositus", from: String(format: "%04d-01-01", year)),
            Choice(key: "12m", label: "Viimeiset 12 kuukautta", hint: nil, from: firstOfMonth(year: year, month: month, minus: 11)),
            Choice(key: "all", label: "Kaikki, mitä pankki antaa", hint: "Voi olla useita vuosia", from: nil),
        ]
    }

    /// "Hakuväli: 1.1.2026 alkaen" or "Hakuväli: kaikki, mitä pankki antaa".
    public static func rangeLabel(_ historyFrom: String?) -> String {
        guard let historyFrom, APIDate.day(String(historyFrom.prefix(10))) != nil else {
            return "Hakuväli: kaikki, mitä pankki antaa"
        }
        return "Hakuväli: \(APIDate.displayDay(historyFrom)) alkaen"
    }

    /// The earliest day the bank gives, when its limit is known. One day inside the limit, so a
    /// boundary the server counts differently never turns into an error.
    public static func earliest(limitDays: Int?, today: String = currentDay()) -> String? {
        guard let limitDays, limitDays > 0, let now = APIDate.day(today),
              let date = calendar.date(byAdding: .day, value: -(limitDays - 1), to: now) else { return nil }
        return APIDate.dayString(date)
    }

    /// "13 kuukauden" / "20 päivän", for the limit sentence.
    public static func limitText(_ limitDays: Int) -> String {
        limitDays >= 60 ? "\(limitDays / 30) kuukauden" : "\(limitDays) päivän"
    }

    /// Older starts than the current one, within the bank's limit, newest first.
    public static func backfillChoices(current: String?, limitDays: Int?, today: String = currentDay()) -> [Choice] {
        guard let current, let p = parts(today) else { return [] }
        let (year, month) = p
        let floor = earliest(limitDays: limitDays, today: today)
        var candidates = [
            Choice(key: "year", label: "Vuoden \(year) alusta", hint: nil, from: String(format: "%04d-01-01", year)),
            Choice(key: "12m", label: "Viimeiset 12 kuukautta", hint: nil, from: firstOfMonth(year: year, month: month, minus: 11)),
            Choice(key: "prevYear", label: "Vuoden \(year - 1) alusta", hint: nil, from: String(format: "%04d-01-01", year - 1)),
        ]
        if let floor, let limitDays {
            candidates.append(Choice(key: "all", label: "Kaikki, mitä pankki antaa",
                                     hint: "Enintään \(limitText(limitDays)) ajalta", from: floor))
        }
        var seen = Set<String>()
        return candidates
            .filter { choice in
                guard let from = choice.from, from < current else { return false }
                if let floor, from < floor { return false }
                return seen.insert(from).inserted
            }
            .sorted { ($0.from ?? "") > ($1.from ?? "") }
    }

    /// Nil when `from` can be asked for as an older start, else the Finnish reason.
    public static func backfillProblem(from: String, current: String?, limitDays: Int?, today: String = currentDay()) -> String? {
        guard APIDate.day(from) != nil else { return "Virheellinen päivä." }
        if from > today { return "Päivä ei voi olla tulevaisuudessa." }
        if let current, from >= current {
            return "Valitse aiempi päivä kuin nykyinen alku (\(APIDate.displayDay(current)))."
        }
        if let limitDays, let floor = earliest(limitDays: limitDays, today: today), from < floor {
            return "Pankki antaa tapahtumat enintään \(limitText(limitDays)) ajalta."
        }
        return nil
    }

    /// The window can be widened only on a working connection that reports it and does not
    /// already fetch everything.
    public static func canFetchOlder(_ connection: BankConnection) -> Bool {
        connection.reportsHistory && connection.status == "active" && connection.historyFrom != nil
    }
}
