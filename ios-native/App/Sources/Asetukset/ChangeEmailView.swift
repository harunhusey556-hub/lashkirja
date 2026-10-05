import SwiftUI
import UIKit
import LashKirjaCore

/// Vaihda sähköposti (the email part of /asetukset/profiili): the new address gets a
/// confirmation link, and the old one keeps working until that link is opened.
struct ChangeEmailView: View {
    @Environment(AppModel.self) private var app
    @State private var profile = ScreenLoad<AccountEmailProfile>()
    @State private var email = ""
    @State private var password = ""
    @State private var emailError: String?
    @State private var passwordError: String?
    @State private var formError: String?
    @State private var note: String?
    @State private var busy = false
    @State private var link = ""
    @State private var confirming = false
    @State private var confirmNote: (text: String, failed: Bool)?

    var body: some View {
        List {
            if let current = profile.value {
                if let banner = profile.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    LabeledContent("Nykyinen", value: current.email)
                    if let pending = current.pendingEmail {
                        Text("Odottaa vahvistusta: \(pending). Nykyinen osoite toimii siihen asti.")
                            .font(.footnote)
                            .foregroundStyle(Theme.warning)
                    }
                } footer: {
                    Text("Kirjautumissähköposti on \(current.email). Uusi osoite otetaan käyttöön vasta vahvistuslinkin jälkeen.")
                }
                Section {
                    TextField("Uusi sähköposti", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: email) { _, _ in emailError = nil }
                    if let emailError { Text(emailError).font(.footnote).foregroundStyle(Theme.danger) }
                    SecureField("Nykyinen salasana", text: $password)
                        .textContentType(.password)
                        .submitLabel(.send)
                        .onSubmit { Task { await send() } }
                        .onChange(of: password) { _, _ in passwordError = nil }
                    if let passwordError { Text(passwordError).font(.footnote).foregroundStyle(Theme.danger) }
                } header: {
                    Text("Vaihda sähköposti")
                } footer: {
                    if let formError {
                        Text(formError).foregroundStyle(Theme.danger)
                    } else if let note {
                        Text(note).foregroundStyle(Theme.success)
                    }
                }
                Section {
                    Button { Task { await send() } } label: {
                        HStack {
                            Text(busy ? "Lähetetään…" : "Lähetä vahvistus")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy)
                }
                if current.pendingEmail != nil {
                    confirmSection
                }
            } else {
                ScreenStateView(state: profile, retry: load) { (_: AccountEmailProfile) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Sähköposti")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if profile.value == nil { await load() } }
    }

    /// The link from the mail can be pasted here instead of opened in the browser.
    private var confirmSection: some View {
        Section {
            TextField("Vahvistuslinkki", text: $link, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
            Button {
                if let text = UIPasteboard.general.string { link = text }
            } label: {
                Label("Liitä leikepöydältä", systemImage: "doc.on.clipboard")
            }
            Button { Task { await confirm() } } label: {
                HStack {
                    Text(confirming ? "Vahvistetaan…" : "Vahvista")
                    if confirming { Spacer(); ProgressView() }
                }
            }
            .disabled(confirming || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } header: {
            Text("Vahvista uusi osoite")
        } footer: {
            if let confirmNote {
                Text(confirmNote.text).foregroundStyle(confirmNote.failed ? Theme.danger : Theme.success)
            } else {
                Text("Avaa uuteen osoitteeseen tullut linkki, tai liitä se tähän. Vahvistus vaihtaa kirjautumissähköpostin.")
            }
        }
    }

    private func load() async {
        profile.begin()
        do {
            let response: AccountEmailProfile.Response = try await app.api.get("/api/profile")
            profile.succeed(response.profile)
            if email.isEmpty, let pending = response.profile.pendingEmail { email = pending }
        } catch is CancellationError {
        } catch {
            profile.fail(error)
        }
    }

    private func send() async {
        guard !busy else { return }
        formError = nil
        note = nil
        let request = EmailChangeBody(email: email, currentPassword: password)
        if request == nil { emailError = "Kirjoita uusi sähköpostiosoite." }
        if password.isEmpty { passwordError = "Kirjoita nykyinen salasana." }
        guard let request, !password.isEmpty else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        do {
            let answer: AccountMessageResponse = try await app.api.send("POST", "/api/auth/email", body: request)
            password = ""
            Haptics.success()
            note = answer.message ?? "Vahvistuslinkki lähetettiin uuteen osoitteeseen."
            await load()
        } catch is CancellationError {
        } catch let error as LKError where error.status == 401 {
            // A wrong current password answers 401 with its own message.
            Haptics.error()
            passwordError = error.message
        } catch {
            Haptics.error()
            formError = error.userMessage
        }
    }

    private func confirm() async {
        guard !confirming else { return }
        guard let token = PasswordReset.token(from: link) else {
            confirmNote = ("Linkki puuttuu tai on vanhentunut.", true)
            Haptics.error()
            return
        }
        confirming = true
        defer { confirming = false }
        do {
            let answer: EmailConfirmResponse = try await app.api.send("POST", "/api/auth/email/confirm", body: EmailConfirmBody(token: token))
            Haptics.success()
            link = ""
            confirmNote = (answer.email.map { "Sähköposti vaihdettu. Kirjaudu jatkossa osoitteella \($0)." } ?? "Sähköposti vaihdettu.", false)
            app.dataVersion += 1
            await load()
            // The profile sheet and the cached profile show the new address at once.
            if let email = answer.email ?? profile.value?.email {
                app.emailChanged(to: email)
            } else {
                app.profileChanged(nil)
            }
        } catch is CancellationError {
        } catch {
            Haptics.error()
            confirmNote = (error.userMessage, true)
        }
    }
}
