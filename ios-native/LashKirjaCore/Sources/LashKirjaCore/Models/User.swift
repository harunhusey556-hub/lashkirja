import Foundation

public struct AuthUser: Codable, Equatable, Sendable {
    public let userId: String
    public let email: String
    public let firstName: String?

    public init(userId: String, email: String, firstName: String?) {
        self.userId = userId
        self.email = email
        self.firstName = firstName
    }
}

public struct TokenResponse: Decodable, Sendable {
    public let token: String
    public let expiresAt: String
    public let user: AuthUser
}

public struct StoredToken: Codable, Equatable, Sendable {
    public var token: String
    public var expiresAt: Date
    public var issuedAt: Date
    public var userId: String

    public init(token: String, expiresAt: Date, issuedAt: Date, userId: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.issuedAt = issuedAt
        self.userId = userId
    }
}
