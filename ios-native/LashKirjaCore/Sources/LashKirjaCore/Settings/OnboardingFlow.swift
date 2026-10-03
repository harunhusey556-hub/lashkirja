import Foundation

/// One question of the chat-style first-run setup (lib/onboarding.ts OnboardingStepId).
public enum OnboardingStep: String, Codable, CaseIterable, Sendable, Identifiable {
    case entityType, vatRegistered, vatPeriod, salesTypes, expenseCategories

    public var id: String { rawValue }

    public var content: OnboardingQuestion {
        switch self {
        case .entityType: OnboardingQuestions.entity
        case .vatRegistered: OnboardingQuestions.vat
        case .vatPeriod: OnboardingQuestions.vatPeriod
        case .salesTypes: OnboardingQuestions.sales
        case .expenseCategories: OnboardingQuestions.expenses
        }
    }

    public var question: String { content.question }
    public var hint: String? { content.hint }
    public var choices: [OnboardingChoice] { content.choices }
    public var isMultiSelect: Bool { self == .salesTypes || self == .expenseCategories }

    /// The summary row's label (profileSummaryRows).
    public var summaryLabel: String {
        switch self {
        case .entityType: "Yritysmuoto"
        case .vatRegistered: "ALV-rekisteri"
        case .vatPeriod: "ALV-kausi"
        case .salesTypes: "Myynti"
        case .expenseCategories: "Kulut"
        }
    }
}

public struct OnboardingSummaryRow: Equatable, Sendable, Identifiable {
    public let step: OnboardingStep
    public let label: String
    public let value: String
    public var id: String { step.rawValue }
}

/// The first-run conversation (OnboardingChat.tsx): one question at a time, the answers as the
/// user's own bubbles, any of them reopened with "Muuta", then a summary to confirm.
/// Also the draft kept on the device, so a snooze or an app kill resumes mid-conversation.
public struct OnboardingFlow: Codable, Equatable, Sendable {
    public static let intro = "Hei! Muokataan LashKirja sinun yrityksellesi sopivaksi. Se vie noin minuutin."
    public static let summaryIntro = "Tässä yhteenveto. Tarkista ja vahvista."
    public static let noSelection = "Ei mitään näistä"

    /// The values; a step's value counts only once the step is in `answered`
    /// (`OnboardingAnswers` has defaults, the web's answers have missing keys).
    public private(set) var answers: OnboardingAnswers
    public private(set) var answered: Set<OnboardingStep>
    /// The step reopened with "Muuta"; the later answers wait, kept, until it is answered again.
    public private(set) var editing: OnboardingStep?

    public init(answers: OnboardingAnswers = OnboardingAnswers(), answered: Set<OnboardingStep> = [], editing: OnboardingStep? = nil) {
        self.answers = answers.sanitized()
        self.answered = answered
        self.editing = editing
        dropInvalid()
    }

    /// The questions to ask. The VAT period is asked only of a VAT-registered business, so
    /// "no" makes the flow four questions long instead of skipping a progress step
    /// (onboardingSteps: still five while the VAT question is unanswered).
    public var steps: [OnboardingStep] {
        let notRegistered = answered.contains(.vatRegistered) && !answers.vatRegistered
        return OnboardingStep.allCases.filter { $0 != .vatPeriod || !notRegistered }
    }

    /// The question waiting for an answer; nil once everything is answered (the summary).
    public var current: OnboardingStep? {
        if let editing { return editing }
        return steps.first { !answered.contains($0) }
    }

    public var isComplete: Bool { current == nil }

    /// The answered questions shown above the current one, in order; all of them at the summary.
    public var transcript: [OnboardingStep] {
        guard let current else { return steps }
        guard let index = steps.firstIndex(of: current) else { return [] }
        return Array(steps[..<index])
    }

    /// Share of the questions behind the user, for the progress bar.
    public var progress: Double {
        if isComplete { return 1 }
        return Double(transcript.count) / Double(max(steps.count, 1))
    }

