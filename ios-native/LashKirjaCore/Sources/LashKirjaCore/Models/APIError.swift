import Foundation

/// A failed API call, in the words the server gave (Finnish), ready to show.
public struct LKError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let message: String
    public let fields: [String: String]

    public init(status: Int, code: String? = nil, message: String, fields: [String: String] = [:]) {
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields
    }

    /// The server's "same receipt already saved" 409 (details.isDuplicate).
    public var isDuplicate: Bool { fields["isDuplicate"] == "true" }

    /// A 401 that means the session is gone (not, say, a wrong current password).
    public var endsSession: Bool {
        guard status == 401 else { return false }
        if code == "UNAUTHORIZED" { return true }
        return ["Ei kirjautunut", "Unauthorized", "Kirjautuminen vaaditaan", LKError.unreachable].contains(message)
    }

    public static let unreachable = "Palvelimeen ei saada yhteyttä. Yritä hetken päästä uudelleen."
    public static func offline() -> LKError { LKError(status: 0, code: "OFFLINE", message: "Ei verkkoyhteyttä.") }
}

/// Survives a trip through Objective-C (Stripe Terminal hands our connection token error back as
/// an NSError): the status, code and Finnish message stay readable from the NSError.
extension LKError: CustomNSError, LocalizedError {
    public static let errorDomain = "fi.lashkirja.LKError"
    public var errorCode: Int { status }
    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let code { info["code"] = code }
        return info
    }
    public var errorDescription: String? { message }

    /// The LKError an NSError was made from, if it was one.
    public init?(bridged error: NSError) {
        guard error.domain == LKError.errorDomain else { return nil }
        self.init(status: error.code,
                  code: error.userInfo["code"] as? String,
                  message: error.userInfo[NSLocalizedDescriptionKey] as? String ?? LKError.unreachable)
    }
}

public enum APIErrorDecoder {
    private struct Flat: Decodable { let error: String }
    private struct Nested: Decodable {
        struct Body: Decodable {
            struct Detail: Decodable { let field: String?; let message: String }
            struct Flags: Decodable { let isDuplicate: Bool? }
            let code: String?
            let message: String
            let details: [Detail]?
            let flags: Flags?
            enum CodingKeys: String, CodingKey { case code, message, details }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                code = try c.decodeIfPresent(String.self, forKey: .code)
                message = try c.decode(String.self, forKey: .message)
                // `details` is a field list for validation errors, an object elsewhere (409 duplicate).
                details = try? c.decodeIfPresent([Detail].self, forKey: .details)
                flags = try? c.decodeIfPresent(Flags.self, forKey: .details)
            }
        }
        let error: Body
    }

    /// Both server shapes: `{"error":"text"}` and `{"error":{code,message,details}}`.
    public static func decode(status: Int, data: Data) -> LKError {
        let decoder = JSONDecoder()
        if let flat = try? decoder.decode(Flat.self, from: data) {
            return LKError(status: status, message: flat.error)
        }
        if let nested = try? decoder.decode(Nested.self, from: data) {
            var fields: [String: String] = [:]
            for detail in nested.error.details ?? [] {
                if let field = detail.field { fields[field] = detail.message }
            }
            if nested.error.flags?.isDuplicate == true { fields["isDuplicate"] = "true" }
            return LKError(status: status, code: nested.error.code, message: nested.error.message, fields: fields)
        }
        return LKError(status: status, message: LKError.unreachable)
    }
}
