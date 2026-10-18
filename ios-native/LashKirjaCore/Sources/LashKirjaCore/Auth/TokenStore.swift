import Foundation

public protocol TokenStore: Sendable {
    func load() async -> StoredToken?
    func save(_ token: StoredToken) async throws
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

/// A store the launch can read before the first frame, without a suspension (the Keychain is):
/// a trusted session opens on the cached screens in that frame instead of a blank one.
public protocol LaunchTokenReading: Sendable {
    func loadAtLaunch() -> StoredToken?
}
