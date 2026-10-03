import SwiftUI
import UIKit
import LashKirjaCore

/// Salasanan palautus (/unohtunut-salasana) and the new password (/palauta-salasana), pushed
/// from the sign-in screen. The mail has a link and a 6-digit code: here the owner types or
/// pastes the code (the same boxes as the sign-up), or pastes the link (or its token), and a
/// `lashkirja://…?token=…` link opens this screen with the token filled in.
struct PasswordRecoveryView: View {
    enum Step: Hashable { case request, reset }
    /// How the reset proves the mail was read: its code (with the address) or its link.
    private enum Proof: Hashable { case code, link }
    private enum Field: Hashable { case email, link, password, again }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var step: Step
    @State var email: String
    @State var link: String

    @State private var proof: Proof
    @State private var code = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var emailProblem: String?
    @State private var sent: ForgotPasswordResponse?
    @State private var password = ""
    @State private var again = ""
    @State private var errors = PasswordReset.Errors()
    @State private var done = false
    @FocusState private var focus: Field?
    @FocusState private var codeFocused: Bool

    init(step: Step = .request, email: String = "", link: String = "") {
        _step = State(initialValue: step)
        _email = State(initialValue: email)
        _link = State(initialValue: link)
        _proof = State(initialValue: link.isEmpty ? .code : .link)
    }

    var body: some View {
        Group {
            if step == .reset && !done {
                resetScreen
            } else {
                Form {
                    if done { doneSection } else { requestSections }
                }
                .scrollContentBackground(.hidden)
                .background(Theme.canvas)
            }
        }
        .navigationTitle(step == .request ? "Salasanan palautus" : "Uusi salasana")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(busy)
    }

    // MARK: Request a link

