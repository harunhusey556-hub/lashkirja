import Foundation

/// The review queue of Kuitit, one group at a time (web `kuitit/page.tsx` splits it by where the
/// document came from; a bank-drafted sale and an emailed receipt need different wording), plus
/// the rejected receipts, which stay reachable and restorable (F38).
public enum ReviewGroup: String, CaseIterable, Identifiable, Sendable {
    case email, bankSales, other, rejected

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .email: "Sähköposti"
        case .bankSales: "Myynnit pankista"
        case .other: "Muut"
        case .rejected: "Hylätyt"
        }
    }

    public var description: String {
        switch self {
        case .email: "Sähköpostista tuodut kuitit odottavat hyväksyntää ennen kirjanpitoon siirtymistä."
        case .bankSales: "Tiliotteen tuloista tehdyt myyntikirjaukset odottavat hyväksyntää."
        case .other: "Odottavat hyväksyntää ennen kirjanpitoon siirtymistä."
        case .rejected: "Eivät ole kirjanpidossa. Voit palauttaa kuitin tarkastettavaksi."
        }
    }

    /// The pending group of a receipt (never `.rejected`).
    public static func of(_ receipt: Receipt) -> ReviewGroup {
        switch receipt.source {
        case "email_sync": .email
        case "auto_income": .bankSales
        default: .other
        }
    }
}

/// One approval rule for every path (web `receipt-approval.ts`): a receipt without an amount or a
/// vendor is completed first, so it gets "Täydennä", never a one-tap "Hyväksy".
public enum ReceiptApproval {
    public enum Gap: Equatable, Sendable { case amount, vendor }

    public static func gaps(_ receipt: Receipt) -> [Gap] {
        var gaps: [Gap] = []
        if receipt.totalAmount == nil { gaps.append(.amount) }
        if (receipt.vendor ?? "").trimmingCharacters(in: .whitespaces).isEmpty { gaps.append(.vendor) }
        return gaps
    }

    public static func isReady(_ receipt: Receipt) -> Bool { gaps(receipt).isEmpty }

    public static func gapText(_ gaps: [Gap]) -> String {
        switch (gaps.contains(.amount), gaps.contains(.vendor)) {
        case (true, true): "Lisää summa ja myyjä"
        case (true, false): "Lisää summa"
        case (false, true): "Lisää myyjä"
        case (false, false): ""
        }
    }
}

public enum ReviewQueue {
    public static func split(_ pending: [Receipt]) -> [ReviewGroup: [Receipt]] {
        Dictionary(grouping: pending, by: ReviewGroup.of)
    }

    /// The groups that have rows, in a fixed order.
    public static func groups(pending: [Receipt], rejectedCount: Int) -> [ReviewGroup] {
        let present = Set(pending.map(ReviewGroup.of))
        return ReviewGroup.allCases.filter { $0 == .rejected ? rejectedCount > 0 : present.contains($0) }
    }

    public static func ready(_ receipts: [Receipt]) -> [Receipt] { receipts.filter(ReceiptApproval.isReady) }

    /// "Hyväksy kaikki (N)" when every row is ready, "Hyväksy valmiit (N)" otherwise; nil when none is.
    public static func approveTitle(_ receipts: [Receipt]) -> String? {
        let ready = ready(receipts).count
        guard ready > 0 else { return nil }
        return ready == receipts.count ? "Hyväksy kaikki (\(ready))" : "Hyväksy valmiit (\(ready))"
    }

    public static func incompleteNote(_ receipts: [Receipt]) -> String? {
        let count = receipts.count - ready(receipts).count
        guard count > 0 else { return nil }
        return count == 1 ? "1 kuitti vaatii täydennyksen." : "\(count) kuittia vaatii täydennyksen."
    }

    /// The bulk approval's answer names the refusal (web `approvalFailureText`).
    public static func approvalOutcome(approved: Int, failures: [String]) -> String {
        guard !failures.isEmpty else { return "Hyväksyttiin \(approved)." }
        var reasons: [String] = []
        for reason in failures where !reason.isEmpty && !reasons.contains(reason) { reasons.append(reason) }
        let head = failures.count == 1 ? "Yhtä kuittia" : "\(failures.count) kuittia"
        let refused = "\(head) ei voitu hyväksyä" + (reasons.isEmpty ? "." : ": " + reasons.joined(separator: " "))
        return approved > 0 ? "Hyväksyttiin \(approved). \(refused)" : refused
    }
}

/// `PATCH /api/receipts/:id/review`.
public struct ReviewStatusBody: Encodable, Sendable, Equatable {
    public let reviewStatus: String
    public init(reviewStatus: String) { self.reviewStatus = reviewStatus }
    /// "Palauta": a rejected receipt goes back to the review queue.
    public static let restore = ReviewStatusBody(reviewStatus: "pending")
}
