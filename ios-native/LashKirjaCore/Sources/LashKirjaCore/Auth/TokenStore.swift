import Foundation

public protocol TokenStore: Sendable {
    func load() async -> StoredToken?
    func save(_ token: StoredToken) async
    func clear() async
    func loadPendingRevoke() async -> String?
    func savePendingRevoke(_ token: String?) async
}

public actor InMemoryTokenStore: TokenStore {
    private var token: StoredToken?
    private var pending: String?
    public init() {}
    public func load() -> StoredToken? { token }
    public func save(_ token: StoredToken) { self.token = token }
    public func clear() { token = nil }
    public func loadPendingRevoke() -> String? { pending }
    public func savePendingRevoke(_ token: String?) { pending = token }
}
