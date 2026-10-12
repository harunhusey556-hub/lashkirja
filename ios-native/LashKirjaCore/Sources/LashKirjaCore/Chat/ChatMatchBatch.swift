import Foundation

/// An element that failed to decode is skipped instead of failing the whole list.
private struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// `proposal.type == "match_batch"` (app/src/lib/chat-match-batch.ts): every pairing a match review
/// proposed, in one reply. Confident pairs are accepted together; ambiguous rows (two receipts fit one
/// bank row) need a per-row choice and are never part of the batch. Amounts are cents.
public struct ChatMatchBatch: Decodable, Sendable, Hashable {
    /// A pair the primary button accepts (`pairs[]`, ids only).
    public struct Pair: Codable, Sendable, Hashable {
        public let transactionId: String
        public let receiptId: String

        public init(transactionId: String, receiptId: String) {
            self.transactionId = transactionId
            self.receiptId = receiptId
        }
    }

    public struct Option: Sendable, Hashable {
        public let receiptId: String
        public let label: String
        public let reasons: [String]

        public init(receiptId: String, label: String, reasons: [String] = []) {
            self.receiptId = receiptId
            self.label = label
            self.reasons = reasons
        }
    }

    public struct Card: Decodable, Sendable, Hashable, Identifiable {
        public let transactionId: String
        /// Nil on an ambiguous row: the owner picks one of `options`.
        public let receiptId: String?
        public let counterparty: String?
        public let amountCents: Int
        /// "YYYY-MM-DD".
        public let date: String?
        public let receiptLabel: String?
        public let reasons: [String]
        /// 0-1, nil on an ambiguous row.
        public let confidence: Double?
        public let ambiguous: Bool
        public let options: [Option]

        public var id: String { "\(transactionId):\(receiptId ?? "?")" }

        public init(transactionId: String, receiptId: String? = nil, counterparty: String? = nil, amountCents: Int, date: String? = nil, receiptLabel: String? = nil, reasons: [String] = [], confidence: Double? = nil, ambiguous: Bool = false, options: [Option] = []) {
            self.transactionId = transactionId
            self.receiptId = receiptId
            self.counterparty = counterparty
            self.amountCents = amountCents
            self.date = date
            self.receiptLabel = receiptLabel
            self.reasons = reasons
            self.confidence = confidence
            self.ambiguous = ambiguous
            self.options = options
        }

        private enum CodingKeys: String, CodingKey {
            case transactionId, receiptId, bankRow, receipt, reasons, confidence, ambiguous, options
        }
        private enum BankKeys: String, CodingKey { case date, amountCents, counterparty }
        private enum ReceiptKeys: String, CodingKey { case label }
        private enum OptionKeys: String, CodingKey { case receiptId, label, reasons }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            transactionId = try c.decode(String.self, forKey: .transactionId)
            receiptId = try? c.decodeIfPresent(String.self, forKey: .receiptId)
            let bank = try? c.nestedContainer(keyedBy: BankKeys.self, forKey: .bankRow)
            counterparty = bank.flatMap { try? $0.decodeIfPresent(String.self, forKey: .counterparty) }
            // Cents are whole numbers; a fractional one (never sent) is rounded rather than dropped.
            var cents = 0
            if let bank {
                if let whole = try? bank.decodeIfPresent(Int.self, forKey: .amountCents) {
                    cents = whole
                } else if let fractional = try? bank.decodeIfPresent(Double.self, forKey: .amountCents) {
                    cents = Int(fractional.rounded())
                }
            }
            amountCents = cents
            date = bank.flatMap { try? $0.decodeIfPresent(String.self, forKey: .date) }
            let receipt = try? c.nestedContainer(keyedBy: ReceiptKeys.self, forKey: .receipt)
            receiptLabel = receipt.flatMap { try? $0.decodeIfPresent(String.self, forKey: .label) }
            reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
            confidence = try? c.decodeIfPresent(Double.self, forKey: .confidence)
            ambiguous = (try? c.decodeIfPresent(Bool.self, forKey: .ambiguous)) ?? false
            options = ((try? c.decodeIfPresent([LossyElement<OptionBox>].self, forKey: .options)) ?? [])
                .compactMap { $0.value?.option }
        }

