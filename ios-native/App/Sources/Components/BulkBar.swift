import SwiftUI
import LashKirjaCore

/// The bar under a list in "Valitse" mode (web `kuitit/BulkBar.tsx`): how many rows are picked,
/// Peruuta, and the list's own actions. Shown only while something is picked.
struct BulkBar<Actions: View>: View {
    let count: Int
    let busy: Bool
    let onCancel: () -> Void
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(count) valittu")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.onInk)
                Spacer()
                if busy { ProgressView().tint(Theme.onInk) }
                Button("Peruuta", action: onCancel)
                    .font(.subheadline)
                    .foregroundStyle(Theme.onInk)
            }
            // Side by side while they fit; at large text sizes one per line.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions() }
                VStack(alignment: .leading, spacing: 8) { actions() }
            }
            .disabled(busy)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Theme.ink.opacity(0.94), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Valitut: \(count)")
    }
}

/// One action of the `BulkBar`.
struct BulkBarButton: View {
    let title: String
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(Theme.onInk)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(destructive ? Theme.danger : Theme.onInk.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A row's pick mark in "Valitse" mode.
struct BulkCheckmark: View {
    let selected: Bool

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(selected ? Theme.accent : Theme.ink2)
            .imageScale(.large)
            .accessibilityHidden(true)
    }
}
