import SwiftUI

struct ProfileSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            List {
                if case .signedIn(let user) = app.phase {
                    Section {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.firstName ?? "LashKirja").font(.headline)
                            if !user.email.isEmpty {
                                Text(user.email).font(.subheadline).foregroundStyle(Theme.ink2)
                            }
                        }
                    }
                }
                Section {
                    NavigationLink(value: Route.placeholder("Asetukset")) { Label("Asetukset", systemImage: "gearshape") }
                }
                Section {
                    Button(role: .destructive) { confirmLogout = true } label: {
                        Label("Kirjaudu ulos", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .appDestinations()
            .navigationTitle("Profiili")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Valmis") { dismiss() } } }
            .confirmationDialog("Kirjaudutaanko ulos?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Kirjaudu ulos", role: .destructive) { Task { await app.logout() } }
            }
        }
    }
}
