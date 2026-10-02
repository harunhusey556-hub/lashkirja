import Foundation

// MARK: - Password reset (/unohtunut-salasana, /palauta-salasana)

/// `POST /api/auth/password/forgot`.
public struct ForgotPasswordBody: Encodable, Sendable {
    public let email: String
    public init(email: String) { self.email = email.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The one answer for every address: it says only whether the server can send mail.
public struct ForgotPasswordResponse: Decodable, Sendable {
    public let mailConfigured: Bool?
    public let message: String?

    public var mailSent: Bool { mailConfigured != false }

    /// The server's sentence, or the web app's fallback for it.
    public var text: String {
        if let message, !message.trimmingCharacters(in: .whitespaces).isEmpty { return message }
        return mailSent
            ? "Jos osoitteella löytyy tili, palautuslinkki on matkalla. Tarkista myös roskaposti. Jos viestiä ei kuulu muutamassa minuutissa, ota yhteyttä tukeen."
            : "Palautuslinkkiä ei voida lähettää tästä palvelusta automaattisesti. Voit ota yhteyttä tukeen, niin autamme sinut takaisin sisään."
    }
}

/// `POST /api/auth/password/reset`.
public struct ResetPasswordBody: Encodable, Sendable {
    public let token: String
    public let password: String
    public init(token: String, password: String) {
        self.token = token
        self.password = password
    }
}

public enum PasswordReset {
    public static let minLength = 8
    public static let maxLength = 1024

    /// The token from what the owner pasted: the whole mail link
    /// (`https://…/palauta-salasana?token=…`, `lashkirja://…?token=…`,
    /// `/vahvista-sahkoposti?token=…`) or the bare code. Nil when it cannot be one
    /// (the server takes 20–200 characters; tokens are base64url).
    public static func token(from input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        var candidate = text
        if text.contains("://") || text.hasPrefix("/") || text.contains("?") {
            guard let components = URLComponents(string: text),
                  let value = components.queryItems?.first(where: { $0.name == "token" })?.value else { return nil }
            candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard (20...200).contains(candidate.count) else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard candidate.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return candidate
    }

    public struct Errors: Equatable, Sendable {
        public var password: String?
        public var `repeat`: String?
        public var isValid: Bool { password == nil && self.repeat == nil }
        public init(password: String? = nil, repeat again: String? = nil) {
            self.password = password
            self.repeat = again
        }
    }

    /// The reset form's own checks, before anything is sent.
    public static func validate(password: String, repeat again: String) -> Errors {
        var errors = Errors()
        if password.count < minLength { errors.password = "Salasanassa on oltava vähintään \(minLength) merkkiä." }
        else if password.count > maxLength { errors.password = "Salasana on liian pitkä." }
        if again != password { errors.repeat = "Salasanat eivät täsmää." }
        return errors
    }
}

// MARK: - Privacy (/asetukset/tietosuoja)

/// One row of `GET /api/account/request`.
public struct AccountRequest: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let status: String
    public let kindLabel: String
    public let statusLabel: String
    public let downloadable: Bool
    public let createdAt: String

    /// Still with support: the row says when it was recorded and that mail will follow.
    public var isOpen: Bool { status == "pending" || status == "in_progress" }

    enum CodingKeys: String, CodingKey { case id, kind, status, kindLabel, statusLabel, downloadable, createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        kindLabel = try c.decodeIfPresent(String.self, forKey: .kindLabel) ?? kind
        statusLabel = try c.decodeIfPresent(String.self, forKey: .statusLabel) ?? status
        downloadable = try c.decodeIfPresent(Bool.self, forKey: .downloadable) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }
}

public struct AccountRequestList: Decodable, Sendable {
    public let requests: [AccountRequest]
    enum CodingKeys: String, CodingKey { case requests }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requests = try c.decodeIfPresent([AccountRequest].self, forKey: .requests) ?? []
    }
}

/// `POST /api/account/request`: the current password confirms every request.
public struct AccountRequestBody: Encodable, Sendable {
    public enum Kind: String, Encodable, Sendable { case export, close }
    public let kind: Kind
    public let currentPassword: String
    public init(kind: Kind, currentPassword: String) {
        self.kind = kind
        self.currentPassword = currentPassword
    }
}

/// Answers that carry a sentence for a toast (`{ok, message}`).
public struct AccountMessageResponse: Decodable, Sendable {
    public let message: String?
}

public enum AccountCopy {
    public static let retentionYears = 6
    public static let closeRetention = "Kuitit, laskut ja tiliotteet säilyvät \(retentionYears) vuotta, koska laki vaatii sen."
    public static let closePurge = "Yhdistetty postilaatikko ja avustajan keskustelut poistetaan. Pankkiyhteys katkaistaan pankissa. Jos pankki ei vastaa, suostumus päättyy itsestään, tai voit päättää sen oman pankkisi sovelluksessa."
    public static let closeNext = "Tuki käsittelee pyynnön ja ilmoittaa sinulle sähköpostilla. Sen jälkeen kirjautuminen estetään."
    /// The web dialog's description, read before anything is sent.
    public static let closeConfirmation = "Pyyntö kirjataan tuelle. \(closeNext) \(closePurge) \(closeRetention)"

    /// The word typed to confirm the closure request: a stronger guard than one tap.
    public static let closeConfirmWord = "SULJE"
    public static func closeConfirmMatches(_ typed: String) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == closeConfirmWord
    }
}

// MARK: - Email change (/asetukset/profiili)

/// `POST /api/auth/email`. Nil when no address was typed.
public struct EmailChangeBody: Encodable, Sendable {
    public let email: String
    public let currentPassword: String
    public init?(email: String, currentPassword: String) {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        self.email = trimmed
        self.currentPassword = currentPassword
    }
}

/// `POST /api/auth/email/confirm`.
public struct EmailConfirmBody: Encodable, Sendable {
    public let token: String
    public init(token: String) { self.token = token }
}

public struct EmailConfirmResponse: Decodable, Sendable { public let email: String? }

/// The two address fields of `GET /api/profile`, read on their own so this
/// screen does not depend on the full profile model.
public struct AccountEmailProfile: Decodable, Sendable, Equatable {
    public let email: String
    public let pendingEmail: String?
    public struct Response: Decodable, Sendable { public let profile: AccountEmailProfile }
}
