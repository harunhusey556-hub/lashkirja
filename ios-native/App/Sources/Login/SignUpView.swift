import SwiftUI
import LashKirjaCore

/// Luo tili (/api/auth/signup/*), pushed from the sign-in screen in two steps: name, address
/// and password, then the 6-digit code from the mail. The right code signs in at once;
/// `onSignedIn` hands the session to the sign-in screen's own after-sign-in flow, so a new
/// account opens the app the same way a password sign-in does.
struct SignUpView: View {
    enum Step: Hashable { case details, code }
    private enum Field: Hashable { case name, email, password }

    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The user, the address and the password just chosen (the passkey offer needs it).
    let onSignedIn: (AuthUser, String, String) -> Void

    @State private var step: Step = .details
    @State private var firstName = ""
    @State private var email: String
    @State private var password = ""
    @State private var showPassword = false
    @State private var code = ""
    @State private var busy = false
    /// What the server refused; the field checks sit next to their fields.
    @State private var failure: String?
    @State private var nameProblem: String?
    @State private var emailProblem: String?
    @State private var passwordProblem: String?
    /// The server takes one new code a minute: the resend button waits until then.
    @State private var resendAt = Date.distantPast
    @State private var resent = false
    @FocusState private var focus: Field?
    @FocusState private var codeFocused: Bool

