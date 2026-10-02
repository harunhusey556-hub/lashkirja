import Foundation

/// `GET/PUT /api/period-lock`.
public struct PeriodLockState: Decodable, Sendable, Equatable {
    public let lockedThrough: String?
}

/// `PUT /api/period-lock`. `month: null` opens all; `expectedLockedThrough` is
/// the lock this screen showed (null included), so a lock changed elsewhere is refused.
public struct PeriodLockBody: Encodable, Sendable {
    public let month: String?
    public let reopen: Bool
    public let expectedLockedThrough: String?

    public init(month: String?, reopen: Bool, expectedLockedThrough: String?) {
        self.month = month
        self.reopen = reopen
        self.expectedLockedThrough = expectedLockedThrough
    }

    enum CodingKeys: String, CodingKey { case month, reopen, expectedLockedThrough }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(month, forKey: .month)
        if reopen { try c.encode(true, forKey: .reopen) }
        try c.encode(expectedLockedThrough, forKey: .expectedLockedThrough)
    }
}

/// `GET /api/period-lock/precheck?month=`: what is still open before locking.
public struct PeriodPrecheck: Decodable, Sendable {
    public struct Item: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let title: String
        public let detail: String
        public let href: String
    }
    public let month: String
    public let missingDocuments: [Item]
    public let unmatchedTransactions: [Item]
    public let draftInvoices: [Item]
    public var count: Int { missingDocuments.count + unmatchedTransactions.count + draftInvoices.count }
}

/// The lock card's rules and words (lib/period-lock-copy.ts, BooksLockCard).
public enum PeriodLock {
    public enum Change: Equatable, Sendable { case none, lock, reopen }

    public static func change(current: String?, selected: String?) -> Change {
        if current == selected { return .none }
        if let current, selected == nil || selected! < current { return .reopen }
        return .lock
    }

    private static let names = ["tammikuu", "helmikuu", "maaliskuu", "huhtikuu", "toukokuu", "kesäkuu",
                                "heinäkuu", "elokuu", "syyskuu", "lokakuu", "marraskuu", "joulukuu"]

    /// "maaliskuu 2026", lower case as in a sentence.
    public static func formatMonth(_ month: String) -> String {
        let bits = month.split(separator: "-")
        guard bits.count == 2, bits[0].count == 4, let m = Int(bits[1]), (1...12).contains(m) else { return month }
        return "\(names[m - 1]) \(bits[0])"
    }

    public static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    public static func monthAfter(_ month: String) -> String { MonthKey.shift(month, by: 1) }

    /// The months that become editable when the lock moves back from `lockedThrough` to `selected`.
    public static func reopenedRange(selected: String?, lockedThrough: String) -> String {
        guard let selected else { return "kaikki kuukaudet \(formatMonth(lockedThrough)) asti" }
        let from = monthAfter(selected)
        if from == lockedThrough { return formatMonth(lockedThrough) }
        if from.prefix(4) == lockedThrough.prefix(4) {
            let first = formatMonth(from).split(separator: " ").first.map(String.init) ?? from
            return "\(first)–\(formatMonth(lockedThrough))"
        }
        return "\(formatMonth(from))–\(formatMonth(lockedThrough))"
    }

    /// The last 24 finished months, newest first; an older lock month is kept listed.
    public static func options(current: String, lockedThrough: String?) -> [String] {
        var options = (1...24).map { MonthKey.shift(current, by: -$0) }
        if let lockedThrough, !options.contains(lockedThrough) {
            options.append(lockedThrough)
            options.sort(by: >)
        }
        return options
    }

    public struct Confirmation: Equatable, Sendable {
        public let title: String
        public let message: String
        public let action: String
        public let destructive: Bool
    }

    public static func confirmation(month: String?, reopen: Bool, range: String?) -> Confirmation {
        if let range, let month, reopen {
            return Confirmation(
                title: "Avataanko \(range)?",
                message: "Nämä kaudet muuttuvat taas muokattaviksi: \(range). Kuitteja, tiliotteita, laskuja ja maksuja voi silloin lisätä, muuttaa ja poistaa. Jos jokin niistä on jo ilmoitettu, avaa ne vain korjausta varten. Kirjanpito pysyy suljettuna \(formatMonth(month)) asti.",
                action: "Avaa kaudet", destructive: true)
        }
        if let month {
            return Confirmation(
                title: "Lukitaanko kaudet \(formatMonth(month)) asti?",
                message: "\(capitalized(formatMonth(month))) ja sitä vanhemmat kaudet muuttuvat vain luettaviksi: kuitteja, tiliotteita, laskuja ja maksuja ei voi lisätä, muuttaa eikä poistaa. Voit avata ne myöhemmin.",
                action: reopen ? "Avaa kaudet" : "Lukitse", destructive: reopen)
        }
        return Confirmation(
            title: "Avataanko kirjanpito uudelleen?",
            message: "Nämä kaudet muuttuvat taas muokattaviksi: \(range ?? "kaikki kaudet"). Tee tämä vain, jos jokin ilmoitettu kausi pitää korjata.",
            action: "Avaa kaudet", destructive: true)
    }

    public static func toast(previous: String?, now: String?, reopen: Bool) -> String {
        if reopen, let previous, let now { return "\(capitalized(reopenedRange(selected: now, lockedThrough: previous))) avattiin." }
        if let now { return "Kirjanpito lukittu \(formatMonth(now)) asti." }
        return "Kirjanpito avattiin."
    }
}
