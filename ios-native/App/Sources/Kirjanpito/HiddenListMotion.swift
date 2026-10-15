import SwiftUI

/// Kuitit keeps loading while a receipt is open over it (pushed or covered). A change that lands
/// then takes its place at once: an insert, removal or count change animated under the receipt
/// was still moving the rows when the owner came back to the list.
struct HiddenListMotion: Equatable {
    var onScreen = true

    /// The animation a change to the list may use: none while it is hidden.
    func animation(_ animation: Animation?) -> Animation? { onScreen ? animation : nil }

    /// For changes animated from elsewhere (a receipt deleted on its own screen, the offline
    /// queue): while hidden they land without animation, and no `.animation(_:value:)` inside
    /// the list may add one back.
    func settle(_ transaction: inout Transaction) {
        guard !onScreen else { return }
        transaction.animation = nil
        transaction.disablesAnimations = true
    }
}

extension EnvironmentValues {
    /// Set by `ReceiptsView` for the sections inside its list; elsewhere always on screen.
    @Entry var listMotion = HiddenListMotion()
}