    init(email: String = "", onSignedIn: @escaping (AuthUser, String, String) -> Void) {
        _email = State(initialValue: email.trimmingCharacters(in: .whitespacesAndNewlines))
        self.onSignedIn = onSignedIn
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                if step == .details { details } else { codeStep }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .frame(maxWidth: 460, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) { bottomBar }
        .navigationTitle("Luo tili")
        .navigationBarTitleDisplayMode(.inline)
        // Step 2 goes back to step 1, not out of the sign-up; nothing leaves while a call runs.
        .navigationBarBackButtonHidden(busy || step == .code)
        .toolbar {
            if step == .code && !busy {
                ToolbarItem(placement: .topBarLeading) {
                    Button { changeAddress() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left").fontWeight(.semibold)
                            Text("Tiedot")
                        }
                    }
                    .accessibilityLabel("Takaisin tilin tietoihin")
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: step)
    }

    private var header: some View {
        let number = step == .details ? 1 : 2
        return VStack(alignment: .leading, spacing: 8) {
            Text("Vaihe \(number)/2")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.ink2)
            Text(step == .details ? "Tilin tiedot" : "Vahvista sähköposti")
                .font(.title2.bold())
                .foregroundStyle(Theme.ink)
            ProgressView(value: Double(number), total: 2)
                .tint(Theme.accent)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Step 1: name, address, password

    private var details: some View {
        VStack(alignment: .leading, spacing: 16) {
            AuthField(label: "Etunimi", problem: nameProblem, focused: focus == .name) {
                TextField("Etunimi", text: $firstName, prompt: Text("Esim. Maija"))
                    .textContentType(.givenName)
                    .focused($focus, equals: .name)
                    .submitLabel(.next)
                    .onSubmit { focus = .email }
            }
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
            VStack(alignment: .leading, spacing: 8) {
                AuthField(label: "Salasana", problem: passwordProblem, focused: focus == .password) {
                    Group {
                        if showPassword {
                            TextField("Salasana", text: $password)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            SecureField("Salasana", text: $password)
                        }
                    }
                    // .newPassword lets iOS suggest a strong password and save it for the address.
                    .textContentType(.newPassword)
                    .focused($focus, equals: .password)
                    .submitLabel(.send)
                    .onSubmit { Task { await start() } }
                    ShowPasswordButton(shown: $showPassword)
                }
                passwordRule
            }
            Text("Lähetämme osoitteeseen 6-numeroisen koodin, jolla vahvistat sen.")
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
            if let failure { problemText(failure) }
        }
        .onChange(of: firstName) { nameProblem = nil }
        .onChange(of: email) { emailProblem = nil }
        .onChange(of: password) { passwordProblem = nil }
        // A typo in the address shows as soon as the owner moves on, not only after sending.
        .onChange(of: focus) { old, _ in
            if old == .email, !email.isEmpty { emailProblem = EmailCheck.problem(email) }
        }
    }

    /// Live: ticks as soon as the password is long enough (the server's only rule).
    private var passwordRule: some View {
        let long = password.count >= PasswordReset.minLength
        let spoken: String = long
            ? "Salasanassa on vähintään \(PasswordReset.minLength) merkkiä"
            : "Salasanaan tarvitaan vähintään \(PasswordReset.minLength) merkkiä"
        return Label {
            Text("Vähintään \(PasswordReset.minLength) merkkiä")
        } icon: {
            Image(systemName: long ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(long ? Theme.success : Theme.ink2)
        }
        .font(.footnote)
        .foregroundStyle(long ? Theme.ink : Theme.ink2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    // MARK: Step 2: the code from the mail

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Lähetimme koodin osoitteeseen")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
                Text(AccountCode.address(email))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.ink)
            }
            .accessibilityElement(children: .combine)
            AccountCodeField(code: $code, focus: $codeFocused) { _ in
                // The keyboard's suggestion, a paste or the sixth digit: send it at once.
                Task { await verify() }
            }
            if let failure { problemText(failure) }
            Text("Koodi on voimassa 15 minuuttia. Jos viestiä ei näy, katso myös roskaposti.")
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
            VStack(alignment: .leading, spacing: 0) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let left = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                    let title: String = left > 0 ? "Lähetä koodi uudelleen (\(left) s)" : "Lähetä koodi uudelleen"
                    Button { Task { await resend() } } label: {
                        Label(title, systemImage: "arrow.clockwise")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(left > 0 || busy ? Theme.ink2 : Theme.accent)
                    .disabled(left > 0 || busy)
                }
                if resent {
                    Label("Uusi koodi on matkalla.", systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(Theme.success)
                }
                Button { changeAddress() } label: {
                    Label("Vaihda sähköpostiosoite", systemImage: "pencil")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(busy ? Theme.ink2 : Theme.accent)
                .disabled(busy)
            }
        }
        .onAppear { codeFocused = true }
    }

    private var bottomBar: some View {
        AuthBottomBar {
            if step == .details {
                Button { Task { await start() } } label: {
                    AuthButtonLabel(title: "Lähetä koodi", busyTitle: "Lähetetään…", busy: busy)
                }
                .buttonStyle(.primary)
                .disabled(busy)
            } else {
                Button { Task { await verify() } } label: {
                    AuthButtonLabel(title: "Vahvista ja luo tili", busyTitle: "Vahvistetaan…", busy: busy)
                }
                .buttonStyle(.primary)
                .disabled(busy || code.count < AccountCode.length)
            }
        }
    }

    private func problemText(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Actions

    private func start() async {
        guard !busy else { return }
        failure = nil
        let name = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        nameProblem = name.isEmpty ? "Kirjoita etunimesi." : nil
        emailProblem = EmailCheck.problem(email)
        passwordProblem = PasswordReset.validate(password: password, repeat: password).password
        let first: Field? = nameProblem != nil ? .name : (emailProblem != nil ? .email : (passwordProblem != nil ? .password : nil))
        if let first {
            Haptics.error()
            focus = first
            return
        }
        focus = nil
        busy = true
        defer { busy = false }
        do {
            _ = try await app.auth.signupStart(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password, firstName: name)
            Haptics.success()
            code = ""
            resent = false
            resendAt = Date().addingTimeInterval(TimeInterval(AccountCode.resendSeconds))
            step = .code
        } catch is CancellationError {
        } catch {
            show(error)
        }
    }

    private func verify() async {
        guard !busy else { return }
        guard let digits = AccountCode.normalize(code) else {
            failure = "Syötä 6-numeroinen koodi."
            Haptics.error()
            return
        }
        failure = nil
        busy = true
        defer { busy = false }
        do {
            let user = try await app.auth.signupVerify(email: email, code: digits, password: password)
            Haptics.success()
            let chosen = password
            password = ""
            onSignedIn(user, AccountCode.address(email), chosen)
        } catch is CancellationError {
        } catch {
            code = ""
            show(error)
        }
    }

    private func resend() async {
        guard !busy, Date() >= resendAt else { return }
        failure = nil
        busy = true
        defer { busy = false }
        do {
            try await app.auth.signupResend(email: email)
            Haptics.success()
            resent = true
            resendAt = Date().addingTimeInterval(TimeInterval(AccountCode.resendSeconds))
        } catch is CancellationError {
        } catch {
            show(error)
        }
    }

    private func changeAddress() {
        guard !busy else { return }
        failure = nil
        code = ""
        resent = false
        step = .details
    }

    private func show(_ error: Error) {
        Haptics.error()
        guard let error = error as? LKError else {
            failure = LKError.unreachable
            return
        }
        let problem = AccountCodeFailure(error)
        failure = problem.message(serverMessage: error.message)
        // An expired sign-up or a taken address: retyping the code cannot help.
        if problem.startsOver {
            code = ""
            step = .details
        }
    }
}
