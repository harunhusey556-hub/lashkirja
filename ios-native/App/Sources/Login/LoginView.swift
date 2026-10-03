import SwiftUI
import AuthenticationServices
import LashKirjaCore

struct LoginView: View {
    @Environment(AppModel.self) private var app
    let notice: String?
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focus: Field?
    @State private var showPassword = false
    private enum Field { case email, password }
    /// The recovery sheet, opened from the link below or from a `lashkirja://…?token=…` link.
    @State private var recovery: Recovery?
    /// False until the server says passkeys work for this app, so the button only ever appears
    /// (never appears and then fails).
    @State private var passkeyReady = false
    @State private var passkeyBusy = false
    /// A passkey problem the owner can do nothing about here (not configured): a note, not an error.
    @State private var info: String?
    /// After a password sign-in: the session is stored, and the app opens once the offer is answered.
    @State private var offer: Offer?

    struct Offer {
        let user: AuthUser
        /// The password just typed, kept only while the offer shows: creating a passkey needs a
        /// fresh password confirmation, and this sign-in is one.
        let password: String
        var busy = false
        var message: String?
        var created = false
    }

    struct Recovery: Identifiable {
        let id = UUID()
        let step: PasswordRecoveryView.Step
        let link: String
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 10) {
                    Image(systemName: "book.closed.fill")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 60, height: 60)
                        .background(Theme.accentFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .shadow(color: Theme.accentFill.opacity(0.25), radius: 12, y: 6)
                    Text("LashKirja").font(.largeTitle.bold()).foregroundStyle(Theme.ink)
                    Text("Kirjanpito yksinkertaisesti").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                .padding(.top, 48)

                if let offer {
                    offerCard(offer)
                } else {
                    if passkeyReady { passkeyButton }
                    form
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.canvas.ignoresSafeArea())
        .sheet(item: $recovery) { r in
            PasswordRecoveryView(step: r.step, email: email, link: r.link)
        }
        // A reset link handed to the app (lashkirja://palauta-salasana?token=…), caught at the
        // root so it also arrives when the link opened the app before this screen showed.
        .onChange(of: app.pendingResetLink, initial: true) { _, link in
            guard let link else { return }
            app.pendingResetLink = nil
            recovery = Recovery(step: .reset, link: link)
        }
        .task { await checkPasskeys() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let info, failure == nil {
                Text(info)
                    .font(.footnote)
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            }
            if let message = failure ?? notice {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
            Text("Kirjaudu sisään").font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
            HStack(spacing: 10) {
                Image(systemName: "envelope").foregroundStyle(Theme.ink2).frame(width: 20)
                TextField("Sähköposti", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            .loginField(focused: focus == .email)
            HStack(spacing: 10) {
                Image(systemName: "lock").foregroundStyle(Theme.ink2).frame(width: 20)
                Group {
                    if showPassword {
                        TextField("Salasana", text: $password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        SecureField("Salasana", text: $password)
                    }
                }
                .textContentType(.password)
                .focused($focus, equals: .password)
                .submitLabel(.go)
                .onSubmit { Task { await submit() } }
                Button { showPassword.toggle() } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(Theme.ink2)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(showPassword ? "Piilota salasana" : "Näytä salasana")
            }
            .loginField(focused: focus == .password)
            passwordButton
            Button("Unohditko salasanan?") {
                recovery = Recovery(step: .request, link: "")
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.accent)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .padding(20)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    @ViewBuilder private var passwordButton: some View {
        let button = Button {
            Task { await submit() }
        } label: {
            ZStack {
                Text("Kirjaudu sisään").opacity(busy ? 0 : 1)
                if busy { ProgressView().tint(passkeyReady ? Theme.ink : Theme.onInk) }
            }
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .disabled(busy || passkeyBusy || email.isEmpty || password.isEmpty)
        // One primary per screen: with a passkey offered, the passkey button is the primary.
        if passkeyReady { button.buttonStyle(OutlineButtonStyle()) } else { button.buttonStyle(.primary) }
    }

    /// "Kirjaudu pääsyavaimella" and the "tai salasanalla" divider (LoginForm.tsx).
    private var passkeyButton: some View {
        VStack(spacing: 16) {
            Button { Task { await passkeySignIn() } } label: {
                HStack(spacing: 8) {
                    if passkeyBusy {
                        ProgressView().tint(Theme.onInk)
                        Text("Odotetaan pääsyavainta…")
                    } else {
                        Image(systemName: "person.badge.key.fill")
                        Text("Kirjaudu pääsyavaimella")
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.primary)
            .disabled(passkeyBusy || busy)
            HStack(spacing: 12) {
                Rectangle().fill(Theme.line).frame(height: 1)
                Text("tai salasanalla").font(.caption).foregroundStyle(Theme.ink2).fixedSize()
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            .accessibilityHidden(true)
        }
    }

    /// The one-time offer after a password sign-in. Both choices continue into the app.
    private func offerCard(_ offer: Offer) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "person.badge.key")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 56, height: 56)
                .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(spacing: 8) {
                Text(PasskeyOffer.title).font(.headline).foregroundStyle(Theme.ink)
                Text(PasskeyOffer.text).font(.subheadline).foregroundStyle(Theme.ink2)
            }
            .multilineTextAlignment(.center)
            if offer.created {
                Label(PasskeyOffer.created, systemImage: "checkmark.circle")
                    .font(.footnote).foregroundStyle(Theme.success)
            } else if let message = offer.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
            VStack(spacing: 8) {
                Button { Task { await createOfferedPasskey() } } label: {
                    HStack(spacing: 8) {
                        if offer.busy { ProgressView().tint(Theme.onInk) }
                        Text(offer.busy ? "Luodaan…" : "Luo pääsyavain")
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.primary)
                .disabled(offer.busy || offer.created)
                Button("Ei nyt") { leaveAfterSignIn() }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(offer.busy || offer.created)
            }
        }
        .padding(24)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func submit() async {
        guard !busy else { return }
        // The keyboard goes as soon as the owner taps sign in, not only once the app opens.
        focus = nil
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let user = try await app.auth.login(email: email, password: password)
            if await shouldOfferPasskey(email: email) {
                UserDefaults.standard.set(true, forKey: PasskeyOffer.key(email: email))
                Haptics.success()
                offer = Offer(user: user, password: password)
                password = ""
                return
            }
            app.enter(user)
        } catch let problem as LKError {
            failure = problem.message
            Haptics.error()
        } catch {
            failure = LKError.unreachable
        }
    }
}

extension LoginView {
    /// The server's `native` flag also needs its associated-domains file for this app.
    private func checkPasskeys() async {
        guard let status: PasskeyStatus = try? await app.api.get("/api/auth/passkey/status") else { return }
        passkeyReady = status.native
    }

    private func passkeySignIn() async {
        guard !passkeyBusy, !busy else { return }
        passkeyBusy = true
        failure = nil
        info = nil
        defer { passkeyBusy = false }

        let start: PasskeySignInStart
        do {
            start = try await app.auth.passkeyOptions()
        } catch is CancellationError {
            return
        } catch let error as LKError {
            return fail(PasskeySignInFailure.fromOptions(status: error.status), error.message)
        } catch {
            return fail(.failed)
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: start.rpId)
        // No allowed credentials: a usernameless request, so the system offers every passkey
        // this device has for the domain.
        let request = provider.createCredentialAssertionRequest(challenge: start.challenge)
        request.userVerificationPreference = .required
        let assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion
        do {
            let authorization = try await PasskeyCeremony(anchor: PasskeyCeremony.keyWindow()).perform(request)
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                return fail(.failed)
            }
            assertion = credential
        } catch {
            return fail(PasskeySignInFailure(ceremony: PasskeyCeremony.failure(error)))
        }

        let verify = PasskeySignInVerify(
            challengeId: start.challengeId,
            credentialId: assertion.credentialID,
            clientDataJSON: assertion.rawClientDataJSON,
            authenticatorData: assertion.rawAuthenticatorData,
            signature: assertion.signature,
            userHandle: assertion.userID)
        do {
            app.enter(try await app.auth.passkeySignIn(verify))
        } catch is CancellationError {
        } catch let error as LKError where error.code == "KEYCHAIN" {
            // Signed in on the server but the phone could not keep the session: say so, not "offline".
            Haptics.error()
            failure = error.message
        } catch let error as LKError {
            fail(PasskeySignInFailure.fromVerify(status: error.status), error.message)
        } catch {
            fail(.failed)
        }
    }

    private func fail(_ reason: PasskeySignInFailure, _ serverMessage: String? = nil) {
        guard let text = reason.message(serverMessage: serverMessage) else { return } // cancelled
        Haptics.error()
        if reason.hidesButton {
            passkeyReady = false
            info = text
        } else {
            failure = text
        }
    }

    /// Once per account on this device, when it can make a passkey and the account has none.
    /// Any doubt (offline, slow, an error) skips the offer, so it never blocks signing in.
    private func shouldOfferPasskey(email: String) async -> Bool {
        let seen = UserDefaults.standard.bool(forKey: PasskeyOffer.key(email: email))
        guard PasskeyOffer.shouldOffer(passkeysReady: passkeyReady, email: email, seen: seen, passkeyCount: 0) else { return false }
        let api = app.api
        let count: Int? = await withTaskGroup(of: Int?.self) { group in
            group.addTask {
                let list: PasskeyList? = try? await api.get("/api/auth/passkey")
                return list?.passkeys.count
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(PasskeyOffer.listTimeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        return PasskeyOffer.shouldOffer(passkeysReady: passkeyReady, email: email, seen: seen, passkeyCount: count)
    }

    private func createOfferedPasskey() async {
        guard var current = offer, !current.busy else { return }
        current.busy = true
        current.message = nil
        offer = current
        let result = await PasskeyRegistration.create(api: app.api, password: current.password)
        current.busy = false
        switch result {
        case .success:
            Haptics.success()
            current.created = true
            offer = current
            // Long enough to read that it worked; the app opens either way.
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            leaveAfterSignIn()
        case .failure(let problem):
            if problem.text != nil { Haptics.error() }
            current.message = problem.text
            offer = current
        }
    }

    private func leaveAfterSignIn() {
        guard let user = offer?.user else { return }
        offer = nil
        app.enter(user)
    }
}

/// The password button when the passkey button is the primary one.
private struct OutlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.ink.opacity(isEnabled ? 1 : 0.4))
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(Theme.canvas.opacity(configuration.isPressed ? 0.6 : 1), in: Capsule())
            .overlay(Capsule().stroke(Theme.line))
            .contentShape(Capsule())
    }
}

private extension View {
    func loginField(focused: Bool = false) -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(focused ? Theme.accent : Theme.line, lineWidth: focused ? 1.5 : 1))
    }
}
