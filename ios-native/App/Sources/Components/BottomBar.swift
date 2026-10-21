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
            content.safeAreaBar(edge: .bottom) { measured }
        } else {
            content.safeAreaInset(edge: .bottom) { measured }
        }
        #else
        content.safeAreaInset(edge: .bottom) { measured }
        #endif
    }

    /// In a stack that is there while the screen is, so a bar that goes reads 0 rather than staying
    /// counted at its last height.
    private var measured: some View {
        VStack(spacing: 0) { bar }.bottomClearance()
    }
}

/// What stands at the bottom of the screen on show, over the tab bar: a screen's bottom bar, the
/// bulk bar, a toast. The offline pill floats above the tallest of them instead of over a primary
/// or a message (B4).
@MainActor
@Observable
final class BottomClearance {
    static let shared = BottomClearance()
    /// The tallest on screen, 0 when there is none.
    private(set) var height: CGFloat = 0
    @ObservationIgnored private var heights: [UUID: CGFloat] = [:]

    private init() {}

    fileprivate func set(_ id: UUID, _ value: CGFloat?) {
        heights[id] = value
        let tallest = heights.values.max() ?? 0
        if tallest != height { height = tallest }
    }
}

extension View {
    /// Counts this view's height in `BottomClearance` while it is on screen: a screen pushed over,
    /// another tab or a closed toast no longer holds the pill up.
    func bottomClearance() -> some View {
        modifier(BottomClearanceReport())
    }
}

private struct BottomClearanceReport: ViewModifier {
    @State private var id = UUID()
    @State private var height: CGFloat = 0
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { value in
                height = value
                if shown { BottomClearance.shared.set(id, value) }
            }
            .onAppear {
                shown = true
                BottomClearance.shared.set(id, height)
            }
            .onDisappear {
                shown = false
                BottomClearance.shared.set(id, nil)
            }
    }
}
