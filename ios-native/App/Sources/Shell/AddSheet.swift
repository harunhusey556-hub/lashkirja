import SwiftUI

struct AddSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button { dismiss() } label: { Label("Kuvaa kuitti", systemImage: "camera") }
                Button { dismiss() } label: { Label("Tuo tiliote", systemImage: "square.and.arrow.down") }
                Button { dismiss() } label: { Label("Uusi lasku", systemImage: "doc.badge.plus") }
                Button { dismiss() } label: { Label("Hae sähköpostista", systemImage: "envelope") }
            }
            .navigationTitle("Lisää")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
