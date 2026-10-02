import Foundation

/// `POST /api/auth/passkey/authenticate/options`: a usernameless request, so the options
/// name no account and no credential, only the relying party and the challenge.
public struct PasskeySignInStart: Decodable, Sendable {
    public let challengeId: String
    public let rpId: String
    public let challenge: Data

    private struct Options: Decodable {
        let rpId: String?
        let challenge: String
    }

    enum CodingKeys: String, CodingKey { case challengeId, options }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        challengeId = try c.decode(String.self, forKey: .challengeId)
        let options = try c.decode(Options.self, forKey: .options)
        guard let rp = options.rpId, !rp.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .options, in: c, debugDescription: "rpId")
        }
        guard let challenge = Base64URL.decode(options.challenge) else {
            throw DecodingError.dataCorruptedError(forKey: .options, in: c, debugDescription: "challenge")
        }
        rpId = rp
        self.challenge = challenge
    }
}

/// `POST /api/auth/passkey/authenticate/verify`: the assertion as WebAuthn JSON, the same
/// shape the Capacitor plugin sent (ios/App/App/PasskeyPlugin.swift), and a bearer session.
public struct PasskeySignInVerify: Encodable, Sendable {
    public let challengeId: String
    public let response: Credential
    public let transport = "bearer"
    public let device = "ios-app"

    public struct Credential: Encodable, Sendable {
        public let id: String
        public let rawId: String
        public let type = "public-key"
        public let authenticatorAttachment = "platform"
        public let clientExtensionResults: [String: String] = [:]
        public let response: Assertion
    }

    public struct Assertion: Encodable, Sendable {
        public let clientDataJSON: String
        public let authenticatorData: String
        public let signature: String
        public let userHandle: String?
    }

    public init(challengeId: String, credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data?) {
        self.challengeId = challengeId
        let id = Base64URL.encode(credentialId)
        let handle = userHandle.flatMap { $0.isEmpty ? nil : Base64URL.encode($0) }
        response = Credential(id: id, rawId: id, response: Assertion(
            clientDataJSON: Base64URL.encode(clientDataJSON),
            authenticatorData: Base64URL.encode(authenticatorData),
            signature: Base64URL.encode(signature),
            userHandle: handle))
    }
}

/// Why a passkey sign-in did not finish, with the web's copy (lib/passkey-copy.ts, "sign-in").
public enum PasskeySignInFailure: Equatable, Sendable {
    case cancelled, unsupported, notConfigured, busy, network, rate, closed, rejected, failed

    /// From the options request's HTTP status (0 = no connection).
    public static func fromOptions(status: Int) -> PasskeySignInFailure {
        switch status {
        case 0: .network
        case 503: .notConfigured
        case 429: .rate
        default: .failed
        }
    }

    /// From the verify request's HTTP status: anything else the server refused is "rejected".
    public static func fromVerify(status: Int) -> PasskeySignInFailure {
        switch status {
        case 0: .network
        case 429: .rate
        case 403: .closed
        case 503: .notConfigured
        default: .rejected
        }
    }

    /// From the system sheet's error, as already classified for creating a passkey.
    public init(ceremony: PasskeyFailure) {
        switch ceremony {
        case .cancelled: self = .cancelled
        case .unsupported: self = .unsupported
        case .notConfigured: self = .notConfigured
        case .busy: self = .busy
        case .network: self = .network
        case .rate: self = .rate
        case .exists, .password, .failed: self = .failed
        }
    }

    /// The server or this device cannot do passkeys: the button goes away and the note is info.
    public var hidesButton: Bool { self == .unsupported || self == .notConfigured }

    /// Nil when nothing is shown (the owner cancelled the system sheet).
    public func message(serverMessage: String?) -> String? {
        switch self {
        case .cancelled: nil
        case .unsupported: "Tämä laite ei tue pääsyavaimia. Kirjaudu salasanalla."
        case .notConfigured: "Pääsyavaimet eivät ole vielä käytössä tällä palvelimella. Kirjaudu salasanalla."
        case .busy: "Pääsyavainikkuna on jo auki."
        case .network: "Ei yhteyttä palvelimeen. Tarkista verkkoyhteys."
        case .rate: serverMessage ?? "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen."
        case .closed: serverMessage ?? "Tili on suljettu."
        case .rejected: "Pääsyavain ei kelpaa. Kirjaudu salasanalla."
        case .failed: "Kirjautuminen pääsyavaimella epäonnistui. Yritä uudelleen tai kirjaudu salasanalla."
        }
    }
}

/// The one-time "create a passkey?" offer after a password sign-in (lib/passkey-offer.ts):
/// remembered per account on this device, so it shows once and never nags.
public enum PasskeyOffer {
    public static let prefix = "lk.passkeyOffer.v1:"
    /// Listing the account's passkeys may take this long; slower means no offer.
    public static let listTimeout: TimeInterval = 2.5

    public static func key(email: String) -> String {
        prefix + email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Any doubt (no list: offline, slow, an error) skips the offer, so it never blocks signing in.
    public static func shouldOffer(passkeysReady: Bool, email: String, seen: Bool, passkeyCount: Int?) -> Bool {
        guard passkeysReady, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !seen else { return false }
        return passkeyCount == 0
    }

    public static let title = "Kirjaudu jatkossa pääsyavaimella"
    public static let text = "Pääsyavain avaa LashKirjan Face ID:llä tai Touch ID:llä ilman salasanaa. Salasana toimii edelleen."
    public static let created = "Pääsyavain luotu. Voit kirjautua sillä ensi kerralla."
}
