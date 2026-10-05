import Foundation

/// `GET /api/invoices/{id}/send`: what an e-mail send would carry, checked before the tap,
/// and the reason it cannot go yet (web `SendPreview`, `lib/invoice-mail.ts previewInvoiceSend`).
public struct InvoiceSendPreview: Decodable, Sendable, Hashable {
    public let recipient: String?
    public let gross: Decimal
    public let dueDate: String?
    public let iban: String?
    public let creditNote: Bool?
    public let attachment: String
    public let missing: [String]
    public let blockedReason: String?
    public let mailboxMissing: Bool?
    public let lockedMonth: String?
    /// The text a send would carry, ready to edit: the default template filled for this invoice,
    /// or the built-in text. Absent from a server before e-mail templates.
    public var subject: String?
    public var message: String?
    /// The template `subject`/`message` came from; nil for the built-in text.
    public var templateId: String?
    public var templates: [EmailTemplateRef]?
    /// What each placeholder stands for on this invoice ("asiakas" -> "Anna Asiakas").
    public var placeholders: [String: String]?

    public var canSend: Bool { blockedReason == nil }

    /// The customer has no address but the owner typed one: the server takes `to`, so only the
    /// missing address is lifted; every other block still holds.
    public func canSend(typedRecipient: String) -> Bool {
        if canSend { return true }
        guard fix == .customerEmail, mailboxMissing != true, (lockedMonth ?? "").isEmpty else { return false }
        return InvoiceMailText.recipientError(typedRecipient) == nil
    }
    /// A credit note is not paid: no due date and no account number on the check.
    public var showsDueDate: Bool { creditNote != true && dueDate != nil }
    public var showsIban: Bool { creditNote != true }

    /// Every block names its fix (web SALES-15), in the web's order; a credited invoice has none.
    public var fix: InvoiceSendFix? {
        guard blockedReason != nil else { return nil }
        if !missing.isEmpty { return .sellerDetails }
        if recipient?.isEmpty ?? true { return .customerEmail }
        if mailboxMissing == true { return .connectMailbox }
        if let lockedMonth, !lockedMonth.isEmpty { return .openPeriod(month: lockedMonth) }
        return nil
    }
}

public struct InvoiceSendPreviewResponse: Decodable, Sendable { public let preview: InvoiceSendPreview }

/// Where a blocked send check sends the owner.
public enum InvoiceSendFix: Sendable, Hashable {
    case sellerDetails, customerEmail, connectMailbox
    case openPeriod(month: String)

    public var title: String {
        switch self {
        case .sellerDetails: "Avaa yritystiedot"
        case .customerEmail: "Lisää asiakkaalle sähköposti"
        case .connectMailbox: "Yhdistä sähköposti"
        case .openPeriod: "Avaa kaudet"
        }
    }

    public var note: String? {
        if case .connectMailbox = self { return "Voit myös jakaa PDF:n tai merkitä laskun lähetetyksi toimintovalikosta." }
        return nil
    }
}

/// A template in the send sheet's picker (`preview.templates`).
public struct EmailTemplateRef: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let isDefault: Bool

    public init(id: String, name: String, isDefault: Bool) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }
}

/// `POST /api/invoices/{id}/send`: the edited subject and message, and a recipient only when
/// the owner changed the customer's address. Placeholders left in the text are filled by the server.
public struct InvoiceSendBody: Encodable, Sendable, Equatable {
    public let to: String?
    public let subject: String
    public let message: String

    public init(recipient: String?, to: String, subject: String, message: String) {
        let typed = to.trimmingCharacters(in: .whitespacesAndNewlines)
        let original = (recipient ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.to = typed.isEmpty || typed.caseInsensitiveCompare(original) == .orderedSame ? nil : typed
        self.subject = InvoiceMailText.oneLine(subject)
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    enum CodingKeys: String, CodingKey { case to, subject, message }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let to { try c.encode(to, forKey: .to) }
        try c.encode(subject, forKey: .subject)
        try c.encode(message, forKey: .message)
    }
}

/// The server's limits for an invoice e-mail and a template (`lib/invoice-email-templates.ts`),
/// checked before the tap. Lengths count UTF-16 units, as JavaScript does.
public enum InvoiceMailText {
    public static let subjectMax = 200
    public static let messageMax = 5000
    public static let nameMax = 80

    /// A subject is one line: a pasted line break becomes a space.
    public static func oneLine(_ text: String) -> String {
        text.components(separatedBy: .newlines).joined(separator: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    }

    public static func subjectError(_ subject: String) -> String? {
        let clean = oneLine(subject)
        if clean.isEmpty { return "Aihe puuttuu." }
        if clean.utf16.count > subjectMax { return "Aihe on liian pitkä (enintään \(subjectMax) merkkiä)." }
        return nil
    }

    public static func messageError(_ message: String) -> String? {
        let clean = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return "Viesti puuttuu." }
        if clean.utf16.count > messageMax { return "Viesti on liian pitkä (enintään \(messageMax) merkkiä)." }
        return nil
    }

