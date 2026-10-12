import Foundation

/// The "Valitse" mode of a list: which rows are picked for a bulk action. Only rows on screen
/// can be picked or acted on (web BOOKS-12): a filter, a search or a reload drops the others.
public struct BulkSelection: Sendable, Equatable {
    public private(set) var isActive = false
    public private(set) var ids: Set<String> = []

    public init() {}

    public var count: Int { ids.count }
    public var isEmpty: Bool { ids.isEmpty }
    public func contains(_ id: String) -> Bool { ids.contains(id) }

    public mutating func begin() {
        isActive = true
        ids = []
    }

    public mutating func end() {
        isActive = false
        ids = []
    }

    public mutating func toggle(_ id: String) {
        guard isActive else { return }
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
    }

    public func allSelected(_ visible: [String]) -> Bool {
        !visible.isEmpty && visible.allSatisfy(ids.contains)
    }

    /// "Valitse kaikki" / "Poista valinnat" over the rows on screen.
    public mutating func toggleAll(_ visible: [String]) {
        guard isActive else { return }
        if allSelected(visible) { ids.subtract(visible) } else { ids.formUnion(visible) }
    }

    public mutating func keepVisible(_ visible: [String]) {
        ids.formIntersection(visible)
    }

    /// After an action: what failed stays picked so it can be tried again; with nothing left the
    /// mode ends.
    public mutating func finish(failed: [String]) {
        ids = Set(failed)
        if ids.isEmpty { isActive = false }
    }

    /// The picked ids in the order the rows are shown.
    public func ordered(_ visible: [String]) -> [String] { visible.filter(ids.contains) }
}

/// The batch routes' limits and the split into calls that fit them.
public enum BulkBatch {
    /// `POST /api/receipts/batch-approve`.
    public static let approveLimit = 200
    /// `POST /api/receipts/batch-delete`.
    public static let deleteLimit = 50
    /// `POST /api/matching/confirm-all` with `pairs`.
    public static let pairsLimit = 500

    public static func chunks<T>(_ items: [T], size: Int) -> [[T]] {
        guard size > 0, !items.isEmpty else { return items.isEmpty ? [] : [items] }
        return stride(from: 0, to: items.count, by: size).map { Array(items[$0..<min($0 + size, items.count)]) }
    }

    /// "Poistettiin 3, epäonnistui 1." (web `batchOutcomeMessage`) with the first reason given.
    public static func outcome(_ verb: String, done: Int, failures: [String]) -> String {
        guard !failures.isEmpty else { return "\(verb) \(done)." }
        let reason = failures.first { !$0.isEmpty }
        return "\(verb) \(done), epäonnistui \(failures.count)" + (reason.map { ": \($0)" } ?? ".")
    }
}

/// `POST /api/receipts/batch-approve` and `/batch-delete`.
public struct ReceiptIdsBody: Encodable, Sendable, Equatable {
    public let receiptIds: [String]
    public init(receiptIds: [String]) { self.receiptIds = receiptIds }
}

/// Kuitit's bulk bar, the web `BulkBar` exactly: Peruuta, Hyväksy (only the ready pending ones)
/// and Poista.
public enum ReceiptBulk {
    /// Of the selection only pending receipts without a gap can be approved (web F15).
    public static func approvable(_ selected: [Receipt]) -> [Receipt] {
        selected.filter { $0.reviewStatus == "pending" && ReceiptApproval.isReady($0) }
    }

    /// Web `bulkApproveLabel`.
    public static func approveLabel(ready: Int, notReady: Int) -> String {
        notReady == 0 ? "Hyväksy (\(ready))" : "Hyväksy valmiit (\(ready))"
    }

    public static func deleteTitle(_ count: Int) -> String {
        count == 1 ? "Poistetaanko kuitti?" : "Poistetaanko \(count) kuittia?"
    }
}

/// `POST /api/matching/confirm-all` with exactly the pairs on screen: only these rows link.
public struct BulkMatchPairsBody: Encodable, Sendable, Equatable {
    public struct Pair: Encodable, Sendable, Equatable {
        public let transactionId: String
        public let receiptId: String
        public init(transactionId: String, receiptId: String) {
            self.transactionId = transactionId
            self.receiptId = receiptId
        }
    }
    public let pairs: [Pair]
    public init(pairs: [Pair]) { self.pairs = pairs }
}