        /// One `options[]` element.
        private struct OptionBox: Decodable {
            let option: Option
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: OptionKeys.self)
                option = Option(
                    receiptId: try c.decode(String.self, forKey: .receiptId),
                    label: (try? c.decodeIfPresent(String.self, forKey: .label)) ?? "",
                    reasons: (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
                )
            }
        }
    }

    public let cards: [Card]
    /// Confident pairs the primary button accepts (all of them, not only the listed cards).
    public let confident: Int
    public let ambiguous: Int
    /// The list shows only part of the proposals.
    public let truncated: Bool
    public let pairs: [Pair]

    public init(cards: [Card], confident: Int, ambiguous: Int, truncated: Bool = false, pairs: [Pair]) {
        self.cards = cards
        self.confident = confident
        self.ambiguous = ambiguous
        self.truncated = truncated
        self.pairs = pairs
    }

    private enum CodingKeys: String, CodingKey { case cards, confident, ambiguous, truncated, pairs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let cards = ((try? c.decodeIfPresent([LossyElement<Card>].self, forKey: .cards)) ?? []).compactMap(\.value)
        let pairs = ((try? c.decodeIfPresent([LossyElement<Pair>].self, forKey: .pairs)) ?? []).compactMap(\.value)
        self.cards = cards
        self.pairs = pairs
        confident = (try? c.decodeIfPresent(Int.self, forKey: .confident)) ?? pairs.count
        ambiguous = (try? c.decodeIfPresent(Int.self, forKey: .ambiguous)) ?? cards.filter { $0.ambiguous }.count
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

/// `POST /api/matching/confirm-all` body for exact pairs (the schema is strict: only `pairs`).
public struct ChatMatchPairsRequest: Encodable, Sendable, Equatable {
    public let pairs: [ChatMatchBatch.Pair]

    public init(pairs: [ChatMatchBatch.Pair]) { self.pairs = pairs }
}

/// `POST /api/matching/confirm-all` answer for `pairs`: `skipped` pairs are named in `skippedPairs`.
public struct ChatMatchConfirmResult: Decodable, Sendable, Equatable {
    public let confirmed: Int
    public let skipped: Int
    public let alreadyConfirmed: Int
    public let skippedTransactionIds: Set<String>

    public init(confirmed: Int = 0, skipped: Int = 0, alreadyConfirmed: Int = 0, skippedTransactionIds: Set<String> = []) {
        self.confirmed = confirmed
        self.skipped = skipped
        self.alreadyConfirmed = alreadyConfirmed
        self.skippedTransactionIds = skippedTransactionIds
    }

    private enum CodingKeys: String, CodingKey { case confirmed, skipped, alreadyConfirmed, skippedPairs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        confirmed = (try? c.decodeIfPresent(Int.self, forKey: .confirmed)) ?? 0
        skipped = (try? c.decodeIfPresent(Int.self, forKey: .skipped)) ?? 0
        alreadyConfirmed = (try? c.decodeIfPresent(Int.self, forKey: .alreadyConfirmed)) ?? 0
        let pairs = ((try? c.decodeIfPresent([LossyElement<ChatMatchBatch.Pair>].self, forKey: .skippedPairs)) ?? []).compactMap(\.value)
        skippedTransactionIds = Set(pairs.map(\.transactionId))
    }
}

/// What the owner has done on one batch card so far (kept by the chat model, as the web keeps it in
/// the card's state: reopening the history shows the card fresh, and the server settles repeats).
public struct ChatMatchBatchState: Sendable, Equatable {
    public enum Row: Sendable, Equatable {
        case confirmed, rejected, failed
    }

    /// What is on its way: the primary button, or one bank row. One request at a time per card.
    public enum Busy: Sendable, Equatable {
        case all
        case row(String)
    }

    public private(set) var rows: [String: Row] = [:]
    public private(set) var confirmed = 0
    public private(set) var skipped = 0
    public private(set) var alreadyConfirmed = 0
    public private(set) var hasResult = false

    public init() {}

    /// The confident pairs not yet decided: what "Hyväksy kaikki varmat" sends.
    public func pending(_ batch: ChatMatchBatch) -> [ChatMatchBatch.Pair] {
        batch.pairs.filter { rows[$0.transactionId] == nil }
    }

    /// After the primary button: skipped pairs read as failed, the rest as accepted; totals add up
    /// over repeated taps.
    public mutating func applyBulk(sent: [ChatMatchBatch.Pair], result: ChatMatchConfirmResult) {
        for pair in sent {
            rows[pair.transactionId] = result.skippedTransactionIds.contains(pair.transactionId) ? .failed : .confirmed
        }
        confirmed += result.confirmed
        skipped += result.skipped
        alreadyConfirmed += result.alreadyConfirmed
        hasResult = true
    }

    /// One row accepted with the same endpoint as the button; a skipped pair is a failure.
    public mutating func applyAccept(transactionId: String, result: ChatMatchConfirmResult) {
        rows[transactionId] = result.skipped > 0 ? .failed : .confirmed
    }

    public mutating func mark(_ transactionId: String, _ row: Row) {
        rows[transactionId] = row
    }

    /// "Hyväksytty 3 · epäonnistui 1 · aiemmin hyväksytty 2" after an accept-all; nil before.
    public var resultText: String? {
        guard hasResult else { return nil }
        var parts = ["Hyväksytty \(confirmed)", "epäonnistui \(skipped)"]
        if alreadyConfirmed > 0 { parts.append("aiemmin hyväksytty \(alreadyConfirmed)") }
        return parts.joined(separator: " · ")
    }
}

/// The batch card's Finnish copy, as the web's MatchBatchCard writes it.
public enum ChatMatchBatchText {
    public static let title = "Kohdistusehdotukset"
    public static let unknownCounterparty = "Tuntematon siirto"
    public static let ambiguousNote = "Epäselvä: kaksi yhtä hyvää kuittia, valitse itse."
    public static let acceptedLabel = "Hyväksytty"
    public static let rejectedLabel = "Hylätty"
    public static let failedLabel = "Ei onnistunut: ehdotus ei ole enää voimassa"
    public static let bulkBusyLabel = "Yhdistetään…"

    /// "5 kohdistusehdotusta · 3 varmaa · 2 epäselvää" (singular where Finnish needs it).
    public static func header(confident: Int, ambiguous: Int) -> String {
        let total = confident + ambiguous
        return [
            "\(total) \(total == 1 ? "kohdistusehdotus" : "kohdistusehdotusta")",
            "\(confident) \(confident == 1 ? "varma" : "varmaa")",
            "\(ambiguous) \(ambiguous == 1 ? "epäselvä" : "epäselvää")",
        ].joined(separator: " · ")
    }

    public static func header(_ batch: ChatMatchBatch) -> String {
        header(confident: batch.confident, ambiguous: batch.ambiguous)
    }

    public static func buttonLabel(pending: Int) -> String {
        "Hyväksy kaikki varmat (\(pending))"
    }

    public static func truncatedNote(confident: Int) -> String {
        "Lista näyttää vain osan ehdotuksista. Painike hyväksyy kaikki \(confident) varmaa; loput löytyvät kysymällä uudelleen."
    }

    /// "Kauppa → Nordea": the receipt first, then the bank row's counterparty.
    public static func rowTitle(_ card: ChatMatchBatch.Card) -> String {
        let counterparty = nonEmpty(card.counterparty) ?? unknownCounterparty
        if card.ambiguous { return counterparty }
        return "\(nonEmpty(card.receiptLabel) ?? "Kuitti") → \(counterparty)"
    }

    /// "12,50 € · 1.10.2026 · 92 %": the bank row's amount and day, then the confidence when known.
    public static func rowDetail(_ card: ChatMatchBatch.Card) -> String {
        var parts = [amount(card.amountCents)]
        if let date = card.date, !date.isEmpty { parts.append(APIDate.displayDay(date)) }
        if !card.ambiguous, let confidence = card.confidence, confidence.isFinite {
            parts.append("\(Int((confidence * 100).rounded()))\u{00A0}%")
        }
        return parts.joined(separator: " · ")
    }

    public static func reasonsLine(_ card: ChatMatchBatch.Card) -> String? {
        card.reasons.isEmpty ? nil : card.reasons.joined(separator: " · ")
    }

    /// The bank row's amount without a sign, as the web shows it.
    public static func amount(_ cents: Int) -> String {
        Money.format(Decimal(abs(cents)) / 100)
    }

    public static func rowStatusLabel(_ row: ChatMatchBatchState.Row) -> String {
        switch row {
        case .confirmed: acceptedLabel
        case .rejected: rejectedLabel
        case .failed: failedLabel
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return text
    }
}
