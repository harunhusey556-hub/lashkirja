import Foundation

/// The return Koti's status card names (web `useVatDue`): its `/api/alv` key, label and due date,
/// from the one deadline rule in `VatDue`.
public struct KotiVatDue: Equatable, Sendable {
    /// "2026-08", "2026-Q3" or "2026".
    public let key: String
    /// "Elokuu 2026", "Q3/2026", "2026".
    public let label: String
    public let dueIso: String

    public init?(key: String) {
        guard let due = VatDue.deadline(key) else { return nil }
        self.key = key
        label = VatDue.label(key)
        dueIso = due
    }

    public var periodYear: Int { Int(key.prefix(4)) ?? 0 }

    /// The period's last month: the ALV screen opens on the period that month falls in.
    public var lastMonth: String {
        switch VatKind(key: key) {
        case .month: return key
        case .quarter: return String(format: "%04d-%02d", periodYear, (Int(key.suffix(1)) ?? 4) * 3)
        case .year: return "\(key)-12"
        }
    }
}

/// What `GET /api/alv?period=…` answers that the deadline row needs (web `useVatDue`).
public struct VatDueFigures: Decodable, Sendable, Equatable {
    /// Field 308, unsigned; `isRefund` tells the direction.
    public let amount: Decimal
    public let isRefund: Bool
    public let filedAt: String?
    public let paidAt: String?
    /// Field 308 as filed, signed (negative = refund).
    public let filedAmount: Decimal?
    /// Pending receipts dated in the period: not in the figure yet.
    public let pendingReceiptCount: Int

    private enum CodingKeys: String, CodingKey { case field308, filing, pendingReceiptCount }
    private struct Field: Decodable {
        let amount: Decimal
        let isRefund: Bool
        enum CodingKeys: String, CodingKey { case amount, isRefund }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            amount = try c.decodeMoney(.amount)
            isRefund = try c.decodeIfPresent(Bool.self, forKey: .isRefund) ?? false
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let field = try c.decode(Field.self, forKey: .field308)
        amount = field.amount
        isRefund = field.isRefund
        let filing = try c.decodeIfPresent(AlvReport.Filing.self, forKey: .filing)
        filedAt = filing?.filedAt
        paidAt = filing?.paidAt
        filedAmount = filing?.filedAmount
        pendingReceiptCount = try c.decodeIfPresent(Int.self, forKey: .pendingReceiptCount) ?? 0
    }

    /// The filing step as the month close reads it: state, nothing to pay, changed since filing.
    public var vat: PeriodClose.Vat {
        PeriodClose.vat(filedAt: filedAt, paidAt: paidAt, filedAmount: filedAmount, amount: amount, isRefund: isRefund)
    }
}
