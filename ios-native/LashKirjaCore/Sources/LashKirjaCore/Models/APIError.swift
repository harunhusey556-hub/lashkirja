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

    public static let unreachable = "Palvelimeen ei saada yhteyttä. Yritä hetken päästä uudelleen."
    public static func offline() -> LKError { LKError(status: 0, code: "OFFLINE", message: "Ei verkkoyhteyttä.") }
}

public enum APIErrorDecoder {
    private struct Flat: Decodable { let error: String }
    private struct Nested: Decodable {
        struct Body: Decodable {
            struct Detail: Decodable { let field: String?; let message: String }
            let code: String?
            let message: String
            let details: [Detail]?
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
            return LKError(status: status, code: nested.error.code, message: nested.error.message, fields: fields)
        }
        return LKError(status: status, message: LKError.unreachable)
    }
}