    /// "2 / 5" while asking, "Valmis" at the summary.
    public var progressLabel: String {
        if isComplete { return "Valmis" }
        return "\(min(transcript.count + 1, steps.count)) / \(steps.count)"
    }

    /// A single-choice answer to the current question; an unknown value is ignored.
    public mutating func answer(_ value: String) {
        guard let step = current, !step.isMultiSelect, step.choices.contains(where: { $0.value == value }) else { return }
        switch step {
        case .entityType: answers.entityType = value
        case .vatRegistered: answers.vatRegistered = value == "true"
        case .vatPeriod: answers.vatPeriod = value
        case .salesTypes, .expenseCategories: return
        }
        commit(step)
    }

    /// A multi-select answer to the current question; none picked is a valid answer.
    public mutating func answer(_ values: [String]) {
        guard let step = current, step.isMultiSelect else { return }
        let clean = OnboardingAnswers.ordered(values, in: step.content)
        if step == .salesTypes { answers.salesTypes = clean } else { answers.expenseCategories = clean }
        commit(step)
    }

    /// "Muuta": reopens an answered question. Answering it again goes on to the first question
    /// still without an answer, or straight back to the summary when the later answers still hold.
    public mutating func edit(_ step: OnboardingStep) {
        guard answered.contains(step), steps.contains(step) else { return }
        editing = step
    }

    /// The values chosen for a step: highlighted when it is asked again. A single-choice step
    /// shows none until it is answered, so no default looks like the user's choice.
    public func selection(for step: OnboardingStep) -> [String] {
        switch step {
        case .entityType: answered.contains(step) ? [answers.entityType] : []
        case .vatRegistered: answered.contains(step) ? [answers.vatRegistered ? "true" : "false"] : []
        case .vatPeriod: answered.contains(step) ? [answers.vatPeriod] : []
        case .salesTypes: answers.salesTypes
        case .expenseCategories: answers.expenseCategories
        }
    }

    /// What the user's answer bubble says (answerText): the chip labels, "Ei mitään näistä"
    /// for an empty multi-select, "" while unanswered.
    public func answerText(_ step: OnboardingStep) -> String {
        guard answered.contains(step) else { return "" }
        let values = selection(for: step)
        if step.isMultiSelect && values.isEmpty { return Self.noSelection }
        return values.map { value in step.choices.first { $0.value == value }?.label ?? value }.joined(separator: ", ")
    }

    /// The summary (profileSummaryRows): localized, never raw ids.
    public var summary: [OnboardingSummaryRow] {
        steps.map { step in
            let value: String
            switch step {
            case .vatRegistered: value = answered.contains(step) ? (answers.vatRegistered ? "Kyllä" : "Ei") : ""
            default: value = answerText(step)
            }
            return OnboardingSummaryRow(step: step, label: step.summaryLabel, value: value)
        }
    }

    /// The stored draft; a draft from the earlier form (`OnboardingAnswers` only) keeps its
    /// values as highlighted choices and starts the conversation from the first question.
    public static func draft(from data: Data) -> OnboardingFlow? {
        if let flow = try? JSONDecoder().decode(OnboardingFlow.self, from: data) {
            return OnboardingFlow(answers: flow.answers, answered: flow.answered, editing: flow.editing)
        }
        guard let answers = try? JSONDecoder().decode(OnboardingAnswers.self, from: data) else { return nil }
        return OnboardingFlow(answers: answers)
    }

    private mutating func commit(_ step: OnboardingStep) {
        answered.insert(step)
        editing = nil
        dropInvalid()
    }

    /// An answer to a question no longer asked (the VAT period after "not registered") is dropped.
    private mutating func dropInvalid() {
        let asked = Set(steps)
        answered.formIntersection(asked)
        if let editing, !answered.contains(editing) { self.editing = nil }
    }
}
