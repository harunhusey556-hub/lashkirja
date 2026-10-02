import Foundation

/// The part of the sales list a link opens (web `/laskut?month=…&customerId=…`): a month or a
/// whole year, one customer, or everything. The status chip is separate (`SalesFilter`).
public struct InvoiceScope: Hashable, Sendable {
    /// "YYYY-MM", "YYYY" or "" (any period).
    public let month: String
    public let customerId: String

    /// A period the server cannot read (a quarter, junk) is dropped, as the web's link builder does.
    public init(month: String = "", customerId: String = "") {
        self.month = Self.isPeriod(month) ? month : ""
        self.customerId = customerId
    }

    public var isEmpty: Bool { month.isEmpty && customerId.isEmpty }

    /// For `/api/invoices` and `/api/invoices/counts`: both are scoped alike, never by status.
    public var query: [String: String] {
        var query: [String: String] = [:]
        if !month.isEmpty { query["month"] = month }
        if !customerId.isEmpty { query["customerId"] = customerId }
        return query
    }

    /// What the scoped list is: "Syyskuu 2026", "Vuosi 2026", "Asiakkaan laskut"; nil when unscoped.
    public var title: String? {
        var parts: [String] = []
        if month.count == 7 { parts.append("\(MonthKey.name(month)) \(month.prefix(4))") }
        if month.count == 4 { parts.append("Vuosi \(month)") }
        if !customerId.isEmpty { parts.append("Asiakkaan laskut") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// `^\d{4}(-(0[1-9]|1[0-2]))?$`
    static func isPeriod(_ value: String) -> Bool {
        let digits: (Substring) -> Bool = { $0.allSatisfy { $0.isASCII && $0.isNumber } }
        let bits = value.split(separator: "-", omittingEmptySubsequences: false)
        guard let year = bits.first, year.count == 4, digits(year) else { return false }
        if bits.count == 1 { return true }
        guard bits.count == 2, bits[1].count == 2, digits(bits[1]), let month = Int(bits[1]) else { return false }
        return (1...12).contains(month)
    }
}
