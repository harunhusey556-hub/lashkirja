import Foundation

/// The trusted device's key (the app keeps it in the Secure Enclave): its public half goes to the
/// server with a sign-in, and every token refresh is signed with it, so a token copied off the
/// phone cannot be renewed anywhere else.
public protocol DeviceKeySigner: Sendable {
    /// A new key for a new sign-in, replacing any earlier one: the public key as base64 of the
    /// 65-byte X9.63 point. Nil when the device cannot make one (the session is then unbound).
    func newPublicKey() async -> String?
    /// The refresh headers for `token`: `X-LK-Device-Time` and `X-LK-Device-Signature` over
    /// "lk-refresh-v1\n<time>\n<sha256 hex of token>". Empty without a key.
    func refreshHeaders(token: String, now: Date) async -> [String: String]
    /// Signed out: the key goes with the session.
    func remove() async
}
