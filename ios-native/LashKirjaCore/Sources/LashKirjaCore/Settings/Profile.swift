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
    /// Mailboxes the server reads receipts from (`/api/integrations/imap`); read only here.
    public var imapAccounts: [ImapAccount]?
}

public struct ProfileResponse: Decodable, Sendable { public let profile: Profile }

/// `PATCH /api/profile`: only the fields that changed; an emptied text field is sent as null.
public struct ProfilePatch: Encodable {
    private var values: [String: Value] = [:]

    enum Value: Encodable {
        case text(String?)
        case flag(Bool)
        case number(Decimal?)
        case integer(Int?)
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .text(let v): if let v { try c.encode(v) } else { try c.encodeNil() }
            case .flag(let v): try c.encode(v)
            case .number(let v): if let v { try c.encode(v) } else { try c.encodeNil() }
            case .integer(let v): if let v { try c.encode(v) } else { try c.encodeNil() }
            }
        }
    }

    public var isEmpty: Bool { values.isEmpty }

    public init(from old: Profile, to new: Profile) {
        func text(_ key: String, _ a: String?, _ b: String?) {
            let clean = b?.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = (clean?.isEmpty ?? true) ? nil : clean
            if normalized != a { values[key] = .text(normalized) }
        }
        // Names cannot be null on the server: an emptied name is left unchanged.
        if let first = new.firstName?.trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty, first != old.firstName { values["firstName"] = .text(first) }
        if let last = new.lastName?.trimmingCharacters(in: .whitespacesAndNewlines), !last.isEmpty, last != old.lastName { values["lastName"] = .text(last) }
        if old.entityType != new.entityType { values["entityType"] = .text(new.entityType) }
        if old.vatRegistered != new.vatRegistered { values["vatRegistered"] = .flag(new.vatRegistered) }
        if old.vatPeriod != new.vatPeriod, let period = new.vatPeriod { values["vatPeriod"] = .text(period) }
        text("businessName", old.businessName, new.businessName)
        text("businessId", old.businessId, new.businessId)
        text("addressStreet", old.addressStreet, new.addressStreet)
        text("addressPostalCode", old.addressPostalCode, new.addressPostalCode)
        text("addressCity", old.addressCity, new.addressCity)
        text("phone", old.phone, new.phone)
        text("invoiceIban", old.invoiceIban, new.invoiceIban)
        text("invoiceBic", old.invoiceBic, new.invoiceBic)
        text("invoiceTerms", old.invoiceTerms, new.invoiceTerms)
        if old.lateInterestPercent != new.lateInterestPercent { values["lateInterestPercent"] = .number(new.lateInterestPercent) }
        // The server takes the fee in euros (`reminderFee`) and stores cents itself.
        if old.reminderFeeCents != new.reminderFeeCents, let cents = new.reminderFeeCents {
            values["reminderFee"] = .number(Decimal(cents) / 100)
        }
    }

    struct Key: CodingKey {
        let stringValue: String
        init(stringValue: String) { self.stringValue = stringValue }
        var intValue: Int? { nil }
        init?(intValue: Int) { nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        for (key, value) in values { try c.encode(value, forKey: Key(stringValue: key)) }
    }
}

public struct DeviceSession: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let createdAt: String
    public let lastSeenAt: String?
    public let current: Bool
}

public struct DeviceSessions: Decodable, Sendable { public let sessions: [DeviceSession] }
