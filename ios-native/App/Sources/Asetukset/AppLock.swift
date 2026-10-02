import SwiftUI
import CryptoKit
import LocalAuthentication
import Security
import LashKirjaCore

/// The app lock: a PIN (salted, stretched SHA-256 in the Keychain) and optional Face ID.
/// Fails closed: a PIN that cannot be read keeps the app locked, and the
/// wrong-PIN backoff survives a relaunch.
@MainActor
@Observable
final class AppLock {
    static let shared = AppLock()

    private(set) var isLocked = false
    private(set) var failures = 0
    private(set) var waitUntil: Date?
    private let service = "fi.tiyouba.lashkirja.lock"
    private static let rounds = 100_000

    /// A cold start opens locked when a PIN is set.
    private init() {
        isLocked = read("pin") != nil
        if let state = read("backoff").flatMap({ try? JSONDecoder().decode(Backoff.self, from: $0) }) {
            failures = state.failures
            waitUntil = state.waitUntil
        }
    }

    private struct Backoff: Codable { let failures: Int; let waitUntil: Date? }

    var isEnabled: Bool { read("pin") != nil }
    var biometricsEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "lock.biometrics") }
        set { UserDefaults.standard.set(newValue, forKey: "lock.biometrics") }
    }
    var biometricsAvailable: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }

    func lockIfEnabled() { if isEnabled { isLocked = true } }

    /// True only when the PIN is stored: the caller shows an error otherwise.
    @discardableResult
    func setPIN(_ pin: String) -> Bool {
        let salt = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        guard write("pin", Data("\(salt):\(Self.hash(salt: salt, pin: pin))".utf8)) else { return false }
        resetBackoff()
        return true
    }

    func disable() {
        delete("pin")
        delete("backoff")
        biometricsEnabled = false
        isLocked = false
    }

    func unlock(pin: String) -> Bool {
        if let waitUntil, waitUntil > Date() { return false }
        // Fail closed: no readable PIN means no unlock by PIN.
        guard let stored = read("pin").map({ String(decoding: $0, as: UTF8.self) }) else { return false }
        let parts = stored.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, Self.hash(salt: parts[0], pin: pin) == parts[1] else {
            failures += 1
            waitUntil = Date().addingTimeInterval(TimeInterval(AppLockPolicy.delay(afterFailures: failures)))
            saveBackoff()
            return false
        }
        resetBackoff()
        isLocked = false
        return true
    }

    func unlockWithBiometrics() async {
        guard biometricsEnabled, isEnabled else { return }
        let context = LAContext()
        if (try? await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Avaa LashKirja")) == true {
            resetBackoff()
            isLocked = false
        }
    }

    private func saveBackoff() {
        if let data = try? JSONEncoder().encode(Backoff(failures: failures, waitUntil: waitUntil)) { write("backoff", data) }
    }

    private func resetBackoff() {
        failures = 0
        waitUntil = nil
        delete("backoff")
    }

    /// Stretched: 100 000 rounds, so a copied hash of a 4-digit PIN is not cracked in an instant.
    private static func hash(salt: String, pin: String) -> String {
        var digest = Data(SHA256.hash(data: Data("\(salt):\(pin)".utf8)))
        for _ in 0..<rounds { digest = Data(SHA256.hash(data: digest + Data(salt.utf8))) }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var item: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess ? item as? Data : nil
    }
    @discardableResult
    private func write(_ account: String, _ data: Data) -> Bool {
        delete(account)
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    private func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}

struct LockScreen: View {
    @Environment(AppModel.self) private var app
    @State private var lock = AppLock.shared
    @State private var pin = ""
    @State private var wrong = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.fill").font(.system(size: 40)).foregroundStyle(Theme.accent)
            Text("LashKirja on lukittu").font(.title3.weight(.semibold))
            SecureField("PIN", text: $pin)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .multilineTextAlignment(.center)
                .font(.title2.monospacedDigit())
                .frame(maxWidth: 200)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .focused($focused)
                .onSubmit { attempt() }
            Button("Avaa") { attempt() }.buttonStyle(.borderedProminent).tint(Theme.ink)
            if wrong {
                Text(lock.waitUntil.map { $0 > Date() ? "Väärä PIN. Odota hetki ennen uutta yritystä." : "Väärä PIN" } ?? "Väärä PIN")
                    .foregroundStyle(Theme.danger).font(.footnote)
            }
            if lock.biometricsEnabled {
                Button { Task { await lock.unlockWithBiometrics() } } label: { Label("Face ID", systemImage: "faceid") }
            }
            // Forgot the PIN: signing out removes the lock; signing in again needs the password.
            Button("Unohditko PIN-koodin? Kirjaudu ulos", role: .destructive) {
                lock.disable()
                Task { await app.logout() }
            }
            .font(.footnote)
            .padding(.top, 12)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas.ignoresSafeArea())
        .task {
            if lock.biometricsEnabled { await lock.unlockWithBiometrics() }
            focused = lock.isLocked
        }
    }

    private func attempt() {
        if lock.unlock(pin: pin) { Haptics.success(); wrong = false }
        else { Haptics.error(); wrong = true; pin = "" }
    }
}

struct AppLockSettingsView: View {
    @State private var lock = AppLock.shared
    @State private var newPin = ""
    @State private var confirmPin = ""
    @State private var enabled = AppLock.shared.isEnabled
    @State private var message: String?

    var body: some View {
        Form {
            if enabled {
                Section {
                    Text("Sovellus lukittuu, kun palaat siihen taustalta.")
                    if lock.biometricsAvailable {
                        Toggle("Avaa Face ID:llä", isOn: Binding(get: { lock.biometricsEnabled }, set: { lock.biometricsEnabled = $0 }))
                    }
                    Button("Poista lukitus", role: .destructive) { lock.disable(); enabled = false }
                }
            } else {
                Section {
                    SecureField("Uusi PIN (4–8 numeroa)", text: $newPin).keyboardType(.numberPad)
                    SecureField("PIN uudelleen", text: $confirmPin).keyboardType(.numberPad)
                    Button("Ota lukitus käyttöön") {
                        guard AppLockPolicy.acceptable(newPin) else { message = "PIN on 4–8 numeroa."; return }
                        guard newPin == confirmPin else { message = "PIN-koodit eivät täsmää."; return }
                        guard lock.setPIN(newPin) else { message = "Lukituksen tallennus epäonnistui. Yritä uudelleen."; return }
                        enabled = true
                        message = nil
                        Haptics.success()
                    }
                }
            }
            if let message { Text(message).foregroundStyle(Theme.danger) }
        }
        .navigationTitle("Sovelluslukitus")
    }
}
