import Foundation

/// A mailbox the server reads receipts from.
public struct ImapAccount: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let email: String
    public init(id: String, email: String) {
        self.id = id
        self.email = email
    }
}

/// The providers the web settings offer, with the incoming server each one uses.
public enum MailProvider: String, CaseIterable, Sendable, Identifiable {
    case gmail, outlook, icloud, other

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .gmail: "Gmail"
        case .outlook: "Outlook / Hotmail"
        case .icloud: "iCloud"
        case .other: "Muu sähköposti"
        }
    }

    /// nil: the user types the server in.
    public var host: String? {
        switch self {
        case .gmail: "imap.gmail.com"
        case .outlook: "outlook.office365.com"
        case .icloud: "imap.mail.me.com"
        case .other: nil
        }
    }

    /// Where the provider makes an app password.
    public var helpURL: URL? {
        switch self {
        case .gmail: URL(string: "https://myaccount.google.com/apppasswords")
        case .outlook: URL(string: "https://account.microsoft.com/security")
        case .icloud: URL(string: "https://appleid.apple.com")
        case .other: nil
        }
    }

    public var steps: [String] {
        switch self {
        case .gmail: [
            "Ota kaksivaiheinen vahvistus käyttöön Google-tilillä.",
            "Avaa Sovellussalasanat ja luo uusi salasana.",
            "Kopioi 16-merkkinen salasana alle.",
        ]
        case .outlook: [
            "Ota kaksivaiheinen vahvistus käyttöön Microsoft-tilillä.",
            "Luo turva-asetuksissa uusi sovellussalasana.",
            "Kopioi salasana alle.",
        ]
        case .icloud: [
            "Kirjaudu sisään ja avaa Sisäänkirjautuminen ja suojaus.",
            "Valitse Appikohtaiset salasanat.",
            "Luo uusi salasana sovellukselle ja kopioi se alle.",
        ]
        case .other: [
            "Täytä saapuvan postin palvelimen tiedot ja sovellussalasana. Löydät ne sähköpostin tarjoajalta.",
        ]
        }
    }
}

/// `POST /api/integrations/imap`. nil when a field the server needs is missing or invalid.
public struct ImapConnectRequest: Encodable, Sendable {
    public let email: String
    public let password: String
    public let host: String
    public let port: Int

    public init?(email: String, password: String, host: String, port: String) {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        var password = password.trimmingCharacters(in: .whitespacesAndNewlines)
        // Google shows its app password in groups of four; the spaces are not part of it.
        if host == MailProvider.gmail.host { password.removeAll { $0 == " " } }
        guard !email.isEmpty, !password.isEmpty, !host.isEmpty,
              let port = Int(port.trimmingCharacters(in: .whitespaces)), (1...65535).contains(port) else { return nil }
        self.email = email
        self.password = password
        self.host = host
        self.port = port
    }
}

/// `POST /api/integrations/imap/sync`: how many new receipts were found.
public struct ImapSyncResult: Decodable, Sendable {
    public let count: Int
}
