import Foundation
import StripeTerminal
import LashKirjaCore

/// Hands Stripe Terminal a connection token made by the LashKirja server on the owner's own
/// Stripe account. No caching: the SDK asks again whenever it needs one, and a token from an
/// earlier session must never reach another account.
final class StripeConnectionTokenProvider: NSObject, ConnectionTokenProvider {
    private let lock = NSLock()
    private var currentAPI: APIClient?

    /// The signed-in session's client; swapped when another owner signs in.
    var api: APIClient? {
        get { lock.withLock { currentAPI } }
        set { lock.withLock { currentAPI = newValue } }
    }

    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        guard let api else {
            completion(nil, LKError(status: 401, code: "NO_SESSION", message: "Kirjaudu sisään ennen korttimaksua."))
            return
        }
        Task {
            do {
                let token: POSConnectionToken = try await api.send("POST", "/api/pos/connection-token", body: EmptyBody())
                completion(token.secret, nil)
            } catch {
                completion(nil, error)
            }
        }
    }
}
