import Foundation

extension SalesVat {
    private static let general = Decimal(string: "25.5")!
    private static let reducedNew = Decimal(string: "13.5")!

    /// The rates valid on an invoice dated `issueDate` (web `vatRatesForDate`): 14 % until
    /// 31.12.2025, 13,5 % from 1.1.2026.
    public static func rates(forDate issueDate: String) -> [Decimal] {
        issueDate >= reducedRateChangeDate ? [general, reducedNew, 10, 0] : [general, 14, 10, 0]
    }

    /// What the ALV picker offers (web `vatRateOptions`): the rates for the date, plus the line's
    /// own rate when it is not one of them, so the picker shows the truth and the note says what to pick.
    public static func rateOptions(current: Decimal, issueDate: String) -> [Decimal] {
        let offered = rates(forDate: issueDate)
        return offered.contains(current) ? offered : offered + [current]
    }

    /// Why a rate cannot be used on this date (the server's wording), or nil when it can.
    public static func dateNote(_ rate: Decimal, issueDate: String) -> String? {
        if rates(forDate: issueDate).contains(rate) { return nil }
        if rate == 14 && issueDate >= reducedRateChangeDate {
            return "ALV 14 % ei ole enää käytössä 1.1.2026 alkaen. Käytä ALV 13,5 %."
        }
        return "ALV \(label(rate)) % ei ole käytössä laskun päivälle."
    }

    /// "13,5": the Finnish comma.
    public static func label(_ rate: Decimal) -> String {
        NSDecimalNumber(decimal: rate).stringValue.replacingOccurrences(of: ".", with: ",")
    }
}

extension Array where Element == InvoiceDraft.Line {
    /// A date moved into 2026 carries old 14 % lines over to 13,5 % (web `adjustVatRateForDate`).
    public mutating func adjustVatRates(issueDate: String) {
        for index in indices {
            let adjusted = SalesVat.adjustedRate(self[index].vatRate, issueDate: issueDate)
            if adjusted != self[index].vatRate { self[index].vatRate = adjusted }
        }
    }
}

/// The unsaved new invoice, kept in memory per signed-in owner so closing the form by accident
/// does not lose it; opening "Uusi lasku" again restores it. Cleared when the invoice is created
/// or the owner discards it. Never written to disk.
@MainActor
public final class SalesDraftStore {
    public static let shared = SalesDraftStore()

    public struct Entry: Equatable, Sendable {
        public let draft: InvoiceDraft
        public let savedAt: Date
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    public func keep(_ draft: InvoiceDraft, owner: String, now: Date = Date()) {
        entries[owner] = Entry(draft: draft, savedAt: now)
    }

    public func entry(owner: String) -> Entry? { entries[owner] }

    public func clear(owner: String) { entries[owner] = nil }

    /// Only a form the owner actually changed is worth keeping.
    public nonisolated static func worthKeeping(_ draft: InvoiceDraft, baseline: InvoiceDraft) -> Bool {
        draft != baseline
    }
}
