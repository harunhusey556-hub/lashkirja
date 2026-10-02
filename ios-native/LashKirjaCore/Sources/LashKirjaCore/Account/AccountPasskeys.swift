import Foundation

/// One row of `GET /api/auth/passkey`.
public struct Passkey: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public var deviceName: String
    public let createdAt: String
    public let lastUsedAt: String?

    /// "Luotu 1.9.2026 · Ei vielä käytetty", as on the web.
    public var detail: String {
        let created = "Luotu \(APIDate.displayDay(createdAt))"
        if let lastUsedAt { return "\(created) · Käytetty viimeksi \(APIDate.displayDay(lastUsedAt))" }
        return "\(created) · Ei vielä käytetty"
    }
}

public struct PasskeyList: Decodable, Sendable { public let passkeys: [Passkey] }

/// `GET /api/auth/passkey/status`: `native` needs the server's associated-domains file too.
public struct PasskeyStatus: Decodable, Sendable {
    public let web: Bool
    public let native: Bool
}

/// `PATCH /api/auth/passkey/[id]`.
public struct PasskeyRenameBody: Encodable, Sendable {
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines) }
}

public enum PasskeyName {
    public static let maxLength = 60
    public static func validate(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Anna nimi." }
        if trimmed.count > maxLength { return "Enintään \(maxLength) merkkiä." }
        return nil
    }
}

/// Why creating a passkey did not finish (lib/passkey-copy.ts).
public enum PasskeyFailure: Equatable, Sendable {
    case cancelled, unsupported, notConfigured, exists, busy, network, rate, password, failed

    /// From the options request's HTTP status.
    public static func from(status: Int) -> PasskeyFailure {
        switch status {
        case 503: .notConfigured
        case 400, 401: .password
        case 429: .rate
        case 0: .network
        default: .failed
        }
    }

    /// Nil when nothing is shown (the owner cancelled the system sheet).
    public func message(serverMessage: String?) -> String? {
        switch self {
        case .cancelled: nil
        case .unsupported: "Tämä laite ei tue pääsyavaimia. Kirjaudu salasanalla."
        case .notConfigured: "Pääsyavaimet eivät ole vielä käytössä tällä palvelimella. Kirjaudu salasanalla."
        case .exists: "Tällä laitteella on jo pääsyavain tälle tilille."
        case .busy: "Pääsyavainikkuna on jo auki."
        case .network: "Ei yhteyttä palvelimeen. Tarkista verkkoyhteys."
        case .rate: serverMessage ?? "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen."
        case .password: serverMessage ?? "Nykyinen salasana on väärä."
        case .failed: "Pääsyavaimen luonti epäonnistui. Yritä uudelleen."
        }
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String?) -> Data? {
        guard let text, !text.isEmpty else { return nil }
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: base64)
    }
}

/// `POST /api/auth/passkey/register/options` answer: what the system sheet needs.
public struct PasskeyRegistrationStart: Decodable, Sendable {
    public let challengeId: String
    public let rpId: String
    public let challenge: Data
    public let userId: Data
    public let userName: String
    public let displayName: String?
    public let excludedCredentialIds: [Data]

    private struct Options: Decodable {
        struct RP: Decodable { let id: String? }
        struct User: Decodable { let id: String; let name: String; let displayName: String? }
        struct Descriptor: Decodable { let id: String }
        let rp: RP
        let user: User
        let challenge: String
        let excludeCredentials: [Descriptor]?
    }

    enum CodingKeys: String, CodingKey { case challengeId, options }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        challengeId = try c.decode(String.self, forKey: .challengeId)
        let options = try c.decode(Options.self, forKey: .options)
        func bad(_ what: String) -> DecodingError {
            .dataCorruptedError(forKey: .options, in: c, debugDescription: what)
        }
        guard let rp = options.rp.id, !rp.isEmpty else { throw bad("rp.id") }
        guard let challenge = Base64URL.decode(options.challenge) else { throw bad("challenge") }
        guard let user = Base64URL.decode(options.user.id) else { throw bad("user.id") }
        rpId = rp
        self.challenge = challenge
        userId = user
        userName = options.user.name
        displayName = options.user.displayName
        excludedCredentialIds = (options.excludeCredentials ?? []).compactMap { Base64URL.decode($0.id) }
    }
}

/// `POST /api/auth/passkey/register/verify`: the WebAuthn JSON @simplewebauthn/server checks.
public struct PasskeyRegistrationVerify: Encodable, Sendable {
    public let challengeId: String
    public let response: Credential
    public let device = "ios-app"

    public struct Credential: Encodable, Sendable {
        public let id: String
        public let rawId: String
        public let type = "public-key"
        public let authenticatorAttachment = "platform"
        public let clientExtensionResults: [String: String] = [:]
        public let response: Attestation
    }

    public struct Attestation: Encodable, Sendable {
        public let clientDataJSON: String
        public let attestationObject: String
        public let transports = ["hybrid", "internal"]
    }

    public init(challengeId: String, credentialId: Data, clientDataJSON: Data, attestationObject: Data) {
        self.challengeId = challengeId
        let id = Base64URL.encode(credentialId)
        response = Credential(id: id, rawId: id, response: Attestation(
            clientDataJSON: Base64URL.encode(clientDataJSON),
            attestationObject: Base64URL.encode(attestationObject)))
    }
}
