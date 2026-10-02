import SwiftUI
import UIKit
import LashKirjaCore

/// Salasanan palautus (/unohtunut-salasana) and the new password (/palauta-salasana).
/// The mail link opens the web page; here the owner can paste that link (or its
/// code), and a `lashkirja://…?token=…` link opens this sheet with the code filled in.
struct PasswordRecoveryView: View {
    enum Step: Hashable { case request, reset }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var step: Step
    @State var email: String
    @State var link: String

    @State private var busy = false
    @State private var failure: String?
    @State private var sent: ForgotPasswordResponse?
    @State private var password = ""
    @State private var again = ""
    @State private var errors = PasswordReset.Errors()
    @State private var done = false

    init(step: Step = .request, email: String = "", link: String = "") {
        _step = State(initialValue: step)
        _email = State(initialValue: email)
        _link = State(initialValue: link)
    }

    var body: some View {
        NavigationStack {
            Form {
                if done {
                    doneSection
                } else if step == .request {
                    requestSections
                } else {
                    resetSections
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle(step == .request ? "Salasanan palautus" : "Uusi salasana")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Sulje") { dismiss() } }
            }
        }
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
                    Button("Minulla on linkki") { switchTo(.reset) }
                } footer: {
                    Text("Avaa viestin linkki, tai kopioi se ja liitä tähän sovellukseen.")
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
                Text("Kirjoita tilisi sähköpostiosoite. Jos tili löytyy, saat postiin linkin, jolla valitset uuden salasanan. Jos viestiä ei tule, ota yhteyttä tukeen.")
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            Section {
                Button { Task { await requestLink() } } label: {
                    busyLabel("Lähetä linkki", busyText: "Lähetetään…")
                }
                .disabled(busy)
                Button("Minulla on jo linkki") { switchTo(.reset) }
            }
        }
    }

    // MARK: Choose the new password

    @ViewBuilder private var resetSections: some View {
        Section {
            TextField("Linkki tai koodi", text: $link, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
            Button {
                if let text = UIPasteboard.general.string { link = text }
            } label: {
                Label("Liitä leikepöydältä", systemImage: "doc.on.clipboard")
            }
        } header: {
            Text("Palautuslinkki")
        } footer: {
            Text("Liitä sähköpostin linkki kokonaan. Linkki on voimassa 30 minuuttia.")
        }
        Section {
            SecureField("Uusi salasana", text: $password)
                .textContentType(.newPassword)
            if let message = errors.password { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
            SecureField("Toista uusi salasana", text: $again)
                .textContentType(.newPassword)
            if let message = errors.repeat { Text(message).font(.footnote).foregroundStyle(Theme.danger) }
        } footer: {
            Text("Vähintään \(PasswordReset.minLength) merkkiä.")
        }
        if let failure {
            Section {
                Text(failure).foregroundStyle(Theme.danger)
                Button("Pyydä uusi linkki") { switchTo(.request) }
            }
        }
        Section {
            Button { Task { await reset() } } label: {
                busyLabel("Tallenna salasana", busyText: "Tallennetaan…")
            }
            .disabled(busy)
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
        guard let token = PasswordReset.token(from: link) else {
            errors = PasswordReset.validate(password: password, repeat: again)
            failure = "Linkki puuttuu tai on vanhentunut. Pyydä uusi palautuslinkki."
            Haptics.error()
            return
        }
        errors = PasswordReset.validate(password: password, repeat: again)
        guard errors.isValid else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/auth/password/reset", body: ResetPasswordBody(token: token, password: password))
            Haptics.success()
            password = ""
            again = ""
            done = true
        } catch is CancellationError {
        } catch {
            Haptics.error()
            failure = error.userMessage
        }
    }
}
