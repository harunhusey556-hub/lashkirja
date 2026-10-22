import XCTest
import Security
@testable import LashKirja
import LashKirjaCore

final class KeychainTokenStoreTests: XCTestCase {
    /// An unsigned test host has no Keychain (errSecMissingEntitlement). The signed app on a phone
    /// does, and so does the host CI signs ad hoc: there `LK_REQUIRE_KEYCHAIN` (ios-native.yml) turns
    /// the skip into a failure, so these tests cannot go on skipping unseen (N001).
    private func requireKeychain() throws {
        let probe: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "lk.probe", kSecAttrAccount as String: UUID().uuidString, kSecValueData as String: Data([1])]
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        guard status == errSecMissingEntitlement else { return }
        if ProcessInfo.processInfo.environment["LK_REQUIRE_KEYCHAIN"] == "1" { throw KeychainMissing() }
        throw XCTSkip("No Keychain in an unsigned test host")
    }

    private struct KeychainMissing: Error, CustomStringConvertible {
        var description: String { "the test host has no Keychain (errSecMissingEntitlement) but LK_REQUIRE_KEYCHAIN is set: is it signed?" }
    }

    func testRoundTrip() async throws {
        try requireKeychain()
        let store = KeychainTokenStore(account: "test.\(UUID().uuidString)")
        let token = StoredToken(token: "T", expiresAt: Date(timeIntervalSince1970: 2_000_000_000), issuedAt: Date(timeIntervalSince1970: 1_000_000_000), userId: "u")
        try await store.save(token)
        let loaded = await store.load()
        XCTAssertEqual(loaded, token)
        await store.savePendingRevoke("R")
        let pending = await store.loadPendingRevoke()
        XCTAssertEqual(pending, "R")
        await store.clear()
        await store.savePendingRevoke(nil)
        let cleared = await store.load()
        XCTAssertNil(cleared)
        let noPending = await store.loadPendingRevoke()
        XCTAssertNil(noPending)
    }
}
