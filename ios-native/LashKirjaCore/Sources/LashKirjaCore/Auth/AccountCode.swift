import Foundation

// MARK: - Sign-up with an emailed code (/api/auth/signup/*)

/// `GET /api/auth/signup/status`. A missing flag reads as off, so the sign-up button never
/// appears for a server that does not offer it.
public struct SignUpStatus: Decodable, Equatable, Sendable {
    public let enabled: Bool

    public init(enabled: Bool) { self.enabled = enabled }

    enum CodingKeys: String, CodingKey { case enabled }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) == true
    }
}

/// `POST /api/auth/signup/start`. The address is normalised like the sign-in's.
public struct SignUpStartBody: Encodable, Equatable, Sendable {
    public let email: String
    public let password: String
    public let firstName: String
    public init(email: String, password: String, firstName: String) {
        self.email = AccountCode.address(email)
        self.password = password
        self.firstName = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The same answer whether or not the address already has an account.
public struct SignUpStartResponse: Decodable, Equatable, Sendable {
    public let ok: Bool?
    public let mailConfigured: Bool?
    public init(ok: Bool?, mailConfigured: Bool?) {
        self.ok = ok
        self.mailConfigured = mailConfigured
    }
}

/// `POST /api/auth/signup/verify`: answered with the `/api/auth/token` shape.
public struct SignUpVerifyBody: Encodable, Equatable, Sendable {
    public let email: String
    public let code: String
    public let device: String
    public init(email: String, code: String, device: String = "ios-app") {
        self.email = AccountCode.address(email)
        self.code = AccountCode.normalize(code) ?? code.trimmingCharacters(in: .whitespacesAndNewlines)
        self.device = device
    }
}

/// `POST /api/auth/signup/resend`.
public struct SignUpResendBody: Encodable, Equatable, Sendable {
    public let email: String
    public init(email: String) { self.email = AccountCode.address(email) }
}

/// `POST /api/auth/password/reset` with the code from the mail instead of the link's token.
public struct ResetWithCodeBody: Encodable, Equatable, Sendable {
    public let email: String
    public let code: String
    public let password: String
    public init(email: String, code: String, password: String) {
        self.email = AccountCode.address(email)
        self.code = AccountCode.normalize(code) ?? code.trimmingCharacters(in: .whitespacesAndNewlines)
        self.password = password
    }
}

// MARK: - The 6-digit code

public enum AccountCode {
    public static let length = 6
    /// The mail's subject line starts with this; owners paste the whole subject too.
    public static let subjectPrefix = "LashKirja-vahvistuskoodi:"
    /// Seconds before another code may be asked for (the server allows one a minute).
    public static let resendSeconds = 60

    /// The code from what the owner typed or pasted ("123 456", "123-456",
    /// "LashKirja-vahvistuskoodi: 123456"). Nil unless exactly six digits remain.
    public static func normalize(_ input: String) -> String? {
        var text = Substring(input)
        if let range = text.range(of: subjectPrefix, options: .caseInsensitive) {
            text = text[range.upperBound...]
        }
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "-‐‑‒–—"))
        var kept = ""
        kept.unicodeScalars.append(contentsOf: text.unicodeScalars.filter { !separators.contains($0) })
        guard kept.count == length, kept.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return kept
    }

    /// The address as the sign-in sends it.
    public static func address(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

// MARK: - Errors

/// What the sign-up and reset-by-code routes refused, from the server's `code` (or the 429).
public enum AccountCodeFailure: Equatable, Sendable {
    /// `SIGNUP_CODE_INVALID` / `RESET_CODE_INVALID`, with the tries the server still allows.
    case codeInvalid(attemptsLeft: Int?)
    /// `SIGNUP_EXPIRED`: the code ran out or was wrong too often; the sign-up starts over.
    case signUpExpired
    /// `RESET_EXPIRED`: a new reset mail is needed.
    case resetExpired
    /// `SIGNUP_EMAIL_TAKEN`: the address got an account while the code was on its way.
    case emailTaken
    /// `SIGNUP_DISABLED`: this server does not create accounts.
    case disabled
    /// 429.
    case rateLimited
    /// Anything else: the server's own sentence.
    case other

    public init(_ error: LKError) {
        switch error.code {
        case "SIGNUP_CODE_INVALID", "RESET_CODE_INVALID":
            self = .codeInvalid(attemptsLeft: error.fields["attemptsLeft"].flatMap { Int($0) })
        case "SIGNUP_EXPIRED": self = .signUpExpired
        case "RESET_EXPIRED": self = .resetExpired
        case "SIGNUP_EMAIL_TAKEN": self = .emailTaken
        case "SIGNUP_DISABLED": self = .disabled
        default: self = error.status == 429 ? .rateLimited : .other
        }
    }

    /// The code is no longer worth retyping: the screen goes back to the start.
    public var startsOver: Bool { self == .signUpExpired || self == .resetExpired || self == .emailTaken }

    public func message(serverMessage: String?) -> String {
        switch self {
        case .codeInvalid(let left?) where left == 1: "Koodi ei kelpaa. Yksi yritys jäljellä."
        case .codeInvalid(let left?) where left > 1: "Koodi ei kelpaa. Yrityksiä jäljellä: \(left)."
        case .codeInvalid: "Koodi ei kelpaa."
        case .signUpExpired: "Koodi on vanhentunut tai sitä yritettiin liian monta kertaa. Aloita tilin luonti uudelleen."
        case .resetExpired: "Koodi on vanhentunut tai sitä yritettiin liian monta kertaa. Pyydä uusi palautusviesti."
        case .emailTaken: "Tällä sähköpostiosoitteella on jo tili. Kirjaudu sisään tai palauta salasana."
        case .disabled: serverMessage ?? "Uusien tilien luonti ei ole käytössä."
        case .rateLimited: serverMessage ?? "Liian monta yritystä. Yritä hetken päästä uudelleen."
        case .other: serverMessage ?? LKError.unreachable
        }
    }
}
