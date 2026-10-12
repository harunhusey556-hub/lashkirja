import Foundation
import Observation

/// The parts of the books the server marks apart in `GET /api/sync/version`.
public enum DataArea: String, CaseIterable, Sendable {
    case bank, receipts, invoices

    public static let all = Set(DataArea.allCases)
}

/// `GET /api/sync/version`: a cheap answer that changes whenever the books do (a bank sync, an
/// import, a saved or matched receipt, invoice or payment). Read leniently: a missing or
/// unexpected field is unknown, never a change and never a failed decode.
public struct SyncVersion: Decodable, Sendable, Equatable {
    public struct Account: Sendable, Equatable {
        public let id: String
        public let lastSyncAt: String?
        public let balanceCents: Int?

        public init(id: String, lastSyncAt: String? = nil, balanceCents: Int? = nil) {
            self.id = id
            self.lastSyncAt = lastSyncAt
            self.balanceCents = balanceCents
        }
    }

    /// A number on the server; kept as text so a string or a number both read.
    public internal(set) var dataVersion: String?
    /// Per account (the ledger account's id, else the bank consent's account id).
    public let accounts: [Account]
    public let bankChangedAt: String?
    public let receiptsChangedAt: String?
    public let invoicesChangedAt: String?

    public init(dataVersion: String? = nil, accounts: [Account] = [], bankChangedAt: String? = nil,
                receiptsChangedAt: String? = nil, invoicesChangedAt: String? = nil) {
        self.dataVersion = dataVersion
        self.accounts = accounts
        self.bankChangedAt = bankChangedAt
        self.receiptsChangedAt = receiptsChangedAt
        self.invoicesChangedAt = invoicesChangedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LenientKey.self)
        dataVersion = c.lenientString("dataVersion")
        let bank = try? c.nestedContainer(keyedBy: LenientKey.self, forKey: LenientKey("bank"))
        let rows: [LenientAccount] = (try? bank?.decode([LenientAccount].self, forKey: LenientKey("accounts"))) ?? []
        accounts = rows.compactMap { row in
            row.id.isEmpty ? nil : Account(id: row.id, lastSyncAt: row.lastSyncAt, balanceCents: row.balanceCents)
        }
        bankChangedAt = c.areaChange("bank")
        receiptsChangedAt = c.areaChange("receipts")
        invoicesChangedAt = c.areaChange("invoices")
    }

    /// What changes when something in `area` changed on the server; nil = not told.
    public func marker(_ area: DataArea) -> String? {
        switch area {
        case .bank:
            guard !accounts.isEmpty || bankChangedAt != nil else { return nil }
            let rows: [String] = accounts.sorted { $0.id < $1.id }.map { account in
                let cents = account.balanceCents.map { String($0) } ?? ""
                return "\(account.id)|\(account.lastSyncAt ?? "")|\(cents)"
            }
            return "\(bankChangedAt ?? "");\(rows.joined(separator: ","))"
        case .receipts: return receiptsChangedAt
        case .invoices: return invoicesChangedAt
        }
    }

    /// This answer with the fields it left out taken from `older`.
    func filling(_ older: SyncVersion) -> SyncVersion {
        SyncVersion(dataVersion: dataVersion ?? older.dataVersion,
                    accounts: accounts.isEmpty ? older.accounts : accounts,
                    bankChangedAt: bankChangedAt ?? older.bankChangedAt,
                    receiptsChangedAt: receiptsChangedAt ?? older.receiptsChangedAt,
                    invoicesChangedAt: invoicesChangedAt ?? older.invoicesChangedAt)
    }
}

/// The app's one record of how fresh what it shows is. `version` goes up whenever something the
/// screens show may have changed: a write the server accepted, a pull-to-refresh, coming back to
/// the app, or the server's `/api/sync/version` answering differently than before. Screens that
/// show money reload when it moves (`.task(id: version)` with a `ReloadGate`).
public struct DataVersionState: Sendable, Equatable {
    public private(set) var version = 0
    private var areaVersions: [DataArea: Int] = [:]
    /// The server's last answer, the baseline the next one is compared with.
    public private(set) var server: SyncVersion?

    public init() {}

    public func version(of area: DataArea) -> Int { areaVersions[area] ?? 0 }

