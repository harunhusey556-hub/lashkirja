import SwiftUI
import UIKit
import AuthenticationServices
import LashKirjaCore

/// Pääsyavaimet (/asetukset/turvallisuus/paasyavaimet): list, rename and delete, and
/// create one with the system passkey sheet when the server and the build allow it.
struct PasskeysView: View {
    @Environment(AppModel.self) private var app
    @State private var rows: Loadable<[Passkey]> = .idle
    @State private var canCreate: Bool?
    @State private var message: String?
    @State private var success: String?
    @State private var renaming: Passkey?
    @State private var newName = ""
    @State private var deleting: Passkey?
    @State private var creating = false

    var body: some View {
        List {
            Section {
                Text("Pääsyavaimella kirjaudut Face ID:llä tai Touch ID:llä ilman salasanaa. Salasana toimii edelleen varalla.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            }
            if let list = rows.value {
                Section {
                    if list.isEmpty {
                        Text("Ei pääsyavaimia vielä.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(list) { key in
                        HStack(spacing: 12) {
                            Image(systemName: "person.badge.key").foregroundStyle(Theme.ink2).frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(key.deviceName).foregroundStyle(Theme.ink)
                                Text(key.detail).font(.caption).foregroundStyle(Theme.ink2)
                            }
                        }
                        .swipeActions {
                            Button("Poista", role: .destructive) { deleting = key }
                            Button("Nimeä") { newName = key.deviceName; renaming = key }.tint(Theme.neutralFill)
                        }
                        .contextMenu {
                            Button { newName = key.deviceName; renaming = key } label: { Label("Nimeä", systemImage: "pencil") }
                            Button(role: .destructive) { deleting = key } label: { Label("Poista", systemImage: "trash") }
                        }
                    }
                } header: {
                    Text("Tallennetut pääsyavaimet")
                } footer: {
                    if let message {
                        Text(message).foregroundStyle(Theme.danger)
                    } else if let success {
                        Text(success).foregroundStyle(Theme.success)
                    }
                }
                createSection
            } else {
                LoadState(state: rows, retry: load) { (_: [Passkey]) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Pääsyavaimet")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if rows.value == nil { await load() } }
        .sheet(isPresented: $creating) {
            CreatePasskeySheet { created in
                if case .loaded(let list) = rows { rows = .loaded(list + [created]) }
                message = nil
                success = "Pääsyavain luotu."
            }
        }
        .alert("Pääsyavaimen nimi", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { key in
            TextField("Nimi", text: $newName)
            Button("Tallenna") { Task { await rename(key) } }
            Button("Peru", role: .cancel) {}
        }
        .confirmationDialog(
            "Poistetaanko pääsyavain?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { key in
            Button("Poista", role: .destructive) { Task { await delete(key) } }
        } message: { key in
            Text("\(key.deviceName) ei enää kirjaa sinua sisään. Poista se myös laitteen salasanoista, jos et tarvitse sitä. Salasana toimii edelleen.")
        }
    }

    @ViewBuilder private var createSection: some View {
        if canCreate == true {
            Section {
                Button { message = nil; success = nil; creating = true } label: {
                    Label("Luo pääsyavain", systemImage: "person.badge.key.fill")
                }
            }
        } else if canCreate == false {
            Section {
                Text("Tällä laitteella ei voi luoda pääsyavainta juuri nyt: palvelinta ei ole vielä määritetty pääsyavaimille tai laite ei tue niitä. Kirjaudu salasanalla.")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
            }
        }
    }

    private func load() async {
        do {
            let list: PasskeyList = try await app.api.get("/api/auth/passkey")
            rows = .loaded(list.passkeys)
        } catch is CancellationError {
            return
        } catch {
            rows = .failed(error.userMessage)
        }
        // `native` also needs the server's associated-domains file for this app.
        if let status: PasskeyStatus = try? await app.api.get("/api/auth/passkey/status") {
            canCreate = status.native
        } else {
            canCreate = false
        }
    }

    private func rename(_ key: Passkey) async {
        if let problem = PasskeyName.validate(newName) {
            message = problem
            Haptics.error()
            return
        }
        let body = PasskeyRenameBody(deviceName: newName)
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/auth/passkey/\(key.id)", body: body)
            if case .loaded(var list) = rows, let index = list.firstIndex(where: { $0.id == key.id }) {
                list[index].deviceName = body.deviceName
                rows = .loaded(list)
            }
            Haptics.success()
            message = nil
            success = "Nimi tallennettu."
        } catch is CancellationError {
        } catch {
            Haptics.error()
            message = error.userMessage
        }
    }

    private func delete(_ key: Passkey) async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/auth/passkey/\(key.id)", body: Optional<EmptyBody>.none)
            if case .loaded(let list) = rows { rows = .loaded(list.filter { $0.id != key.id }) }
            Haptics.success()
            message = nil
            success = "Pääsyavain poistettu."
        } catch is CancellationError {
        } catch {
            Haptics.error()
            message = error.userMessage
        }
    }
}

/// The current password first (a session alone cannot add a way to sign in),
/// then the system's passkey sheet, then the server's check.
private struct CreatePasskeySheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onCreated: (Passkey) -> Void
    @State private var password = ""
    @State private var passwordError: String?
    @State private var message: String?
    @State private var busy = false
    @State private var ceremony: PasskeyCeremony?

    private struct OptionsBody: Encodable { let currentPassword: String }
    private struct Created: Decodable { let passkey: Passkey }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Nykyinen salasana", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit { Task { await create() } }
                        .disabled(busy)
                    if let passwordError { Text(passwordError).font(.footnote).foregroundStyle(Theme.danger) }
                } footer: {
                    Text("Pääsyavain on uusi tapa kirjautua tilillesi, joten vahvista ensin nykyinen salasanasi. Sen jälkeen laite pyytää Face ID:n tai Touch ID:n.")
                }
                if let message {
                    Section { Text(message).foregroundStyle(Theme.danger) }
                }
                Section {
                    Button { Task { await create() } } label: {
                        HStack {
                            Text(busy ? "Luodaan…" : "Jatka")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Vahvista salasanalla")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Peru") { dismiss() }.disabled(busy) }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func fail(_ reason: PasskeyFailure, _ serverMessage: String? = nil) {
        guard let text = reason.message(serverMessage: serverMessage) else { return }
        Haptics.error()
        if reason == .password { passwordError = text } else { message = text }
    }

    private func create() async {
        guard !busy else { return }
        guard !password.isEmpty else {
            passwordError = "Kirjoita nykyinen salasana."
            Haptics.error()
            return
        }
        busy = true
        passwordError = nil
        message = nil
        defer { busy = false; ceremony = nil }

        let start: PasskeyRegistrationStart
        do {
            start = try await app.api.send("POST", "/api/auth/passkey/register/options", body: OptionsBody(currentPassword: password))
        } catch is CancellationError {
            return
        } catch let error as LKError {
            fail(PasskeyFailure.from(status: error.status), error.message)
            return
        } catch {
            fail(.failed)
            return
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: start.rpId)
        let request = provider.createCredentialRegistrationRequest(challenge: start.challenge, name: start.userName, userID: start.userId)
        if let name = start.displayName, !name.isEmpty { request.displayName = name }
        request.userVerificationPreference = .required
        if !start.excludedCredentialIds.isEmpty {
            request.excludedCredentials = start.excludedCredentialIds.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }

        let runner = PasskeyCeremony(anchor: Self.anchor())
        ceremony = runner
        let registration: ASAuthorizationPlatformPublicKeyCredentialRegistration
        do {
            let authorization = try await runner.perform(request)
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
                fail(.failed)
                return
            }
            registration = credential
        } catch {
            fail(PasskeyCeremony.failure(error))
            return
        }
        guard let attestation = registration.rawAttestationObject else {
            fail(.failed)
            return
        }

        let verify = PasskeyRegistrationVerify(
            challengeId: start.challengeId,
            credentialId: registration.credentialID,
            clientDataJSON: registration.rawClientDataJSON,
            attestationObject: attestation)
        do {
            let created: Created = try await app.api.send("POST", "/api/auth/passkey/register/verify", body: verify)
            Haptics.success()
            password = ""
            onCreated(created.passkey)
            dismiss()
        } catch is CancellationError {
        } catch let error as LKError {
            Haptics.error()
            message = error.message
        } catch {
            fail(.failed)
        }
    }

    /// The window the system sheet attaches to.
    private static func anchor() -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
    }
}

/// One ASAuthorizationController request as an async call.
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var controller: ASAuthorizationController?
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
        super.init()
    }

    @MainActor
    func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
        self.controller = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
        self.controller = nil
    }

    /// The system's error as the web's reasons (ios/App/App/PasskeyPlugin.swift).
    static func failure(_ error: Error) -> PasskeyFailure {
        let nsError = error as NSError
        guard nsError.domain == ASAuthorizationError.errorDomain else { return .failed }
        if nsError.code == ASAuthorizationError.Code.canceled.rawValue { return .cancelled }
        if nsError.code == 1006 { return .exists } // matchedExcludedCredential
        let text = nsError.localizedDescription.lowercased()
        // A build without the associated-domains entitlement, or a server without the AASA file.
        if text.contains("associated") { return .notConfigured }
        return .failed
    }
}
