import Foundation

/// Archived customers on Asiakkaat (web `app/asiakkaat`): listed on request, restored with a PATCH.
public enum CustomerArchive {
    /// `GET /api/customers`: archived customers come only with `includeArchived=1`.
    public static func listQuery(includeArchived: Bool) -> [String: String] {
        includeArchived ? ["includeArchived": "1"] : [:]
    }

    /// `PATCH /api/customers/{id}` "Palauta arkistosta".
    public struct Restore: Encodable, Sendable {
        public let archived = false
        public init() {}
    }

    public static let restoredText = "Asiakas palautettiin arkistosta."

    /// What "Poista" will do, said in the confirmation: a customer with invoices or schedules is archived.
    public static func deleteNote(name: String, invoiceCount: Int, recurringCount: Int) -> String {
        if invoiceCount > 0 {
            let paused = recurringCount > 0 ? " Toistuvat laskut pysäytetään." : ""
            return "\(name). Asiakkaalla on \(invoiceCount) laskua, joten se arkistoidaan poiston sijaan.\(paused)"
        }
        if recurringCount > 0 {
            let what = recurringCount == 1 ? "toistuva lasku" : "\(recurringCount) toistuvaa laskua"
            return "\(name). Asiakkaalla on \(what), joten se arkistoidaan poiston sijaan ja toistuvat laskut pysäytetään."
        }
        return name
    }
}

/// The reply to `DELETE /api/customers/{id}`: deleted, or archived because something refers to it.
public struct CustomerRemoval: Decodable, Sendable {
    public let archived: Bool
    public let invoiceCount: Int?
    public let scheduleCount: Int?

    public var message: String {
        guard archived else { return "Asiakas poistettiin." }
        if (scheduleCount ?? 0) > 0 {
            return "Asiakas arkistoitiin ja sen toistuvat laskut pysäytettiin. Asiakkaan voi palauttaa Lisää toimintoja -valikosta, toistuvat laskut jatkat Toistuvat-sivulta."
        }
        return "Asiakas arkistoitiin. Sen voi palauttaa Lisää toimintoja -valikosta."
    }
}

/// Tappable contact details (web `asiakas/page.tsx` ContactLink): mail, phone and Maps.
public enum CustomerContact {
    public static func mail(_ email: String) -> URL? {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlUserAllowed.union(["@"])) else { return nil }
        return URL(string: "mailto:\(encoded)")
    }

    /// Only digits and a plus are dialled, as the web's `tel:` link does.
    public static func phone(_ number: String) -> URL? {
        let dialled = number.filter { $0.isASCII && ($0.isNumber || $0 == "+") }
        guard dialled.contains(where: \.isNumber) else { return nil }
        return URL(string: "tel:\(dialled)")
    }

    /// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()` is escaped.
    public static func maps(_ address: String) -> URL? {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        guard !address.isEmpty, let q = address.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "https://maps.apple.com/?q=\(q)")
    }
}
