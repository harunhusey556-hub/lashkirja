import SwiftUI
import UIKit
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

    /// "Ohita nyt": nothing is saved on the server; the conversation so far waits as a draft.
    func snooze(_ flow: OnboardingFlow) {
        if let userId {
            UserDefaults.standard.set(OnboardingSnooze.until(now: Date()), forKey: OnboardingSnooze.key(userId: userId))
        }
        keepDraft(flow)
        isSnoozed = true
        isPresented = false
    }

    /// After each answer, so an app kill reopens the conversation where it was (saveOnboardingDraft).
    func keepDraft(_ flow: OnboardingFlow) {
        guard let userId, let data = try? JSONEncoder().encode(flow) else { return }
        UserDefaults.standard.set(data, forKey: OnboardingSnooze.draftKey(userId: userId))
    }

    func completed() {
        if let userId {
            UserDefaults.standard.removeObject(forKey: OnboardingSnooze.key(userId: userId))
            UserDefaults.standard.removeObject(forKey: OnboardingSnooze.draftKey(userId: userId))
        }
        isSnoozed = false
        isPresented = false
    }

    func draft() -> OnboardingFlow? {
        guard let userId, let data = UserDefaults.standard.data(forKey: OnboardingSnooze.draftKey(userId: userId)) else { return nil }
        return OnboardingFlow.draft(from: data)
    }
}

/// First sign-in, as a conversation (OnboardingChat.tsx): business form, VAT, what the business
/// sells and its usual costs (lib/onboarding.ts ONBOARDING_STEPS), the minimum the books and the
/// assistant need. One question at a time; its choices sit where a composer would be.
struct OnboardingView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var gate: OnboardingGate { .shared }
    private static let bottomId = "onboarding-bottom"
    @State private var flow = OnboardingFlow()
    /// The chips picked so far for the current multi-select question.
    @State private var picked: [String] = []
    /// The next question is being "written": its bubble and choices wait for the dots.
    @State private var typing = false
    @State private var reply: Task<Void, Never>?
    @State private var restored = false
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        transcript
                        Color.clear.frame(height: 1).id(Self.bottomId)
                    }
                    .padding(16)
                }
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .background(Theme.canvas)
                .safeAreaInset(edge: .top, spacing: 0) { progressBar }
                .safeAreaInset(edge: .bottom, spacing: 0) { answerArea }
                // Each new bubble (or the summary) scrolls into view.
                .onChange(of: scrollKey) { _, _ in
                    if reduceMotion {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    } else {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    }
                }
            }
            .navigationTitle("Tervetuloa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Ohita nyt") {
                        Haptics.selection()
                        reply?.cancel()
                        gate.snooze(flow)
                    }
                    .tint(Theme.ink2)
                    .disabled(busy)
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear {
            // Reopened from Koti or after an app kill: the conversation where it was left.
            guard !restored else { return }
            restored = true
            if let draft = gate.draft() { flow = draft }
            picked = flow.current.map { flow.selection(for: $0) } ?? []
        }
        .onDisappear { reply?.cancel() }
    }

    private var scrollKey: String {
        "\(flow.transcript.count)|\(flow.current?.rawValue ?? "summary")|\(typing)|\(failure ?? "")"
    }

    /// The intro, each answered question with the user's answer, then the current question
    /// (the dots while it is "written") or the summary.
    @ViewBuilder private var transcript: some View {
        OnboardingAssistantBubble { Text(OnboardingFlow.intro) }
        ForEach(Array(flow.transcript.enumerated()), id: \.element) { index, step in
            OnboardingQuestionBubble(step: step, avatar: index > 0)
            OnboardingAnswerBubble(text: flow.answerText(step), disabled: busy) { edit(step) }
        }
        if typing {
            OnboardingTypingBubble()
        } else if let step = flow.current {
            OnboardingQuestionBubble(step: step, avatar: !flow.transcript.isEmpty)
        } else {
            OnboardingSummaryBubble(rows: flow.summary, disabled: busy) { edit($0) }
        }
    }

    private var progressBar: some View {
        HStack(spacing: 12) {
            ProgressView(value: flow.progress)
                .tint(Theme.accent)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: flow.progress)
            Text(flow.progressLabel)
                .font(.caption.monospacedDigit())
                .foregroundStyle(Theme.ink2)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Edistyminen")
        .accessibilityValue(flow.isComplete ? "Valmis" : "Kysymys \(flow.progressLabel)")
    }

    /// Pinned at the bottom: the current question's choices, or "Aloita käyttö" at the summary.
    private var answerArea: some View {
        VStack(spacing: 8) {
            if typing {
                EmptyView()
            } else if let step = flow.current {
                if dynamicTypeSize.isAccessibilitySize {
                    // Large text: the choices scroll instead of pushing the conversation off screen.
                    ScrollView { choices(step) }.frame(maxHeight: 280)
                } else {
                    choices(step)
                }
                if step.isMultiSelect {
                    Button { finishMultiSelect() } label: {
                        Text(picked.isEmpty ? OnboardingFlow.noSelection : "Valmis")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)
                }
            } else {
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Button { Task { await save() } } label: {
                    Group {
                        if busy { ProgressView().tint(Theme.onInk) } else { Text("Aloita käyttö") }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(busy)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, typing ? 0 : 12)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func choices(_ step: OnboardingStep) -> some View {
        VStack(spacing: 8) {
            ForEach(step.choices) { choice in
                OnboardingChoiceRow(
                    choice: choice,
                    selected: step.isMultiSelect ? picked.contains(choice.value) : flow.selection(for: step).contains(choice.value),
                    multiSelect: step.isMultiSelect
                ) {
                    if step.isMultiSelect { toggle(choice.value) } else { answer(choice.value) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(step.question)
    }

    /// One tap answers a single-choice question and moves on.
    private func answer(_ value: String) {
        guard !typing, !busy else { return }
        Haptics.selection()
        advance { $0.answer(value) }
    }

    private func toggle(_ value: String) {
        Haptics.selection()
        picked = picked.contains(value) ? picked.filter { $0 != value } : picked + [value]
    }

    private func finishMultiSelect() {
        guard !typing, !busy else { return }
        Haptics.selection()
        let values = picked
        advance { $0.answer(values) }
    }

    /// Takes the answer, then "writes" the next question: three dots for a moment, none with Reduce Motion.
    private func advance(_ change: (inout OnboardingFlow) -> Void) {
        var next = flow
        change(&next)
        guard next != flow else { return }
        reply?.cancel()
        failure = nil
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            flow = next
            typing = !reduceMotion
        }
        gate.keepDraft(next)
        picked = next.current.map { next.selection(for: $0) } ?? []
        guard !reduceMotion else {
            announce()
            return
        }
        reply = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { typing = false }
            announce()
        }
    }

    /// "Muuta" on an answer or a summary row: that question is asked again.
    private func edit(_ step: OnboardingStep) {
        guard !busy else { return }
        reply?.cancel()
        Haptics.selection()
        failure = nil
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            flow.edit(step)
            typing = false
        }
        gate.keepDraft(flow)
        picked = flow.selection(for: step)
        announce()
    }

    /// VoiceOver hears how far along the conversation is and the new question.
    private func announce() {
        let text = flow.current.map { "Kysymys \(flow.progressLabel). \($0.question)" } ?? OnboardingFlow.summaryIntro
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    private func save() async {
        guard flow.isComplete, !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/onboarding", body: flow.answers.body)
            Haptics.success()
            app.profileChanged(nil)
            gate.completed()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