    @ViewBuilder private var requestSections: some View {
        if let sent {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label(sent.mailSent ? "Tarkista sähköpostisi" : "Palautuslinkkiä ei lähetetty",
                          systemImage: sent.mailSent ? "envelope.badge" : "envelope.badge.shield.half.filled")
                        .font(.headline)
                        .foregroundStyle(Theme.ink)
                    Text(sent.text).font(.subheadline).foregroundStyle(Theme.ink2)
                }
                .padding(.vertical, 4)
                Button("Lähetä uudelleen") { self.sent = nil }
            }
            if sent.mailSent {
                Section {
                    Button("Minulla on koodi tai linkki") { switchTo(.reset) }
                } footer: {
                    Text("Syötä viestin 6-numeroinen koodi tähän sovellukseen, tai avaa viestin linkki.")
                }
            }
        } else {
            Section {
                TextField("Sähköposti", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .onSubmit { Task { await requestLink() } }
            } header: {
                Text("Sähköposti")
            } footer: {
                Text("Kirjoita tilisi sähköpostiosoite. Jos tili löytyy, saat postiin linkin ja koodin, joilla valitset uuden salasanan. Jos viestiä ei tule, ota yhteyttä tukeen.")
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            Section {
                Button { Task { await requestLink() } } label: {
                    busyLabel("Lähetä linkki", busyText: "Lähetetään…")
                }
                .disabled(busy)
                Button("Minulla on jo koodi tai linkki") { switchTo(.reset) }
            }
        }
    }

    // MARK: Choose the new password

    private var resetScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Picker("Palautustapa", selection: $proof) {
                    Text("Koodi").tag(Proof.code)
                    Text("Linkki").tag(Proof.link)
                }
                .pickerStyle(.segmented)
                if proof == .code { codeFields } else { linkField }
                Text("Koodi ja linkki ovat voimassa 30 minuuttia.")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
                AuthField(label: "Uusi salasana", problem: errors.password, focused: focus == .password) {
                    SecureField("Uusi salasana", text: $password)
                        .textContentType(.newPassword)
                        .focused($focus, equals: .password)
                        .submitLabel(.next)
                        .onSubmit { focus = .again }
                }
                AuthField(label: "Toista uusi salasana", problem: errors.repeat, focused: focus == .again) {
                    SecureField("Toista uusi salasana", text: $again)
                        .textContentType(.newPassword)
                        .focused($focus, equals: .again)
                        .submitLabel(.done)
                        .onSubmit { Task { await reset() } }
                }
                Text("Vähintään \(PasswordReset.minLength) merkkiä.")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
                if let failure {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(failure, systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Pyydä uusi viesti") { switchTo(.request) }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                            .frame(minHeight: 44)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .frame(maxWidth: 460, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            AuthBottomBar {
                Button { Task { await reset() } } label: {
                    AuthButtonLabel(title: "Tallenna salasana", busyTitle: "Tallennetaan…", busy: busy)
                }
                .buttonStyle(.primary)
                .disabled(busy)
            }
        }
        .onChange(of: email) { emailProblem = nil }
        .onChange(of: password) { errors.password = nil }
        .onChange(of: again) { errors.repeat = nil }
        // A code typed or pasted into the link field belongs in the code boxes.
        .onChange(of: link) { _, text in
            guard PasswordReset.token(from: text) == nil, let found = AccountCode.extract(text) else { return }
            link = ""
            code = found
            proof = .code
        }
    }

    /// The code alone does not say whose it is; the link's token does, so the code needs the address.
    private var codeFields: some View {
        VStack(alignment: .leading, spacing: 20) {
            AuthField(label: "Tilin sähköposti", problem: emailProblem, focused: focus == .email) {
                TextField("Tilin sähköposti", text: $email, prompt: Text("nimi@yritys.fi"))
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { codeFocused = true }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Koodi sähköpostista")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .accessibilityHidden(true)
                AccountCodeField(
                    code: $code,
                    focus: $codeFocused,
                    onComplete: { _ in
                        // The new password is still needed: the code moves the owner on to it.
                        if password.isEmpty { focus = .password }
                    },
                    onPasteOther: { text in
                        // The mail's link pasted here: take it as the link instead.
                        guard PasswordReset.token(from: text) != nil else { return false }
                        link = text
                        proof = .link
                        return true
                    })
            }
        }
        .onAppear { if !email.isEmpty, code.isEmpty { codeFocused = true } }
    }

    private var linkField: some View {
        VStack(alignment: .leading, spacing: 8) {
            AuthField(label: "Palautuslinkki", focused: focus == .link) {
                TextField("Palautuslinkki", text: $link, prompt: Text("https://…"), axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...3)
                    .focused($focus, equals: .link)
            }
            // The system's paste button reads the clipboard without the "Allow Paste" prompt.
            PasteButton(payloadType: String.self) { strings in
                let text = strings.first ?? ""
                Task { @MainActor in link = text }
            }
            .buttonBorderShape(.capsule)
            .tint(Theme.ink)
        }
    }

    private var doneSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Salasana vaihdettu", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.success)
                Text("Voit nyt kirjautua sisään uudella salasanalla. Kaikki laitteet kirjattiin ulos.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
            }
            .padding(.vertical, 4)
            Button("Kirjaudu sisään") { dismiss() }
        }
    }

    private func busyLabel(_ text: String, busyText: String) -> some View {
        HStack {
            Text(busy ? busyText : text)
            if busy { Spacer(); ProgressView() }
        }
    }

    private func switchTo(_ next: Step) {
        failure = nil
        emailProblem = nil
        errors = PasswordReset.Errors()
        step = next
    }

    private func requestLink() async {
        guard !busy else { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else {
            failure = "Kirjoita sähköpostiosoite."
            Haptics.error()
            return
        }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let answer: ForgotPasswordResponse = try await app.api.send("POST", "/api/auth/password/forgot", body: ForgotPasswordBody(email: address))
            Haptics.success()
            sent = answer
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }

    private func reset() async {
        guard !busy else { return }
        failure = nil
        let digits = proof == .code ? AccountCode.normalize(code) : nil
        let token = proof == .link ? PasswordReset.token(from: link) : nil
        errors = PasswordReset.validate(password: password, repeat: again)
        if proof == .code {
            emailProblem = EmailCheck.problem(email)
            if digits == nil { failure = "Syötä sähköpostin 6-numeroinen koodi." }
        } else if token == nil {
            failure = "Linkki puuttuu tai on vanhentunut. Pyydä uusi palautusviesti."
        }
        guard failure == nil, emailProblem == nil, errors.isValid else {
            Haptics.error()
            return
        }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        focus = nil
        codeFocused = false
        busy = true
        defer { busy = false }
        do {
            if let digits {
                try await app.auth.resetWithCode(email: address, code: digits, password: password)
            } else if let token {
                let _: Ignored = try await app.api.send("POST", "/api/auth/password/reset", body: ResetPasswordBody(token: token, password: password))
            }
            Haptics.success()
            password = ""
            again = ""
            done = true
        } catch is CancellationError {
        } catch let error as LKError where digits != nil {
            Haptics.error()
            code = ""
            failure = AccountCodeFailure(error).message(serverMessage: error.message)
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}
