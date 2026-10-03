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

/// `POST /api/auth/signup/verify`: answered with the `/api/auth/token` shape. The password is
/// the one given at start: it ties the code to this sign-up, so a later start by someone else
/// for the same address cannot be completed with the owner's code.
public struct SignUpVerifyBody: Encodable, Equatable, Sendable {
    public let email: String
    public let code: String
    public let password: String
    public let device: String
    public init(email: String, code: String, password: String, device: String = "ios-app") {
        self.email = AccountCode.address(email)
        self.code = AccountCode.normalize(code) ?? code.trimmingCharacters(in: .whitespacesAndNewlines)
        self.password = password
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
    /// Older mails' subject line starts with this; owners paste the whole subject too. Newer
    /// subjects start with the code ("123456 on LashKirja-vahvistuskoodisi"): `extract` reads both.
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

    /// The code inside a longer text, as Gmail copies the subject or a body line
    /// ("LashKirja-tilisi vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia."): the first
    /// standalone six ASCII digits, which may be split 3 + 3 by one space or dash. A longer
    /// number, or digits inside a word or a link's token, is never taken for the code.
    public static func extract(_ text: String) -> String? {
        let scalars = Array(text.unicodeScalars)
        var index = 0
        while index < scalars.count {
            guard isDigit(scalars[index]) else {
                index += 1
                continue
            }
            // One number: digit runs joined by single separators ("123 456", "040 123 4567").
            let start = index
            var runs: [Int] = []
            var digits = ""
            while true {
                var run = 0
                while index < scalars.count, isDigit(scalars[index]) {
                    digits.unicodeScalars.append(scalars[index])
                    run += 1
                    index += 1
                }
                runs.append(run)
                guard index + 1 < scalars.count, codeSeparators.contains(scalars[index]), isDigit(scalars[index + 1]) else { break }
                index += 1
            }
            if runs == [length] || runs == [length / 2, length / 2],
               standsAlone(scalars, before: start - 1, after: index) {
                return digits
            }
        }
        return nil
    }

    /// What the code field keeps after a change: the code `extract` finds in what was just
    /// typed or pasted (or in the whole field), otherwise only the ASCII digits. More than six
    /// digits keeps `previous`, so a pasted long number never turns into a wrong code.
    public static func input(_ text: String, previous: String = "") -> String {
        if let code = extract(inserted(text, previous: previous)) ?? extract(text) { return code }
        var digits = ""
        digits.unicodeScalars.append(contentsOf: text.unicodeScalars.filter(isDigit))
        return digits.count <= length ? digits : previous
    }

    /// The part of `text` a keystroke or a paste added to `previous`.
    static func inserted(_ text: String, previous: String) -> String {
        let new = Array(text), old = Array(previous)
        var head = 0
        while head < new.count, head < old.count, new[head] == old[head] { head += 1 }
        var tail = 0
        while tail < new.count - head, tail < old.count - head,
              new[new.count - 1 - tail] == old[old.count - 1 - tail] { tail += 1 }
        return String(new[head..<(new.count - tail)])
    }

    private static let codeSeparators = CharacterSet(charactersIn: " \u{00A0}\u{202F}-‐‑‒–—")
    /// What may stand right before or after the code: space, line breaks and sentence marks,
    /// never a letter, a digit or a link's `=`, `/`, `_`, `-`.
    private static let codeBoundaries = CharacterSet.whitespacesAndNewlines
        .union(CharacterSet(charactersIn: ".,:;!?()[]{}\"'«»“”„‘’*"))

    private static func isDigit(_ scalar: Unicode.Scalar) -> Bool { scalar.value >= 48 && scalar.value <= 57 }

    private static func standsAlone(_ scalars: [Unicode.Scalar], before: Int, after: Int) -> Bool {
        func edge(_ at: Int, _ beyond: Int) -> Bool {
            guard at >= 0, at < scalars.count else { return true }
            guard codeBoundaries.contains(scalars[at]) else { return false }
            // "123456.78" or "1,123456" is a number, not a code followed by a full stop.
            let mark = scalars[at] == "." || scalars[at] == ","
            return !(mark && beyond >= 0 && beyond < scalars.count && isDigit(scalars[beyond]))
        }
        return edge(before, before - 1) && edge(after, after + 1)
    }

    /// The address as the sign-in sends it.
    public static func address(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

// MARK: - The address, before anything is sent

public enum EmailCheck {
    public static let missing = "Kirjoita sähköpostiosoite."
    public static let invalid = "Tarkista sähköpostiosoite, esim. nimi@yritys.fi."

    /// The sign-in and sign-up forms' own check, so a typo shows next to the field instead of
    /// coming back from the server. Nil when the address can be sent; the server decides the rest.
    public static func problem(_ email: String) -> String? {
        let text = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return missing }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !text.contains(where: { $0.isWhitespace }) else { return invalid }
        let labels = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }) else { return invalid }
        return nil
    }
}

// MARK: - Errors

/// What the sign-up and reset-by-code routes refused, from the server's `code` (or the 429).
public enum AccountCodeFailure: Equatable, Sendable {
    /// `SIGNUP_CODE_INVALID`, with the tries the server still allows.
    case codeInvalid(attemptsLeft: Int?)
    /// `RESET_CODE_INVALID`: one answer for a wrong, expired or blocked code (and an unknown
    /// address), so the reset never tells whether an account exists.
    case resetCodeInvalid
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
        case "SIGNUP_CODE_INVALID":
            self = .codeInvalid(attemptsLeft: error.fields["attemptsLeft"].flatMap { Int($0) })
        case "RESET_CODE_INVALID": self = .resetCodeInvalid
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
        case .resetCodeInvalid: "Koodi ei kelpaa tai se on vanhentunut."
        case .signUpExpired: "Koodi on vanhentunut tai sitä yritettiin liian monta kertaa. Aloita tilin luonti uudelleen."
        case .resetExpired: "Koodi on vanhentunut tai sitä yritettiin liian monta kertaa. Pyydä uusi palautusviesti."
        case .emailTaken: "Tällä sähköpostiosoitteella on jo tili. Kirjaudu sisään tai palauta salasana."
        case .disabled: serverMessage ?? "Uusien tilien luonti ei ole käytössä."
        case .rateLimited: serverMessage ?? "Liian monta yritystä. Yritä hetken päästä uudelleen."
        case .other: serverMessage ?? LKError.unreachable
        }
    }
}
