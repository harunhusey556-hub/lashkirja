import SwiftUI

/// A sign-in or sign-up field: its label stays above the box, and a problem is said in words
/// under it (the red border alone would not tell a colour-blind owner anything).
struct AuthField<Content: View>: View {
    let label: String
    var problem: String? = nil
    var focused = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.ink)
                .accessibilityHidden(true)
            HStack(spacing: 10) { content }
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(problem != nil ? Theme.danger : (focused ? Theme.accent : Theme.line),
                            lineWidth: problem != nil || focused ? 1.5 : 1))
            if let problem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// The eye button inside a password field.
struct ShowPasswordButton: View {
    @Binding var shown: Bool

    var body: some View {
        Button { shown.toggle() } label: {
            Image(systemName: shown ? "eye.slash" : "eye")
                .foregroundStyle(Theme.ink2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(shown ? "Piilota salasana" : "Näytä salasana")
    }
}

/// A full-width button title that turns into a spinner and a busy word while the call runs,
/// so the button keeps its size and place.
struct AuthButtonLabel: View {
    let title: String
    let busyTitle: String
    let busy: Bool
    var spinnerTint: Color = Theme.onInk

    var body: some View {
        ZStack {
            Text(title).opacity(busy ? 0 : 1)
            if busy {
                HStack(spacing: 8) {
                    ProgressView().tint(spinnerTint)
                    Text(busyTitle)
                }
            }
        }
        .font(.headline)
        .frame(maxWidth: .infinity, minHeight: 52)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(busy ? busyTitle : title)
    }
}

/// The secondary button next to a `.primary` one: same capsule, outlined.
struct OutlineButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.ink.opacity(isEnabled ? 1 : 0.4))
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(Theme.surface.opacity(configuration.isPressed ? 0.6 : 1), in: Capsule())
            .overlay(Capsule().stroke(Theme.line))
            .contentShape(Capsule())
    }
}

/// The bar a screen's primary button sits in, pinned above the keyboard.
struct AuthBottomBar<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 8) { content }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .frame(maxWidth: 460)
            .frame(maxWidth: .infinity)
            .background(Theme.canvas.opacity(0.96).ignoresSafeArea(edges: .bottom))
            .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
    }
}
