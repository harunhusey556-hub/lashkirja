import SwiftUI

/// Unsaved edits in a sheet: swipe-down is held while saving or while there are
/// changes, and "Peruuta" asks "Hylätäänkö muutokset?" before dropping them.
struct DiscardGuard: ViewModifier {
    let dirty: Bool
    let busy: Bool
    @Binding var asking: Bool
    let discard: () -> Void

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(busy || dirty)
            .confirmationDialog("Hylätäänkö muutokset?", isPresented: $asking, titleVisibility: .visible) {
                Button("Hylkää muutokset", role: .destructive) { discard() }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text("Tallentamattomat muutokset menetetään.")
            }
    }
}

extension View {
    /// See `DiscardGuard`. Pair with a "Peruuta" button that sets `asking` when `dirty`.
    func discardGuard(dirty: Bool, busy: Bool, asking: Binding<Bool>, discard: @escaping () -> Void) -> some View {
        modifier(DiscardGuard(dirty: dirty, busy: busy, asking: asking, discard: discard))
    }
}
