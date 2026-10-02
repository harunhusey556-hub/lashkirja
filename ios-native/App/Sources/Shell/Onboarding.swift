import SwiftUI
import LashKirjaCore

/// First sign-in: business form and VAT, the minimum the books need.
struct OnboardingView: View {
    @Environment(AppModel.self) private var app
    let done: () -> Void
    @State private var entityType = "toiminimi"
    @State private var vatRegistered = false
    @State private var vatPeriod = "month"
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Kerro yrityksestäsi, niin kirjanpito osaa laskea verot oikein.").foregroundStyle(Theme.ink2)
                }
                Section("Yritysmuoto") {
                    Picker("Yritysmuoto", selection: $entityType) {
                        Text("Toiminimi").tag("toiminimi")
                        Text("Kevytyrittäjä").tag("kevytyrittaja")
                        Text("Osakeyhtiö").tag("oy")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("Arvonlisävero") {
                    Toggle("ALV-rekisterissä", isOn: $vatRegistered)
                    if vatRegistered {
                        Picker("Verokausi", selection: $vatPeriod) {
                            Text("Kuukausi").tag("month")
                            Text("Neljännesvuosi").tag("quarter")
                            Text("Vuosi").tag("year")
                        }
                    }
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                Section {
                    Button { Task { await save() } } label: { Text("Aloita").frame(maxWidth: .infinity, minHeight: 44).font(.headline) }
                        .buttonStyle(.primary).disabled(busy)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Tervetuloa")
        }
        .interactiveDismissDisabled()
    }

    private func save() async {
        struct Body: Encodable {
            let entityType: String
            let vatRegistered: Bool
            let vatPeriod: String
            let salesTypes = ["ripsipalvelut"]
            let expenseCategories = ["tarvikkeet"]
        }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/onboarding", body: Body(entityType: entityType, vatRegistered: vatRegistered, vatPeriod: vatPeriod))
            Haptics.success()
            app.profileChanged(nil)
            done()
        } catch {
            failure = error.userMessage
        }
    }
}
