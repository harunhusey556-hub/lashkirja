import Foundation

/// One sure pair of "Kohdista varmat" (`GET/POST /api/matching/sure`, app/src/lib/sure-matches.ts):
/// the gate's certain pair (viite + exact amount) or one the matcher would post by itself.
public struct SureMatchPair: Decodable, Sendable, Hashable, Identifiable {
    public let transactionId: String
    public let receiptId: String
    public let vendor: String?
    /// The receipt's euro amount.
    public let amount: Decimal?
    public var id: String { transactionId }
}

/// What "Kohdista varmat (N)" would link now; nothing is written by asking.
public struct SureMatchList: Decodable, Sendable {
    public let count: Int
    public let pairs: [SureMatchPair]

    enum CodingKeys: String, CodingKey { case count, pairs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pairs = try c.decodeIfPresent([SureMatchPair].self, forKey: .pairs) ?? []
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? pairs.count
    }
}

/// The answer of linking: which pairs went, and the batch "Kumoa" takes back (nil when none went).
public struct SureMatchBatch: Decodable, Sendable {
    public let batchId: String?
    public let linked: [SureMatchPair]
    /// The run stopped before the end (its time ran out or a chunk failed); what it linked can still be undone.
    public let partial: Bool?
    /// Sure pairs it did not reach; the next tap links them.
    public let remaining: Int?

    public var stoppedEarly: Bool { partial == true }
}

/// The body of `POST /api/matching/sure/undo`.
public struct SureMatchUndo: Encodable, Sendable {
    public let batchId: String
    public init(batchId: String) { self.batchId = batchId }
}

public struct SureMatchUndone: Decodable, Sendable {
    public let restored: Int
}

public enum SureMatchText {
    /// The one action of "Ei kohdistettu" while sure pairs wait.
    public static func buttonTitle(_ count: Int) -> String { "Kohdista varmat (\(count))" }

    public static let explanation = "Varmoissa pareissa viite ja summa täsmäävät, tai summa, nimi ja päivä täsmäävät eikä muita vaihtoehtoja ole."

    /// The toast after linking, with "Kumoa".
    public static func linked(_ count: Int) -> String {
        count == 1 ? "1 kuitti kohdistettu." : "\(count) kuittia kohdistettu."
    }

    /// The toast after a run that stopped early, with "Kumoa" for what it linked.
    public static func linkedPartly(_ count: Int) -> String {
        "\(count) kohdistettu, loput seuraavalla kerralla."
    }

    public static func restored(_ count: Int) -> String {
        switch count {
        case 0: "Kohdistukset oli jo muutettu, mitään ei kumottu."
        case 1: "1 kohdistus kumottu."
        default: "\(count) kohdistusta kumottu."
        }
    }
}
