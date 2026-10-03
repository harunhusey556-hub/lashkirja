import SwiftUI
import LashKirjaCore

/// Luo tili (/api/auth/signup/*): name, address and password, then the 6-digit code from the
/// mail. The right code signs in at once; `onSignedIn` hands the session to the sign-in screen's
/// own after-sign-in flow, so a new account opens the app the same way a password sign-in does.
struct SignUpView: View {
    enum Step: Hashable { case details, code }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// The user, the address and the password just chosen (the passkey offer needs it).
    let onSignedIn: (AuthUser, String, String) -> Void

    @State private var step: Step = .details
    @State private var firstName = ""
    @State private var email: String
    @State private var password = ""
    @State private var code = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var passwordProblem: String?
    /// The server takes one new code a minute: the resend button waits until then.
    @State private var resendAt = Date.distantPast
    @State private var resent = false
    @FocusState private var codeFocused: Bool

    init(email: String = "", onSignedIn: @escaping (AuthUser, String, String) -> Void) {
        _email = State(initialValue: email.trimmingCharacters(in: .whitespacesAndNewlines))
        self.onSignedIn = onSignedIn
    }

    var body: some View {
        NavigationStack {
            Form {
                if step == .details { detailsSections } else { codeSections }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Luo tili")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Sulje") { dismiss() } }
            }
            .interactiveDismissDisabled(busy)
        }
    }

    // MARK: Step 1: name, address, password

    @ViewBuilder private var detailsSections: some View {
        Section {
            TextField("Etunimi", text: $firstName)
                .textContentType(.givenName)
                .submitLabel(.next)
            TextField("Sähköposti", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
            SecureField("Salasana", text: $password)
                .textContentType(.newPassword)
                .submitLabel(.send)
                .onSubmit { Task { await start() } }
            if let passwordProblem { Text(passwordProblem).font(.footnote).foregroundStyle(Theme.danger) }
        } footer: {
            Text("Salasanassa vähintään \(PasswordReset.minLength) merkkiä. Lähetämme sähköpostiisi 6-numeroisen koodin, jolla vahvistat osoitteen.")
        }
        if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
        Section {
            primaryButton("Lähetä koodi", busyText: "Lähetetään…") { await start() }
        }
    }

    // MARK: Step 2: the code from the mail

    @ViewBuilder private var codeSections: some View {
        Section {
            TextField("123456", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .font(.title2.monospacedDigit())
                .focused($codeFocused)
                .onAppear { codeFocused = true }
                .onChange(of: code) { _, typed in
                    // The keyboard's suggestion from the mail fills all six at once: send it.
                    if !busy, AccountCode.normalize(typed) != nil { Task { await verify() } }
                }
        } header: {
            Text("Vahvistuskoodi")
        } footer: {
            Text("Syötä sähköpostiin lähetetty 6-numeroinen koodi. Viesti lähetettiin osoitteeseen \(email). Koodi on voimassa 15 minuuttia.")
        }
        if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
        Section {
            primaryButton("Vahvista ja luo tili", busyText: "Vahvistetaan…") { await verify() }
        }
        Section {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                let title: String = left > 0 ? "Lähetä koodi uudelleen (\(left) s)" : "Lähetä koodi uudelleen"
                Button(title) {
                    Task { await resend() }
                }
                .disabled(left > 0 || busy)
            }
            Button("Vaihda sähköpostiosoite") {
                failure = nil
                code = ""
                step = .details
            }
            .disabled(busy)
        } footer: {
            if resent { Text("Uusi koodi on matkalla. Tarkista myös roskaposti.") }
        }
    }

    private func primaryButton(_ text: String, busyText: String, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Group {
                if busy {
                    HStack(spacing: 8) { ProgressView().tint(Theme.onInk); Text(busyText) }
                } else {
                    Text(text)
                }
            }
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.primary)
        .disabled(busy)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    // MARK: Actions

    private func start() async {
        guard !busy else { return }
        failure = nil
        passwordProblem = PasswordReset.validate(password: password, repeat: password).password
        let name = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            failure = "Kirjoita etunimesi."
        } else if address.isEmpty || !address.contains("@") {
            failure = "Kirjoita sähköpostiosoite."
        }
        guard failure == nil, passwordProblem == nil else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.auth.signupStart(email: address, password: password, firstName: name)
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

    private func show(_ error: Error) {
        Haptics.error()
        guard let error = error as? LKError else {
            failure = LKError.unreachable
            return
        }
        let problem = AccountCodeFailure(error)
        failure = problem.message(serverMessage: error.message)
        // An expired sign-up or a taken address: retyping the code cannot help.
        if problem.startsOver { step = .details }
    }
}
