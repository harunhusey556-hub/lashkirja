import SwiftUI

/// The avatar's sheet: Asetukset itself, large, with "Valmis" to close.
/// Route links inside (Tietosuoja, Ohje, Pääsyavaimet…) push within this sheet.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            SettingsView()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
                .appDestinations()
        }
        // An invoice reached through Ohje's work queue opens its customer within this sheet too.
        .environment(\.openRoute, OpenRouteAction(stack: "settings") { path.append($0) })
    }
}