    public mutating func bump(_ areas: Set<DataArea> = DataArea.all) {
        version += 1
        for area in areas { areaVersions[area, default: 0] += 1 }
    }

    /// Takes the server's answer and bumps the areas that changed since the previous one.
    /// The first answer is only the baseline (the screens loaded just now anyway). `absorb` takes
    /// it as the baseline without a bump: the app's own write already bumped for it.
    @discardableResult
    public mutating func apply(_ snapshot: SyncVersion, absorb: Bool = false) -> Set<DataArea> {
        // A field the answer left out keeps its previous value: unknown is not "reset".
        defer { server = server.map(snapshot.filling) ?? snapshot }
        guard let previous = server, !absorb else { return [] }
        let changed = Self.changes(from: previous, to: snapshot)
        if !changed.isEmpty { bump(changed) }
        return changed
    }

    /// The number a write's answer carried becomes the baseline (that write already bumped).
    public mutating func absorb(dataVersion: String?) {
        guard let dataVersion, !dataVersion.isEmpty else { return }
        if server == nil { server = SyncVersion(dataVersion: dataVersion) } else { server?.dataVersion = dataVersion }
    }

    /// Signed out: the next owner's server answers start a new baseline. `version` keeps going up
    /// so no screen's gate takes an old number for a fresh one.
    public mutating func forgetServer() { server = nil }

    static func changes(from old: SyncVersion, to new: SyncVersion) -> Set<DataArea> {
        let changed = DataArea.allCases.filter { area in
            guard let before = old.marker(area), let after = new.marker(area) else { return false }
            return before != after
        }
        if !changed.isEmpty { return Set(changed) }
        // The number moved but no area said which: everything may have changed.
        if let before = old.dataVersion, let after = new.dataVersion, before != after { return DataArea.all }
        return []
    }
}

/// Balances a bank sync just returned, shown at once in place of the older figures until the
/// next load of the accounts (which carries them itself) arrives.
public struct FreshBalances: Sendable, Equatable {
    public private(set) var byAccount: [String: Decimal] = [:]
    public private(set) var takenAt: Date?

    public init() {}

    public var isEmpty: Bool { byAccount.isEmpty }

    public mutating func take(_ balances: [String: Decimal], at now: Date = Date()) {
        guard !balances.isEmpty else { return }
        byAccount.merge(balances) { _, new in new }
        takenAt = now
    }

    /// A load that started after the balances arrived already shows them: they are let go. A load
    /// that started before the sync answered is older than them, so they stay.
    public mutating func settle(loadStartedAt: Date) {
        guard let takenAt, loadStartedAt >= takenAt else { return }
        self = FreshBalances()
    }

    public func balance(_ accountId: String, shown: Decimal?) -> Decimal? { byAccount[accountId] ?? shown }

    /// The total with each account's fresh balance in place of the shown one.
    public func total(_ shown: Decimal, lines: [(id: String, balance: Decimal?)]) -> Decimal {
        lines.reduce(shown) { total, line in
            guard let fresh = byAccount[line.id], let old = line.balance else { return total }
            return total + fresh - old
        }
    }
}

/// How often and how long the app asks `/api/sync/version`.
public enum VersionPolling {
    /// While the app is in the foreground.
    public static let interval: TimeInterval = 30
    /// A bank sync the server runs as a job: how long the app waits for it, and how often it asks.
    public static let syncWaitLimit: TimeInterval = 60
    public static let syncWaitStep: TimeInterval = 2
}

/// Waiting for a bank sync the server finishes in the background: done once an account's
/// `lastSyncAt` moves, given up after `VersionPolling.syncWaitLimit`.
public enum SyncWait {
    public enum Outcome: Sendable, Equatable { case fresh, waiting, timedOut }

    /// `accountIds` empty = any account counts. Without a `before` answer, a `lastSyncAt` at or
    /// after the start of the sync counts.
    public static func check(before: SyncVersion?, now snapshot: SyncVersion?, accountIds: Set<String> = [],
                             started: Date, at: Date, limit: TimeInterval = VersionPolling.syncWaitLimit) -> Outcome {
        if let snapshot, synced(before: before, after: snapshot, accountIds: accountIds, started: started) { return .fresh }
        return at.timeIntervalSince(started) >= limit ? .timedOut : .waiting
    }

