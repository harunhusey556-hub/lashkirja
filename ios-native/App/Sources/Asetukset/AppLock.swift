import SwiftUI
import CryptoKit
import LocalAuthentication
import Security
import LashKirjaCore

/// The app lock: a PIN (salted SHA-256 in the Keychain) and optional Face ID.
@MainActor
@Observable
final class AppLock {
    static let shared = AppLock()

    private(set) var isLocked = false
    private(set) var failures = 0
    private(set) var waitUntil: Date?
    private let service = "fi.tiyouba.lashkirja.lock"

    /// A cold start opens locked when a PIN is set.
    private init() { isLocked = read("pin") != nil }

    var isEnabled: Bool { read("pin") != nil }
    var biometricsEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "lock.biometrics") }
        set { UserDefaults.standard.set(newValue, forKey: "lock.biometrics") }
    }
    var biometricsAvailable: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }

    func lockIfEnabled() { if isEnabled { isLocked = true } }

    func setPIN(_ pin: String) {
        let salt = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        write("pin", Data("\(salt):\(Self.hash(salt: salt, pin: pin))".utf8))
    }

    func disable() {
        delete("pin")
        biometricsEnabled = false
        isLocked = false
    }

    func unlock(pin: String) -> Bool {
        if let waitUntil, waitUntil > Date() { return false }
        guard let stored = read("pin").map({ String(decoding: $0, as: UTF8.self) }) else { isLocked = false; return true }
        let parts = stored.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, Self.hash(salt: parts[0], pin: pin) == parts[1] else {
            failures += 1
            waitUntil = Date().addingTimeInterval(TimeInterval(AppLockPolicy.delay(afterFailures: failures)))
            return false
        }
        failures = 0
        waitUntil = nil
        isLocked = false
        return true
    }

    func unlockWithBiometrics() async {
        guard biometricsEnabled else { return }
        let context = LAContext()
        if (try? await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Avaa LashKirja")) == true {
            isLocked = false
            failures = 0
        }
    }

    private static func hash(salt: String, pin: String) -> String {
        SHA256.hash(data: Data("\(salt):\(pin)".utf8)).map { String(format: "%02x", $0) }.joined()
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
    private func write(_ account: String, _ data: Data) {
        delete(account)
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
    private func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}

struct LockScreen: View {
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
            if wrong { Text("Väärä PIN").foregroundStyle(Theme.danger).font(.footnote) }
            if lock.biometricsEnabled {
                Button { Task { await lock.unlockWithBiometrics() } } label: { Label("Face ID", systemImage: "faceid") }
            }
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
                        lock.setPIN(newPin)
                        enabled = true
                        Haptics.success()
                    }
                }
            }
            if let message { Text(message).foregroundStyle(Theme.danger) }
        }
        .navigationTitle("Sovelluslukitus")
    }
}
