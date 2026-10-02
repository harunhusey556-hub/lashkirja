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

    func save(_ token: StoredToken) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        if let data = try? encoder.encode(token) { write(account, data) }
    }

    func clear() { delete(account) }

    func loadPendingRevoke() -> String? { read(revokeAccount).map { String(decoding: $0, as: UTF8.self) } }

    func savePendingRevoke(_ token: String?) {
        if let token { write(revokeAccount, Data(token.utf8)) } else { delete(revokeAccount) }
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

    private func write(_ account: String, _ data: Data) {
        delete(account)
        var query = base(account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func delete(_ account: String) { SecItemDelete(base(account) as CFDictionary) }
}