    static func synced(before: SyncVersion?, after: SyncVersion, accountIds: Set<String>, started: Date) -> Bool {
        let relevant = after.accounts.filter { accountIds.isEmpty || accountIds.contains($0.id) }
        guard let before else {
            return relevant.contains { account in
                guard let at = account.lastSyncAt.flatMap(SyncWait.date) else { return false }
                return at >= started
            }
        }
        var old: [String: String] = [:]
        for account in before.accounts { if let at = account.lastSyncAt { old[account.id] = at } }
        return relevant.contains { account in
            guard let at = account.lastSyncAt else { return false }
            return at != old[account.id]
        }
    }

    static func date(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}

/// The observable home of `DataVersionState` (AppModel owns one). Screens read `version`, so a
/// change re-runs their `.task(id:)`.
@MainActor
@Observable
public final class DataVersionStore {
    public private(set) var state = DataVersionState()
    public private(set) var balances = FreshBalances()

    public init() {}

    public var version: Int { state.version }
    public var server: SyncVersion? { state.server }
    public func version(of area: DataArea) -> Int { state.version(of: area) }

    public func bump(_ areas: Set<DataArea> = DataArea.all) { state.bump(areas) }

    @discardableResult
    public func apply(_ snapshot: SyncVersion, absorb: Bool = false) -> Set<DataArea> {
        var next = state
        let moved = next.apply(snapshot, absorb: absorb)
        update(next)
        return moved
    }

    public func absorb(dataVersion: String?) {
        var next = state
        next.absorb(dataVersion: dataVersion)
        update(next)
    }

    /// Any write to `state` tells every observer, even an equal one; a poll answering the same
    /// as last time must not re-run every screen's `.task(id:)`.
    private func update(_ next: DataVersionState) {
        if next != state { state = next }
    }

    public func takeBalances(_ fresh: [String: Decimal], at now: Date = Date()) { balances.take(fresh, at: now) }
    public func settleBalances(loadStartedAt: Date) { balances.settle(loadStartedAt: loadStartedAt) }

    public func endSession() {
        state.forgetServer()
        balances = FreshBalances()
    }
}

// MARK: Lenient reading

struct LenientKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension KeyedDecodingContainer where Key == LenientKey {
    /// A string, or a number written as text; nil for anything else.
    func lenientString(_ key: String) -> String? {
        let k = LenientKey(key)
        if let text = try? decodeIfPresent(String.self, forKey: k) { return text }
        if let whole = try? decodeIfPresent(Int.self, forKey: k) { return String(whole) }
        if let number = try? decodeIfPresent(Double.self, forKey: k) { return String(describing: number) }
        return nil
    }

    func lenientInt(_ key: String) -> Int? {
        let k = LenientKey(key)
        if let whole = try? decodeIfPresent(Int.self, forKey: k) { return whole }
        if let number = try? decodeIfPresent(Double.self, forKey: k) { return Int(number.rounded()) }
        if let text = try? decodeIfPresent(String.self, forKey: k) { return Int(text) }
        return nil
    }

    /// `"receipts": {"lastChangeAt": "…"}` or `"receipts": "…"`.
    func areaChange(_ key: String) -> String? {
        if let nested = try? nestedContainer(keyedBy: LenientKey.self, forKey: LenientKey(key)) {
            return nested.lenientString("lastChangeAt") ?? nested.lenientString("lastChangedAt")
        }
        return lenientString(key)
    }
}

/// One account row; never throws, so one odd row cannot sink the whole answer.
private struct LenientAccount: Decodable {
    let id: String
    let lastSyncAt: String?
    let balanceCents: Int?

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: LenientKey.self) else {
            id = ""
            lastSyncAt = nil
            balanceCents = nil
            return
        }
        // W18 names an account by its ledger id, else by the bank consent's account id.
        id = c.lenientString("bankAccountId") ?? c.lenientString("connectedAccountId")
            ?? c.lenientString("id") ?? c.lenientString("accountId") ?? ""
        lastSyncAt = c.lenientString("lastSyncAt")
        balanceCents = c.lenientInt("balanceCents")
    }
}
