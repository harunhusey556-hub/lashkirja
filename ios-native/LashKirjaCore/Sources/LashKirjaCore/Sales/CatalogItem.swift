import Foundation

/// A saved product (`GET /api/catalog`) that can be picked onto an invoice line.
public struct CatalogItem: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let unit: String
    public let unitPrice: Decimal
    public let vatRate: Decimal

    enum CodingKeys: String, CodingKey { case id, name, unit, unitPrice, vatRate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? "kpl"
        unitPrice = try c.decodeMoney(.unitPrice)
        vatRate = try c.decodeMoney(.vatRate)
    }
}

public struct CatalogList: Decodable, Sendable { public let items: [CatalogItem] }
public struct CatalogItemResponse: Decodable, Sendable { public let item: CatalogItem }

/// The VAT rules the web form applies when it fills a line.
public enum SalesVat {
    /// The reduced 14 % rate became 13,5 % on this date.
    public static let reducedRateChangeDate = "2026-01-01"

    /// A stored 14 % reads as 13,5 % on an invoice dated after the change (`adjustVatRateForDate`).
    public static func adjustedRate(_ rate: Decimal, issueDate: String) -> Decimal {
        rate == 14 && issueDate >= reducedRateChangeDate ? Decimal(string: "13.5")! : rate
    }
}

extension InvoiceDraft.Line {
    /// Fills the line from a catalog product: description, unit, unit price and VAT rate.
    public mutating func apply(_ item: CatalogItem, issueDate: String) {
        description = item.name
        unit = item.unit
        unitPrice = item.unitPrice
        vatRate = SalesVat.adjustedRate(item.vatRate, issueDate: issueDate)
    }
}

/// `POST /api/catalog`: saves an invoice line as a product ("Tallenna tuotteeksi").
public struct CatalogItemDraft: Encodable, Sendable, Equatable {
    public var name: String
    public var unit: String
    public var unitPrice: Decimal
    public var vatRate: Decimal

    public init(line: InvoiceDraft.Line) {
        name = line.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUnit = line.unit.trimmingCharacters(in: .whitespacesAndNewlines)
        unit = trimmedUnit.isEmpty ? "kpl" : trimmedUnit
        unitPrice = line.unitPrice
        vatRate = line.vatRate
    }

    public var validationError: String? {
        if name.isEmpty || unitPrice < 0 { return "Tallenna tuotteeksi vasta kun kuvaus ja hinta ovat kunnossa." }
        return nil
    }
}
