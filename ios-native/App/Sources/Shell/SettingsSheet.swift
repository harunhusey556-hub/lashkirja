import SwiftUI

/// The avatar's sheet: Asetukset itself, large, with "Valmis" to close.
/// Route links inside (Tietosuoja, Ohje, Pääsyavaimet…) push within this sheet.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsView()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
                .appDestinations()
        }
    }
}
