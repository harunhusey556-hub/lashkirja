import Foundation

public struct Profile: Codable, Sendable, Equatable {
    public var firstName: String?
    public var lastName: String?
    public var email: String
    public var entityType: String
    public var vatRegistered: Bool
    public var vatPeriod: String?
    public var businessName: String?
    public var businessId: String?
    public var addressStreet: String?
    public var addressPostalCode: String?
    public var addressCity: String?
    public var phone: String?
    public var invoiceIban: String?
    public var invoiceBic: String?
    public var invoiceTerms: String?
    public var lateInterestPercent: Decimal?
    public var reminderFeeCents: Int?
}

public struct ProfileResponse: Decodable, Sendable { public let profile: Profile }
