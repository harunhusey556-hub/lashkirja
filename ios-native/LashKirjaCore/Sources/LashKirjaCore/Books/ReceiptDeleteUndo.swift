import Foundation

/// A receipt the owner deleted waits here, off every list, while the toast offers "Kumoa" (owner
/// 2026-10-23, beta audit S6). The server is asked only when the toast ends, so an undo needs no
/// server route and no schema change.
public struct PendingReceiptDelete: Sendable, Equatable {
    /// How long "Kumoa" stays up, in seconds.
    public static let window: TimeInterval = 6

    /// The receipts of one delete. The token tells its timer from the timer of an earlier delete.
    public struct Batch: Sendable, Equatable {
        public let ids: [String]
        public let token: Int
    }

    public private(set) var waiting: Batch?
    private var issued = 0

    public init() {}

    public var isWaiting: Bool { waiting != nil }

    /// A delete takes the toast. One still waiting is handed back: it was not undone, so it goes to
    /// the server now.
    @discardableResult
    public mutating func begin(_ ids: [String]) -> Batch? {
        let earlier = waiting
        issued += 1
        waiting = Batch(ids: ids, token: issued)
        return earlier
    }

    /// "Kumoa": the ids come back and nothing is sent.
    @discardableResult
    public mutating func undo() -> [String] {
        let ids = waiting?.ids ?? []
        waiting = nil
        return ids
    }

    /// The batch to send, once. The window of `token` ended, or, without a token, the app is leaving
    /// the screen. The token of an earlier delete finds nothing: its timer must not send a newer one.
    public mutating func release(token: Int? = nil) -> Batch? {
        guard let batch = waiting, token == nil || token == batch.token else { return nil }
        waiting = nil
        return batch
    }
}

public enum ReceiptDeleteText {
    /// The toast over the tabs while the delete can be taken back.
    public static func toast(_ count: Int) -> String {
        count == 1 ? "Kuitti poistettu" : "\(count) kuittia poistettu"
    }
}

/// What the server did with a delete whose window ended: how many receipts went, and which it
/// refused (a closed month, no connection) with its reasons.
public struct ReceiptDeleteOutcome: Sendable, Equatable {
    public private(set) var deleted: Int
    public private(set) var refused: [String] = []
    private var reasons: [String] = []

    public init(deleted: Int = 0) { self.deleted = deleted }

    /// `POST /api/receipts/batch-delete` for `asked`. What the answer does not report as gone counts
    /// as refused: a row the server may still hold comes back rather than staying hidden.
    public mutating func add(_ result: BatchDeleteResult, asked: [String]) {
        let gone = Set(result.succeeded ?? [])
        deleted += asked.filter(gone.contains).count
        refused += asked.filter { !gone.contains($0) }
        reasons += (result.failed ?? []).compactMap(\.error).filter { !$0.isEmpty }
    }

    /// A call that failed as a whole (offline, a 4xx): none of `ids` went.
    public mutating func fail(_ ids: [String], reason: String) {
        refused += ids
        if !reason.isEmpty { reasons.append(reason) }
    }

    /// The failure toast: what did not go and, in the server's words, why. Nil when everything went.
    public var message: String? {
        guard !refused.isEmpty else { return nil }
        let because = reasons.first.map { ": \($0)" } ?? "."
        if deleted == 0 {
            return (refused.count == 1 ? "Kuittia ei poistettu" : "Kuitteja ei poistettu") + because
        }
        return "Poistettiin \(deleted) \(deleted == 1 ? "kuitti" : "kuittia"). \(refused.count) epäonnistui" + because
    }
}
