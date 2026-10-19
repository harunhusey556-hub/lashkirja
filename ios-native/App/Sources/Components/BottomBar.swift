import SwiftUI

/// A screen's one primary at the bottom (Kuitit's "Kohdista varmat", the receipt's "Hyväksy") and
/// the bulk bar: above the tab bar, with the list scrolling under it.
extension View {
    /// iOS 26 takes the bar as a bar (`safeAreaBar`), so the scroll edge effect runs under it;
    /// iOS 18 keeps the plain inset.
    func bottomBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        modifier(BottomBarModifier(bar: bar()))
    }

    /// The canvas from the bar's top down to the screen's bottom edge: the rows that scroll under
    /// the bar no longer show through the gap above the floating tab bar, nor behind its labels (X065).
    func bottomBarBacking() -> some View {
        background(Theme.canvas, ignoresSafeAreaEdges: .bottom)
    }
}

private struct BottomBarModifier<Bar: View>: ViewModifier {
    let bar: Bar

    @ViewBuilder func body(content: Content) -> some View {
        // Swift 6.2 is Xcode 26, the first SDK with safeAreaBar; an older Xcode still builds.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom) { bar }
        } else {
            content.safeAreaInset(edge: .bottom) { bar }
        }
        #else
        content.safeAreaInset(edge: .bottom) { bar }
        #endif
    }
}
