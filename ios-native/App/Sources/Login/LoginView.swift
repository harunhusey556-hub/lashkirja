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
    /// The address's own check, shown under the field before anything is sent.
    @State private var emailProblem: String?
    @FocusState private var focus: Field?
    @State private var showPassword = false
    private enum Field { case email, password }
    /// The recovery screen, opened from the link below or from a `lashkirja://…?token=…` link.
    @State private var recovery: Recovery?
    /// False until the server says passkeys work for this app, so the button only ever appears
    /// (never appears and then fails).
    @State private var passkeyReady = false
    @State private var passkeyBusy = false
    /// A passkey problem the owner can do nothing about here (not configured): a note, not an error.
    @State private var info: String?
    /// After a password sign-in: the session is stored, and the app opens once the offer is answered.
    @State private var offer: Offer?
    /// False until the server says it creates accounts: any doubt keeps "Luo tili" hidden.
    @State private var signupEnabled = false
    @State private var signingUp = false

    struct Offer {
        let user: AuthUser
        /// The password just typed, kept only while the offer shows: creating a passkey needs a
        /// fresh password confirmation, and this sign-in is one.
        let password: String
        var busy = false
        var message: String?
        var created = false
    }

    struct Recovery: Identifiable, Hashable {
        let id = UUID()
        let step: PasswordRecoveryView.Step
        let link: String
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    brand
                    if let offer {
                        offerCard(offer)
                    } else {
                        notices
                        if passkeyReady { passkeyButton }
                        form
                        if signupEnabled { signUpButton }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 24)
                .padding(.bottom, 24)
                .frame(maxWidth: 460, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.canvas.ignoresSafeArea())
            // The sign-in button rides above the keyboard, so it never hides under it.
            .safeAreaInset(edge: .bottom) {
                if offer == nil { AuthBottomBar { passwordButton } }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(item: $recovery) { r in
                PasswordRecoveryView(step: r.step, email: email, link: r.link)
            }
            .navigationDestination(isPresented: $signingUp) {
                SignUpView(email: email) { user, address, typed in
                    signingUp = false
                    email = address
                    Task {
                        busy = true
                        defer { busy = false }
                        await afterSignIn(user, email: address, password: typed)
                    }
                }
            }
        }
        // A reset link handed to the app (lashkirja://palauta-salasana?token=…), caught at the
        // root so it also arrives when the link opened the app before this screen showed.
        .onChange(of: app.pendingResetLink, initial: true) { _, link in
            guard let link else { return }
            app.pendingResetLink = nil
            signingUp = false
            recovery = Recovery(step: .reset, link: link)
        }
        .task { await checkPasskeys() }
        .task { await checkSignup() }
    }

    /// Small and quiet: the screen is about signing in, not the logo.
    private var brand: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "book.closed.fill")
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text("LashKirja").font(.headline).foregroundStyle(Theme.ink)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(offer == nil ? "Kirjaudu sisään" : "Olet kirjautunut")
                    .font(.largeTitle.bold())
                    .foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Kirjanpito yksinkertaisesti")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
            }
        }
    }

    @ViewBuilder private var notices: some View {
        if let info, failure == nil {
            Label(info, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
        if let message = failure ?? notice {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            AuthField(label: "Sähköposti", problem: emailProblem, focused: focus == .email) {
                TextField("Sähköposti", text: $email, prompt: Text("nimi@yritys.fi"))
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            AuthField(label: "Salasana", focused: focus == .password) {
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
                ShowPasswordButton(shown: $showPassword)
            }
            Button("Unohditko salasanan?") {
                recovery = Recovery(step: .request, link: "")
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.accent)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .onChange(of: email) { emailProblem = nil }
        // A typo in the address shows as soon as the owner moves on, not only after a failed sign-in.
        .onChange(of: focus) { old, _ in
            if old == .email, !email.isEmpty { emailProblem = EmailCheck.problem(email) }
        }
    }

    /// Under the form and never a primary: most people opening the app already have an account.
    private var signUpButton: some View {
        VStack(spacing: 8) {
            Text("Eikö sinulla ole vielä tiliä?")
                .font(.subheadline)
                .foregroundStyle(Theme.ink2)
            Button { signingUp = true } label: {
                Text("Luo tili")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(OutlineButtonStyle())
            .disabled(busy || passkeyBusy)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    @ViewBuilder private var passwordButton: some View {
        let button = Button {
            Task { await submit() }
        } label: {
            AuthButtonLabel(title: "Kirjaudu sisään", busyTitle: "Kirjaudutaan…", busy: busy,
                            spinnerTint: passkeyReady ? Theme.ink : Theme.onInk)
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
                .frame(maxWidth: .infinity, minHeight: 52)
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
                    .frame(maxWidth: .infinity, minHeight: 52)
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
        emailProblem = EmailCheck.problem(email)
        if emailProblem != nil {
            Haptics.error()
            focus = .email
            return
        }
        // The keyboard goes as soon as the owner taps sign in, not only once the app opens.
        focus = nil
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let user = try await app.auth.login(email: email, password: password)
            await afterSignIn(user, email: email, password: password)
        } catch let problem as LKError {
            failure = problem.message
            Haptics.error()
        } catch {
            failure = LKError.unreachable
        }
    }

    /// A password sign-in or a new account: the passkey offer once, otherwise straight in.
    private func afterSignIn(_ user: AuthUser, email: String, password: String) async {
        if await shouldOfferPasskey(email: email) {
            UserDefaults.standard.set(true, forKey: PasskeyOffer.key(email: email))
            Haptics.success()
            offer = Offer(user: user, password: password)
            self.password = ""
            return
        }
        app.enter(user)
    }
}

extension LoginView {
    /// Fail closed: offline, an error or a server without the route keeps the button hidden.
    private func checkSignup() async {
        signupEnabled = (try? await app.auth.signupStatus())?.enabled == true
    }

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
