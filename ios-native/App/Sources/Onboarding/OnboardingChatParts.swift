import SwiftUI
import LashKirjaCore

/// The small sparkles mark in front of an assistant group (OnboardingChat.tsx AssistantAvatar).
/// Hidden, not removed, after the first bubble of a group so the bubbles stay aligned.
struct OnboardingAvatar: View {
    var visible = true

    var body: some View {
        Image(systemName: "sparkles")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .frame(width: 28, height: 28)
            .background(Theme.accentSoft, in: Circle())
            .opacity(visible ? 1 : 0)
            .accessibilityHidden(true)
    }
}

/// An assistant bubble: `Theme.surface`, radius 18, like the assistant's chat (AssistantView `Bubble`).
struct OnboardingAssistantBubble<Content: View>: View {
    var avatar = true
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            OnboardingAvatar(visible: avatar)
            VStack(alignment: .leading, spacing: 4) { content }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.line))
                .foregroundStyle(Theme.ink)
                .accessibilityElement(children: .combine)
            Spacer(minLength: 40)
        }
    }
}

/// A question: the question, and its hint in a lighter line.
struct OnboardingQuestionBubble: View {
    let step: OnboardingStep
    var avatar = true

    var body: some View {
        OnboardingAssistantBubble(avatar: avatar) {
            Text(step.question)
            if let hint = step.hint {
                Text(hint).font(.footnote).foregroundStyle(Theme.ink2)
            }
        }
    }
}

/// The user's answer: right-aligned on `Theme.ink`, with "Muuta" under it to reopen the question.
struct OnboardingAnswerBubble: View {
    let text: String
    let disabled: Bool
    let edit: () -> Void

    var body: some View {
        Button(action: edit) {
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(Theme.onInk)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.ink, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                Label("Muuta", systemImage: "pencil")
                    .font(.caption)
                    .foregroundStyle(Theme.ink2)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(disabled)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Vastauksesi: \(text)")
        .accessibilityHint("Muuta vastausta")
        .accessibilityAction { edit() }
    }
}

/// Three dots while the next question is "written". Shown only with motion allowed.
struct OnboardingTypingBubble: View {
    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            OnboardingAvatar()
            TimelineView(.animation) { context in
                let time = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .fill(Theme.ink2)
                            .frame(width: 7, height: 7)
                            .opacity(0.35 + 0.65 * max(0, sin(time * 7 - Double(index) * 0.9)))
                    }
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.line))
            Spacer(minLength: 40)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Kirjoittaa")
    }
}

/// The summary: one row per answer, each reopening its question.
struct OnboardingSummaryBubble: View {
    let rows: [OnboardingSummaryRow]
    let disabled: Bool
    let edit: (OnboardingStep) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            OnboardingAssistantBubble {
                Text(OnboardingFlow.summaryIntro)
            }
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().overlay(Theme.line) }
                    Button { edit(row.step) } label: {
                        HStack(spacing: 12) {
                            // Label above value: long Finnish words never overflow.
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.label).font(.caption).foregroundStyle(Theme.ink2)
                                Text(row.value).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2).accessibilityHidden(true)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.pressable)
                    .disabled(disabled)
                    .accessibilityElement(children: .ignore)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("\(row.label): \(row.value)")
                    .accessibilityHint("Muuta vastausta")
                    .accessibilityAction { edit(row.step) }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(Theme.line))
            .padding(.leading, 36)
        }
    }
}

/// One answer chip: label and its detail line; a check for the picked one(s).
struct OnboardingChoiceRow: View {
    let choice: OnboardingChoice
    let selected: Bool
    let multiSelect: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.label).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                    if let detail = choice.detail {
                        Text(detail).font(.caption).foregroundStyle(Theme.ink2)
                    }
                }
                Spacer(minLength: 8)
                if multiSelect {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .imageScale(.large)
                        .foregroundStyle(selected ? Theme.accent : Theme.line)
                        .accessibilityHidden(true)
                } else if selected {
                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Theme.accent).accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(selected ? Theme.accentSoft : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).stroke(selected ? Theme.accent : Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        }
        .buttonStyle(.pressable)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