    public static func nameError(_ name: String) -> String? {
        let clean = oneLine(name)
        if clean.isEmpty { return "Anna mallille nimi." }
        if clean.utf16.count > nameMax { return "Nimi on liian pitkä (enintään \(nameMax) merkkiä)." }
        return nil
    }

    /// The address the owner typed, when it is not one the server would take.
    public static func recipientError(_ to: String) -> String? {
        let typed = to.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return "Vastaanottaja puuttuu." }
        let shape = typed.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
        return shape && typed.utf16.count <= 160 ? nil : "Sähköpostiosoite ei kelpaa."
    }
}

/// The reply to `POST /api/invoices/{id}/send` (body `{}`; the server writes to the customer's address).
public struct InvoiceSendResult: Decodable, Sendable {
    public let sentTo: String
    public let recorded: Bool?
    public let notice: String?
    public let replayed: Bool?

    /// Mail went out but the server could not store that it did: the owner must not send again blindly.
    public var isWarning: Bool { replayed != true && recorded == false }

    public var message: String {
        if replayed == true {
            // The earlier tap went through and only its answer was lost.
            return "Lasku oli jo lähetetty osoitteeseen \(sentTo). Toista lähetystä ei tehty."
        }
        if recorded == false {
            return notice ?? "Viesti lähti, mutta lähetyksen kirjausta ei saatu tallennettua. Älä lähetä samaa laskua uudelleen ennen tarkistusta."
        }
        return "Lasku lähetettiin osoitteeseen \(sentTo)."
    }

    /// A lost connection leaves it open whether the mail left; the same key makes a retry safe.
    public static func failureMessage(_ error: Error) -> String {
        if let error = error as? LKError, error.status == 0, error.code == "NETWORK" || error.code == "TIMEOUT" {
            return "Yhteys katkesi, emmekä tiedä ehtikö viesti lähteä. Voit yrittää uudelleen: samaa laskua ei lähetetä kahdesti."
        }
        return (error as? LKError)?.message ?? LKError.unreachable
    }
}

/// `POST /api/invoices/{id}/status`: "Merkitse maksetuksi", its "Kumoa", and "Sulje perustelulla".
public struct InvoiceStatusChange: Encodable, Sendable, Equatable {
    public let status: String
    public let closeReason: String?

    public static let markPaid = InvoiceStatusChange(status: "paid", closeReason: nil)
    /// "Kumoa" after "Merkitse maksetuksi": the invoice is open again.
    public static let reopen = InvoiceStatusChange(status: "sent", closeReason: nil)
    /// A draft marked sent without e-mail (the same status as `reopen`).
    public static let markSent = InvoiceStatusChange(status: "sent", closeReason: nil)
    public static func close(reason: String) -> InvoiceStatusChange {
        InvoiceStatusChange(status: "paid", closeReason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public static let markedPaidText = "Lasku merkittiin maksetuksi"
    public static let reopenedText = "Lasku on taas avoin"

    /// The server wants at least three characters (`closeReason: min(3)`).
    public static func closeReasonError(_ reason: String) -> String? {
        reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 ? "Kirjoita perustelu, vähintään kolme merkkiä." : nil
    }

    /// Written off with a reason: only a sent invoice that still has money open (web menu rule).
    public static func canClose(status: String, open: Decimal, isCreditNote: Bool) -> Bool {
        !isCreditNote && status == "sent" && open > 0
    }

    enum CodingKeys: String, CodingKey { case status, closeReason }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(status, forKey: .status)
        if let closeReason { try c.encode(closeReason, forKey: .closeReason) }
    }
}

/// F22: what "Uusi lasku" says before the invoice exists, so the blocker the send check would
/// name later is known (and fixable) first. Never blocks: a draft can always be made.
public struct SellerPreflight: Sendable, Equatable {
    public let title: String
    public let body: String
    /// The send gate's field names ("nimi", "tilinumero"), as `missingSellerSendFields` has them.
    public let missing: [String]

    /// The seller name falls back to the person's own name, as on the invoice.
    public static func note(businessName: String?, firstName: String?, lastName: String?, iban: String?) -> SellerPreflight? {
        let blank: (String?) -> Bool = { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        var missing: [String] = []
        if blank(businessName) && blank(firstName) && blank(lastName) { missing.append("nimi") }
        if blank(iban) { missing.append("tilinumero") }
        guard !missing.isEmpty else { return nil }
        let what = missing.joined(separator: " ja ")
        let pronoun = missing.count > 1 ? "ne" : "se"
        return SellerPreflight(
            title: "Täydennä laskuttajan tiedot",
            body: "Laskun voi luoda nyt, mutta sen lähettämiseen tarvitaan \(what). Lisää \(pronoun) ennen ensimmäistä lähetystä.",
            missing: missing
        )
    }

    /// Nothing is said before the profile has loaded: unknown is not missing.
    public static func note(profile: Profile?) -> SellerPreflight? {
        guard let profile else { return nil }
        return note(businessName: profile.businessName, firstName: profile.firstName, lastName: profile.lastName, iban: profile.invoiceIban)
    }
}
