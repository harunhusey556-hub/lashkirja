import SwiftUI
import UIKit

/// Unsaved edits in a sheet: swipe-down is held while saving or while there are
/// changes, and both "Peruuta" and a held swipe ask "Hylätäänkö muutokset?" before dropping them.
struct DiscardGuard: ViewModifier {
    let dirty: Bool
    let busy: Bool
    @Binding var asking: Bool
    let discard: () -> Void

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(busy || dirty)
            // A held swipe otherwise just bounces back with no word of why (P0.5 device check).
            .background(SwipeAttemptObserver { if dirty && !busy { asking = true } })
            // An alert, not a confirmation dialog: on iOS 26 the dialog floats over the sheet title
            // with no visible way back; the alert shows both choices.
            .alert("Hylätäänkö muutokset?", isPresented: $asking) {
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

/// SwiftUI has no hook for "the user tried to swipe a non-dismissable sheet away"; UIKit reports it
/// as `presentationControllerDidAttemptToDismiss`. This sits in the sheet, wraps the sheet's
/// presentation-controller delegate and forwards every call to SwiftUI's own delegate, so
/// `interactiveDismissDisabled` and the `isPresented` binding keep working unchanged.
struct SwipeAttemptObserver: UIViewControllerRepresentable {
    let onAttempt: () -> Void

    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) { probe.onAttempt = onAttempt }

    final class Probe: UIViewController, UIAdaptivePresentationControllerDelegate {
        var onAttempt: () -> Void = {}
        // Strong: UIKit holds delegates weakly, and once replaced nothing else may keep SwiftUI's alive.
        private var original: UIAdaptivePresentationControllerDelegate?
        private weak var hooked: UIPresentationController?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            // The sheet's root controller owns the presentation controller; children reach it through it.
            guard let pc = sheetController()?.presentationController, pc !== hooked else { return }
            if !(pc.delegate is Probe) { original = pc.delegate }
            pc.delegate = self
            hooked = pc
        }

        private func sheetController() -> UIViewController? {
            var vc: UIViewController? = self
            while let current = vc {
                if current.presentingViewController != nil && current.parent == nil { return current }
                vc = current.parent
            }
            return nil
        }

        func presentationControllerDidAttemptToDismiss(_ pc: UIPresentationController) {
            original?.presentationControllerDidAttemptToDismiss?(pc)
            onAttempt()
        }

        // Everything else (should/will/did dismiss, adaptive style) goes to SwiftUI's delegate as if
        // this probe were not there, including "not implemented".
        override func responds(to aSelector: Selector!) -> Bool {
            if aSelector == #selector(presentationControllerDidAttemptToDismiss(_:)) { return true }
            return super.responds(to: aSelector) || (original?.responds(to: aSelector) ?? false)
        }
        override func forwardingTarget(for aSelector: Selector!) -> Any? {
            if let original, original.responds(to: aSelector) { return original }
            return super.forwardingTarget(for: aSelector)
        }
    }
}
