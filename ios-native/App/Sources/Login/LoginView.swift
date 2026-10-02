import SwiftUI
import LashKirjaCore

struct LoginView: View {
    @Environment(AppModel.self) private var app
    let notice: String?
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focus: Field?
    private enum Field { case email, password }
    /// The recovery sheet, opened from the link below or from a `lashkirja://…?token=…` link.
    @State private var recovery: Recovery?

    struct Recovery: Identifiable {
        let id = UUID()
        let step: PasswordRecoveryView.Step
        let link: String
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 8) {
                    Image(systemName: "book.closed.fill")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Theme.accentFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Text("LashKirja").font(.largeTitle.bold()).foregroundStyle(Theme.ink)
                    Text("Kirjanpito yksinkertaisesti").font(.subheadline).foregroundStyle(Theme.ink2)
                }
                .padding(.top, 60)

                VStack(alignment: .leading, spacing: 14) {
                    if let message = failure ?? notice {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                    TextField("Sähköposti", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                        .loginField()
                    SecureField("Salasana", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { Task { await submit() } }
                        .loginField()
                    Button {
                        Task { await submit() }
                    } label: {
                        ZStack {
                            Text("Kirjaudu sisään").opacity(busy ? 0 : 1)
                            if busy { ProgressView().tint(Theme.onInk) }
                        }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.primary)
                    .disabled(busy || email.isEmpty || password.isEmpty)
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
            .padding(.horizontal, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.canvas.ignoresSafeArea())
        .sheet(item: $recovery) { r in
            PasswordRecoveryView(step: r.step, email: email, link: r.link)
        }
        .onOpenURL { url in
            // A reset link handed to the app (lashkirja://palauta-salasana?token=…).
            if PasswordReset.token(from: url.absoluteString) != nil {
                recovery = Recovery(step: .reset, link: url.absoluteString)
            }
        }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await app.login(email: email, password: password)
        } catch let problem as LKError {
            failure = problem.message
            Haptics.error()
        } catch {
            failure = LKError.unreachable
        }
    }
}

private extension View {
    func loginField() -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(Theme.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line))
    }
}