/// The answer to the pairs: how many linked, and how many were skipped (changed meanwhile).
public struct BulkMatchConfirmResult: Decodable, Sendable {
    public let confirmed: Int
    public let skipped: Int
    public let alreadyConfirmed: Int

    enum CodingKeys: String, CodingKey { case confirmed, skipped, alreadyConfirmed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        confirmed = (try? c.decodeIfPresent(Int.self, forKey: .confirmed)) ?? 0
        skipped = (try? c.decodeIfPresent(Int.self, forKey: .skipped)) ?? 0
        alreadyConfirmed = (try? c.decodeIfPresent(Int.self, forKey: .alreadyConfirmed)) ?? 0
    }
}

/// `POST /api/matching/reject` for one row's suggestion.
public struct BulkRejectBody: Encodable, Sendable, Equatable {
    public let transactionId: String
    public let receiptId: String
    public init(transactionId: String, receiptId: String) {
        self.transactionId = transactionId
        self.receiptId = receiptId
    }
}

/// `POST /api/matching/ignore`: the row needs no receipt ("Ei vaadi kuittia").
public struct BulkIgnoreBody: Encodable, Sendable, Equatable {
    public let transactionId: String
    public let ignored: Bool
    public init(transactionId: String, ignored: Bool = true) {
        self.transactionId = transactionId
        self.ignored = ignored
    }
}

/// Pankkitapahtumat's bulk bar: accept the suggestions, reject them, or mark rows as needing no
/// receipt. Each action takes only the picked rows it applies to.
public enum BankBulk {
    /// Rows with a receipt suggestion ready to confirm.
    public static func pairs(_ rows: [BankTransaction]) -> [BulkMatchPairsBody.Pair] {
        rows.compactMap { row in
            guard BankFeed.state(of: row) == .suggested, let receiptId = row.suggestedReceiptId else { return nil }
            return BulkMatchPairsBody.Pair(transactionId: row.id, receiptId: receiptId)
        }
    }

    public static func rejections(_ rows: [BankTransaction]) -> [BulkRejectBody] {
        pairs(rows).map { BulkRejectBody(transactionId: $0.transactionId, receiptId: $0.receiptId) }
    }

    /// Rows the server lets be marked: not linked, not paying an invoice, not marked already.
    public static func ignorable(_ rows: [BankTransaction]) -> [BankTransaction] {
        rows.filter { row in
            row.matchStatus != "confirmed" && row.matchStatus != "ignored" && row.receiptId == nil
                && row.paidInvoice == nil && row.paidPurchase == nil
        }
    }

    public static func acceptLabel(_ count: Int) -> String { "Hyväksy ehdotukset (\(count))" }
    public static func rejectLabel(_ count: Int) -> String { "Hylkää ehdotukset (\(count))" }
    public static func ignoreLabel(_ count: Int) -> String { "Ei vaadi kuittia (\(count))" }

    public static func rejectTitle(_ count: Int) -> String {
        count == 1 ? "Hylätäänkö kuittiehdotus?" : "Hylätäänkö \(count) kuittiehdotusta?"
    }

    public static func ignoreTitle(_ count: Int) -> String {
        count == 1 ? "Merkitäänkö tapahtuma: ei vaadi kuittia?" : "Merkitäänkö \(count) tapahtumaa: ei vaadi kuittia?"
    }
}

/// Ostolaskut's bulk bar: mark paid, delete.
public enum PurchaseBulk {
    public static func payable(_ invoices: [PurchaseInvoice]) -> [PurchaseInvoice] { invoices.filter(\.canMarkPaid) }
    public static func deletable(_ invoices: [PurchaseInvoice]) -> [PurchaseInvoice] { invoices.filter(\.canDelete) }

    /// Some of them lack payments for the full sum: the server wants a written reason for those.
    public static func needsReason(_ invoices: [PurchaseInvoice]) -> Bool { payable(invoices).contains(where: \.markPaidNeedsReason) }

    public static func markPaidLabel(_ count: Int) -> String { "Merkitse maksetuksi (\(count))" }
    public static func deleteLabel(_ count: Int) -> String { "Poista (\(count))" }

    public static func markPaidTitle(_ count: Int) -> String {
        count == 1 ? "Merkitäänkö ostolasku maksetuksi?" : "Merkitäänkö \(count) ostolaskua maksetuksi?"
    }

    public static func deleteTitle(_ count: Int) -> String {
        count == 1 ? "Poistetaanko ostolasku?" : "Poistetaanko \(count) ostolaskua?"
    }
}
