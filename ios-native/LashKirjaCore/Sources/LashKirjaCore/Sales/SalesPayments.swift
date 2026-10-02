import Foundation

/// Rules the payment sheet checks before it sends anything (`lib/payment-entry.ts`).
public enum PaymentEntryRules {
    /// Cents of slack, so 125,50 typed against 125,5000001 is not "over".
    private static let tolerance = Decimal(string: "0.004")!

    /// The server refuses a hand-keyed payment above the open balance; a payment
    /// that carries a bank row records what the bank received and is not capped.
    public static func overOpenMessage(amount: Decimal, open: Decimal, carriesBankRow: Bool) -> String? {
        if carriesBankRow || amount <= open + tolerance { return nil }
        return open > 0
            ? "Summa on suurempi kuin avoin saldo \(Money.format(open)). Kirjaa enintään avoin summa."
            : "Lasku on jo maksettu. Avoin saldo on \(Money.format(0))."
    }
}

/// The body of `POST /api/invoices/{id}/payments`.
public struct PaymentEntry: Encodable, Sendable {
    public let amount: Decimal
    public let paidDate: String
    public let transactionId: String?
    public let note: String?

    public init(amount: Decimal, paidDate: String, transactionId: String?, note: String?) {
        self.amount = amount
        self.paidDate = paidDate
        self.transactionId = transactionId
        self.note = note
    }

    enum CodingKeys: String, CodingKey { case amount, paidDate, transactionId, note }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(amount, forKey: .amount)
        try c.encode(paidDate, forKey: .paidDate)
        if let transactionId, !transactionId.isEmpty { try c.encode(transactionId, forKey: .transactionId) }
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { try c.encode(trimmed, forKey: .note) }
    }
}

/// An incoming bank row the payment being recorded most likely is
/// (`GET /api/invoices/{id}/payments/candidates`).
public struct PaymentCandidate: Decodable, Sendable, Hashable, Identifiable {
    public let transactionId: String
    public let date: String?
    public let counterparty: String?
    public let amount: Decimal
    public let hasReceipt: Bool

    public var id: String { transactionId }

    enum CodingKeys: String, CodingKey { case transactionId, date, counterparty, amount, hasReceipt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        transactionId = try c.decode(String.self, forKey: .transactionId)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        counterparty = try c.decodeIfPresent(String.self, forKey: .counterparty)
        amount = try c.decodeMoney(.amount)
        hasReceipt = try c.decodeIfPresent(Bool.self, forKey: .hasReceipt) ?? false
    }

    /// "Asiakas Oy · 125,50 € · 1.10.2026"
    public var summary: String {
        [counterparty, Money.format(amount), date.map(APIDate.displayDay)].compactMap { $0 }.joined(separator: " · ")
    }

    public var receiptNote: String? {
        hasReceipt ? "Tapahtumasta on jo tulokuitti; yhdistäminen estää tulon laskemisen kahdesti." : nil
    }
}

public struct PaymentCandidates: Decodable, Sendable {
    public let candidates: [PaymentCandidate]

    public static func query(amount: Decimal, paidDate: String) -> [String: String] {
        ["amount": NSDecimalNumber(decimal: amount).stringValue, "paidDate": paidDate]
    }
}

/// A hand-recorded payment that an income receipt from a bank row seems to count again.
public struct PaymentDuplicate: Decodable, Sendable, Hashable, Identifiable {
    public let receiptId: String
    public let receiptVendor: String?
    public let receiptDate: String?
    public let amountCents: Int
    public let transactionId: String
    public let paymentId: String
    public let paidDate: String

    public var id: String { "\(receiptId):\(paymentId)" }
    public var amount: Decimal { Decimal(amountCents) / 100 }

    public var summary: String {
        let vendor = receiptVendor.map { " \($0)" } ?? ""
        let date = receiptDate.map { " (\(APIDate.displayDay($0)))" } ?? ""
        return "Tulokuitti\(vendor) \(Money.format(amount))\(date) on kirjattu tiliotteen maksusta, joka näyttää samalta kuin tämä maksu \(APIDate.displayDay(paidDate)). Molemmat lasketaan nyt tuloiksi."
    }
}

