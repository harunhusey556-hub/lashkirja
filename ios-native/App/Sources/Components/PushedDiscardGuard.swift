import SwiftUI

/// Unsaved edits on a pushed screen: the system swipe-back and the back button would drop them
/// silently, so while there are changes (or a save is running) the system back button is replaced
/// by one that asks "Hylätäänkö muutokset?". A clean screen keeps the normal back button and gesture.
struct PushedDiscardGuard: ViewModifier {
    let dirty: Bool
    let busy: Bool
    @Binding var asking: Bool
    let discard: () -> Void

    func body(content: Content) -> some View {
        content
            // Hiding the system button also switches off the edge-swipe pop gesture.
            .navigationBarBackButtonHidden(dirty || busy)
            .toolbar {
                if dirty || busy {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { asking = true } label: {
                            Label("Takaisin", systemImage: "chevron.left").labelStyle(.titleAndIcon)
                        }
                        .disabled(busy)
                    }
                }
            }
            .confirmationDialog("Hylätäänkö muutokset?", isPresented: $asking, titleVisibility: .visible) {
                Button("Hylkää muutokset", role: .destructive) { discard() }
                Button("Jatka muokkausta", role: .cancel) {}
            } message: {
                Text("Tallentamattomat muutokset menetetään.")
            }
    }
}

extension View {
    /// See `PushedDiscardGuard`. `discard` normally calls the environment's `dismiss`.
    func pushedDiscardGuard(dirty: Bool, busy: Bool, asking: Binding<Bool>, discard: @escaping () -> Void) -> some View {
        modifier(PushedDiscardGuard(dirty: dirty, busy: busy, asking: asking, discard: discard))
    }
}
