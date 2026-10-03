import Foundation
import Security
import LashKirjaCore

/// The bearer token in the Keychain, readable after first unlock, this device only.
actor KeychainTokenStore: TokenStore {
    private let service = "fi.tiyouba.lashkirja"
    private let account: String
    private let revokeAccount: String

    init(account: String = "auth.v1") {
        self.account = account
        self.revokeAccount = account + ".pending-revoke"
    }

    func load() -> StoredToken? {
        guard let data = read(account) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(StoredToken.self, from: data)
    }

    func save(_ token: StoredToken) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        try write(account, try encoder.encode(token))
    }

    func clear() {
        // A token that cannot be deleted is overwritten with nothing readable instead, so it
        // never signs anyone in again.
        if !delete(account) { try? write(account, Data()) }
    }

    func loadPendingRevoke() -> String? { read(revokeAccount).map { String(decoding: $0, as: UTF8.self) } }

    func savePendingRevoke(_ token: String?) {
        if let token { try? write(revokeAccount, Data(token.utf8)) } else { delete(revokeAccount) }
    }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func read(_ account: String) -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Updates the item in place (no moment without a token, as delete-then-add had); adds it when
    /// there is none. A refusal is thrown, so a sign-in that did not stick is not shown as done.
    private func write(_ account: String, _ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(base(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let query = base(account).merging(attributes) { _, new in new }
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// True when the item is gone (or never was).
    @discardableResult
    private func delete(_ account: String) -> Bool {
        let status = SecItemDelete(base(account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

struct KeychainError: Error {
    let status: OSStatus
}