/// The body of `POST /api/invoices/{id}/payments/link`.
public enum PaymentLinkRequest: Encodable, Sendable {
    /// The bank row is this payment: attach it (the receipt from it stops counting).
    case link(paymentId: String, transactionId: String)
    /// The two are separate incomes.
    case dismiss(paymentId: String, receiptId: String)

    enum CodingKeys: String, CodingKey { case action, paymentId, transactionId, receiptId }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .link(let paymentId, let transactionId):
            try c.encode("link", forKey: .action)
            try c.encode(paymentId, forKey: .paymentId)
            try c.encode(transactionId, forKey: .transactionId)
        case .dismiss(let paymentId, let receiptId):
            try c.encode("dismiss", forKey: .action)
            try c.encode(paymentId, forKey: .paymentId)
            try c.encode(receiptId, forKey: .receiptId)
        }
    }
}

// MARK: - Payment reminders

/// `GET /api/invoices/{id}/reminders`: what a reminder would demand now.
public struct ReminderPreview: Decodable, Sendable, Hashable {
    public struct Previous: Decodable, Sendable, Hashable, Identifiable {
        public let level: Int
        public let sentAt: String
        public let total: Decimal
        public var id: String { "\(level)-\(sentAt)" }

        enum CodingKeys: String, CodingKey { case level, sentAt, total }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            level = try c.decode(Int.self, forKey: .level)
            sentAt = try c.decode(String.self, forKey: .sentAt)
            total = try c.decodeMoney(.total)
        }
    }

    public let level: Int
    public let daysLate: Int
    public let open: Decimal
    public let interest: Decimal
    public let fee: Decimal
    public let total: Decimal
    public let dueDate: String
    public let recipient: String?
    public let previousReminders: [Previous]
    public let nextReminderAt: String?
    public let nextReminderNote: String?
    public let mailboxMissing: Bool?

    enum CodingKeys: String, CodingKey {
        case level, daysLate, open, interest, fee, total, dueDate, recipient, previousReminders, nextReminderAt, nextReminderNote, mailboxMissing
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decode(Int.self, forKey: .level)
        daysLate = try c.decode(Int.self, forKey: .daysLate)
        open = try c.decodeMoney(.open)
        interest = try c.decodeMoneyIfPresent(.interest) ?? 0
        fee = try c.decodeMoneyIfPresent(.fee) ?? 0
        total = try c.decodeMoney(.total)
        dueDate = try c.decode(String.self, forKey: .dueDate)
        recipient = try c.decodeIfPresent(String.self, forKey: .recipient)
        previousReminders = try c.decodeIfPresent([Previous].self, forKey: .previousReminders) ?? []
        nextReminderAt = try c.decodeIfPresent(String.self, forKey: .nextReminderAt)
        nextReminderNote = try c.decodeIfPresent(String.self, forKey: .nextReminderNote)
        mailboxMissing = try c.decodeIfPresent(Bool.self, forKey: .mailboxMissing)
    }

    /// Why a new reminder would be refused right now, or nil when it may go.
    public func waitNote(now: Date = Date()) -> String? {
        guard let at = nextReminderAt, let note = nextReminderNote, let date = Self.instant(at) else { return nil }
        return date > now ? note : nil
    }

    /// What stops the send button, in the order the web sheet checks it.
    public func blockedReason(now: Date = Date()) -> String? {
        if recipient == nil || recipient?.isEmpty == true { return "Asiakkaalla ei ole sähköpostiosoitetta." }
        if mailboxMissing == true { return "Sähköpostitiliä ei ole yhdistetty, joten muistutusta ei voi lähettää." }
        return waitNote(now: now)
    }

    static func instant(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

public struct ReminderPreviewResponse: Decodable, Sendable { public let reminder: ReminderPreview }

/// `POST /api/invoices/{id}/reminders`.
public struct ReminderSendResult: Decodable, Sendable {
    public struct Sent: Decodable, Sendable { public let id: String; public let level: Int }
    public let sentTo: String
    public let reminder: Sent

    public var message: String { "Maksumuistutus \(reminder.level) lähetettiin osoitteeseen \(sentTo)" }
}
