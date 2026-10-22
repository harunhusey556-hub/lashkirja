import Foundation
import CryptoKit
import Security
import LashKirjaCore

/// The trusted device's P-256 key (OWASP MASVS: a device-bound, revocable credential). Made in the
/// Secure Enclave, so the private half never leaves this phone, not even in a backup; the server
/// keeps the public half with the session and renews the token only for a request it signs.
/// The simulator has no Secure Enclave: there the key is an ordinary Keychain key, for the tests
/// alone, and the sign-in says so in the debugging trail ("device-key-software").
actor DeviceKey: DeviceKeySigner {
    private static let tag = Data("fi.tiyouba.lashkirja.device-key".utf8)

    /// Asked through a getter: a `let secureEnclave = false` in the simulator build made the compiler
    /// report the Secure Enclave branches below as never executed.
    private static var hasSecureEnclave: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return SecureEnclave.isAvailable
        #endif
    }

    func newPublicKey() -> String? {
        remove()
        let secureEnclave = Self.hasSecureEnclave
        // Usable after the first unlock: a refresh may run in the background (Background App Refresh).
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                           secureEnclave ? .privateKeyUsage : [], nil) else { return nil }
        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Self.tag,
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        if secureEnclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
              let publicKey = SecKeyCopyPublicKey(key),
              let point = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            // No key (an unsigned test host has no Keychain): the session is simply not bound.
            EventLog.shared.log(.lifecycle("device-key-unavailable"))
            return nil
        }
        EventLog.shared.log(.lifecycle(secureEnclave ? "device-key-secure-enclave" : "device-key-software"))
        return point.base64EncodedString()
    }

    func refreshHeaders(token: String, now: Date) -> [String: String] {
        guard let key = load() else { return [:] }
        let time = String(Int(now.timeIntervalSince1970))
        let hash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        let message = Data("lk-refresh-v1\n\(time)\n\(hash)".utf8)
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
            return [:]
        }
        return ["X-LK-Device-Time": time, "X-LK-Device-Signature": signature.base64EncodedString()]
    }

    func remove() {
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: Self.tag] as CFDictionary)
    }

    private func load() -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Self.tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item else { return nil }
        return (item as! SecKey)
    }
}
