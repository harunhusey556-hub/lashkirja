import SwiftUI
import LashKirjaCore

/// The bar under a list in "Valitse" mode (web `kuitit/BulkBar.tsx`): how many rows are picked and
/// the list's own actions. Shown only while something is picked. No Peruuta of its own: every list
/// that shows it ends the mode with the toolbar's "Valmis", and two exits doing one thing was one
/// too many (X040).
struct BulkBar<Actions: View>: View {
    let count: Int
    let busy: Bool
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        // The count and the actions in one row while they fit; at large text sizes the actions go
        // under the count, side by side and then one per line.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                header
                actions()
            }
            VStack(alignment: .leading, spacing: 10) {
                header
                HStack(spacing: 8) { actions() }
            }
            VStack(alignment: .leading, spacing: 10) {
                header
                VStack(alignment: .leading, spacing: 8) { actions() }
            }
        }
        .disabled(busy)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        // Opaque: at 0.94 the row under the bar read through it (X041).
        .background(Theme.ink, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Valitut: \(count)")
        .accessibilityIdentifier("bulk-bar")
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        // Also where no bottom bar holds it (Pankki, Ostolaskut put it in their own inset).
        .bottomClearance()
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("\(count) valittu")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.onInk)
            Spacer(minLength: 0)
            // One fixed slot for the spinner, so the actions keep their place when a run starts.
            ZStack {
                if busy { ProgressView().tint(Theme.onInk) }
            }
            .frame(width: 20, height: 20)
        }
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
