import Foundation

/// `GET /api/invoices/sequence`: the number the next invoice will get.
public struct InvoiceSequence: Decodable, Sendable, Equatable {
    public let nextNumber: Int

    public init(nextNumber: Int) { self.nextNumber = nextNumber }

    /// "Seuraava laskunumero: 5", or nil when the server gave nothing usable.
    public static func label(_ nextNumber: Int?) -> String? {
        guard let nextNumber, nextNumber > 0 else { return nil }
        return "Seuraava laskunumero: \(nextNumber)"
    }
}
