import Foundation

public struct Customer: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let businessId: String?
    public let contactPerson: String?
    public let email: String?
    public let phone: String?
    public let addressStreet: String?
    public let addressPostalCode: String?
    public let addressCity: String?
    public let country: String?
    public let defaultPaymentTermDays: Int
    public let notes: String?
    public let archivedAt: String?
    public let updatedAt: String
    public let invoiceCount: Int?
    public let openInvoiceCount: Int?
    public let openBalance: Decimal?
    public let invoicedTotal: Decimal?
    public let lastInvoiceDate: String?

    public var isArchived: Bool { archivedAt != nil }

    public var address: String? {
        let city = [addressPostalCode, addressCity].compactMap { $0 }.joined(separator: " ")
        let parts = [addressStreet, city.isEmpty ? nil : city].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

public struct CustomerList: Decodable, Sendable { public let customers: [Customer] }
public struct CustomerResponse: Decodable, Sendable { public let customer: Customer }

/// `POST /api/customers` / `PATCH /api/customers/{id}`: empty fields are left out.
public struct CustomerDraft: Encodable, Sendable, Equatable {
    public var name = ""
    public var businessId = ""
    public var contactPerson = ""
    public var email = ""
    public var phone = ""
    public var addressStreet = ""
    public var addressPostalCode = ""
    public var addressCity = ""
    public var defaultPaymentTermDays = 14
    public var notes = ""
    /// A PATCH sends emptied fields as null so they are cleared; a POST leaves them out.
    public var clearsEmptyFields = false

    public init() {}

    public init(_ c: Customer) {
        name = c.name
        businessId = c.businessId ?? ""
        contactPerson = c.contactPerson ?? ""
        email = c.email ?? ""
        phone = c.phone ?? ""
        addressStreet = c.addressStreet ?? ""
        addressPostalCode = c.addressPostalCode ?? ""
        addressCity = c.addressCity ?? ""
        defaultPaymentTermDays = c.defaultPaymentTermDays
        notes = c.notes ?? ""
    }

    public static func == (a: CustomerDraft, b: CustomerDraft) -> Bool {
        a.name == b.name && a.businessId == b.businessId && a.contactPerson == b.contactPerson && a.email == b.email
            && a.phone == b.phone && a.addressStreet == b.addressStreet && a.addressPostalCode == b.addressPostalCode
            && a.addressCity == b.addressCity && a.defaultPaymentTermDays == b.defaultPaymentTermDays && a.notes == b.notes
    }

    enum CodingKeys: String, CodingKey {
        case name, businessId, contactPerson, email, phone, addressStreet, addressPostalCode, addressCity, defaultPaymentTermDays, notes
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        func put(_ value: String, _ key: CodingKeys) throws {
            let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { try c.encode(t, forKey: key) } else if clearsEmptyFields { try c.encodeNil(forKey: key) }
        }
        try c.encode(name.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .name)
        try put(businessId, .businessId)
        try put(contactPerson, .contactPerson)
        try put(email, .email)
        try put(phone, .phone)
        try put(addressStreet, .addressStreet)
        try put(addressPostalCode, .addressPostalCode)
        try put(addressCity, .addressCity)
        try c.encode(defaultPaymentTermDays, forKey: .defaultPaymentTermDays)
        try put(notes, .notes)
    }
}

/// `GET /api/customers/{id}`: the customer plus its invoice totals and invoices.
public struct CustomerDetail: Decodable, Sendable {
    public struct InvoiceSummary: Decodable, Sendable, Identifiable, Hashable {
        public let id: String
        public let number: Int
        public let displayStatus: InvoiceStatus
        public let issueDate: String
        public let dueDate: String
        public let gross: Decimal
        public let open: Decimal
    }
    public let customer: Customer
    public let openBalance: Decimal
    public let openInvoiceCount: Int
    public let invoicedTotal: Decimal
    public let invoices: [InvoiceSummary]
    /// Recurring invoices on this customer: a delete archives it and pauses them.
    public let recurringCount: Int?
}
