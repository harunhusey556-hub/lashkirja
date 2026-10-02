import SwiftUI
import Observation
import LashKirjaCore

/// Whether the first-sign-in questions show, are snoozed ("Ohita nyt", 24 h) or are done.
/// The shell presents the questions from `isPresented`; Koti shows its resume card while
/// `isSnoozed` and reopens them with `resume()`. Snooze and draft are kept per account on
/// this device (lib/onboarding-gate.ts keeps them in the per-user draft store).
@MainActor
@Observable
final class OnboardingGate {
    static let shared = OnboardingGate()

    var isPresented = false
    private(set) var isSnoozed = false
    private var userId: String?

    private struct State_: Decodable { let onboarded: Bool }

    /// After sign-in: asks the server once whether the owner has answered the questions.
    func check(_ app: AppModel) async {
        guard case .signedIn(let user) = app.phase else { return }
        // Another account signed in on this device: nothing of the previous one's state carries over.
        if userId != user.userId {
            isPresented = false
            isSnoozed = false
        }
        userId = user.userId
        guard let state: State_ = try? await app.api.get("/api/onboarding") else { return }
        let until = UserDefaults.standard.object(forKey: OnboardingSnooze.key(userId: user.userId)) as? Date
        switch OnboardingGateDecision.decide(onboarded: state.onboarded, snoozedUntil: until, now: Date()) {
        case .done:
            isSnoozed = false
            isPresented = false
        case .ask:
            isSnoozed = false
            isPresented = true
        case .resumeCard:
            isSnoozed = true
            isPresented = false
        }
    }

    /// Koti's "Viimeistele yritysprofiili" card: the questions open where they were left.
    func resume() { isPresented = true }

    /// "Ohita nyt": nothing is saved on the server; the answers so far wait as a draft.
    func snooze(_ answers: OnboardingAnswers) {
        if let userId {
            UserDefaults.standard.set(OnboardingSnooze.until(now: Date()), forKey: OnboardingSnooze.key(userId: userId))
            if let data = try? JSONEncoder().encode(answers) {
                UserDefaults.standard.set(data, forKey: OnboardingSnooze.draftKey(userId: userId))
            }
        }
        isSnoozed = true
        isPresented = false
    }

    func completed() {
        if let userId {
            UserDefaults.standard.removeObject(forKey: OnboardingSnooze.key(userId: userId))
            UserDefaults.standard.removeObject(forKey: OnboardingSnooze.draftKey(userId: userId))
        }
        isSnoozed = false
        isPresented = false
    }

    func draft() -> OnboardingAnswers? {
        guard let userId, let data = UserDefaults.standard.data(forKey: OnboardingSnooze.draftKey(userId: userId)) else { return nil }
        return (try? JSONDecoder().decode(OnboardingAnswers.self, from: data))?.sanitized()
    }
}

/// First sign-in: business form, VAT, what the business sells and its usual costs
/// (lib/onboarding.ts ONBOARDING_STEPS), the minimum the books and the assistant need.
struct OnboardingView: View {
    @Environment(AppModel.self) private var app
    private var gate: OnboardingGate { .shared }
    @State private var answers = OnboardingAnswers()
    @State private var restored = false
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Kerro yrityksestäsi, niin kirjanpito osaa laskea verot oikein.").foregroundStyle(Theme.ink2)
                }
                Section("Yritysmuoto") {
                    Picker("Yritysmuoto", selection: $answers.entityType) {
                        Text("Toiminimi").tag("toiminimi")
                        Text("Kevytyrittäjä").tag("kevytyrittaja")
                        Text("Osakeyhtiö").tag("oy")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("Arvonlisävero") {
                    Toggle("ALV-rekisterissä", isOn: $answers.vatRegistered)
                    if answers.vatRegistered {
                        Picker("Verokausi", selection: $answers.vatPeriod) {
                            Text("Kuukausi").tag("month")
                            Text("Neljännesvuosi").tag("quarter")
                            Text("Vuosi").tag("year")
                        }
                    }
                }
                multiSelect(OnboardingQuestions.sales, picked: answers.salesTypes) { answers.toggleSales($0) }
                multiSelect(OnboardingQuestions.expenses, picked: answers.expenseCategories) { answers.toggleExpense($0) }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                Section {
                    Button { Task { await save() } } label: { Text("Aloita").frame(maxWidth: .infinity, minHeight: 44).font(.headline) }
                        .buttonStyle(.primary).disabled(busy)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Tervetuloa")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Ohita nyt") {
                        Haptics.selection()
                        gate.snooze(answers)
                    }
                    .disabled(busy)
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear {
            // Reopened from Koti: the answers given before "Ohita nyt".
            guard !restored else { return }
            restored = true
            if let draft = gate.draft() { answers = draft }
        }
    }

    /// One "Voit valita useita." question; none picked is a valid answer.
    private func multiSelect(_ question: OnboardingQuestion, picked: [String], toggle: @escaping (String) -> Void) -> some View {
        Section {
            ForEach(question.choices) { choice in
                Button {
                    Haptics.selection()
                    toggle(choice.value)
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.label).foregroundStyle(Theme.ink)
                            if let detail = choice.detail { Text(detail).font(.caption).foregroundStyle(Theme.ink2) }
                        }
                        Spacer(minLength: 8)
                        Image(systemName: picked.contains(choice.value) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(picked.contains(choice.value) ? Theme.accent : Theme.line)
                            .imageScale(.large)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(picked.contains(choice.value) ? .isSelected : [])
            }
        } header: {
            Text(question.question)
        } footer: {
            Text(question.hint)
        }
    }

    private func save() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/onboarding", body: answers.body)
            Haptics.success()
            app.profileChanged(nil)
            gate.completed()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
