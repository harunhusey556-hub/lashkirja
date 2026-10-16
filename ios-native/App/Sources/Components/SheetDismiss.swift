import SwiftUI

/// The sheet's dismiss action for a view whose body must not depend on it. SwiftUI hands a sheet a
/// new `dismiss` twice while the sheet comes in, and a view that read `@Environment(\.dismiss)` ran
/// its whole body again each time: the new-invoice form was built three times on the main thread
/// during its presentation (w47, Uusi lasku). Only a small background view reads it now.
@MainActor
final class SheetDismiss {
    fileprivate var action: DismissAction?

    func callAsFunction() { action?() }
}

extension View {
    /// Keeps `handle` on this place's dismiss action (the same one `@Environment(\.dismiss)` here gives).
    func sheetDismiss(_ handle: SheetDismiss) -> some View {
        background(SheetDismissReader(handle: handle))
    }
}

private struct SheetDismissReader: View {
    @Environment(\.dismiss) private var dismiss
    let handle: SheetDismiss

    var body: some View {
        // Runs again whenever the action changes; nothing else does.
        let _ = (handle.action = dismiss)
        Color.clear.accessibilityHidden(true)
    }
}
