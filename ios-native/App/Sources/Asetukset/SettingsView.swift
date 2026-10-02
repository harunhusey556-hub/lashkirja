import SwiftUI
import LashKirjaCore

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var profile: Profile?
    @State private var profileFailure: String?
    @State private var lockEnabled = AppLock.shared.isEnabled
    @State private var confirmLogout = false

    var body: some View {
        List {
            if let profile {
                Section {
                    NavigationLink { ProfileForm(original: profile, section: .person) { saved($0) } } label: {
                        SettingRow(title: [profile.firstName, profile.lastName].compactMap { $0 }.joined(separator: " "), subtitle: profile.email, symbol: "person.crop.circle")
                    }
                }
                Section("Yritys") {
                    NavigationLink { ProfileForm(original: profile, section: .company) { saved($0) } } label: {
                        SettingRow(title: "Yritysmuoto ja ALV", subtitle: entityLabel(profile.entityType) + (profile.vatRegistered ? " · ALV-rekisterissä" : ""), symbol: "building.2")
                    }
                    NavigationLink { ProfileForm(original: profile, section: .seller) { saved($0) } } label: {
                        SettingRow(title: "Laskuttajan tiedot", subtitle: profile.invoiceIban == nil ? "Täydennä tilinumero laskuille" : (profile.businessName ?? "Nimi, Y-tunnus ja IBAN"), symbol: "doc.text")
                    }
                }
                Section("Kuitit") {
                    NavigationLink { EmailImportView { self.profile = $0; app.profileChanged($0) } } label: {
                        SettingRow(title: "Sähköpostien tuonti", subtitle: mailSubtitle(profile.imapAccounts ?? []), symbol: "envelope")
                    }
                }
            } else if let profileFailure {
                Section {
                    Text(profileFailure).foregroundStyle(Theme.danger)
                    Button("Yritä uudelleen") { Task { await loadProfile() } }
                }
            } else {
                ProgressView().task { await loadProfile() }
            }
            Section("Tili ja turvallisuus") {
                NavigationLink { PasswordView() } label: { SettingRow(title: "Vaihda salasana", subtitle: nil, symbol: "key") }
                NavigationLink(value: Route.changeEmail) { SettingRow(title: "Vaihda sähköposti", subtitle: nil, symbol: "at") }
                NavigationLink(value: Route.passkeys) { SettingRow(title: "Pääsyavaimet", subtitle: "Kirjaudu Face ID:llä ilman salasanaa", symbol: "person.badge.key") }
                NavigationLink { DevicesView() } label: { SettingRow(title: "Laitteet", subtitle: "Kirjautuneet laitteet", symbol: "iphone") }
                NavigationLink { AppLockSettingsView() } label: { SettingRow(title: "Sovelluslukitus", subtitle: lockEnabled ? "Käytössä" : "Ei käytössä", symbol: "lock") }
            }
            Section("Tietosuoja ja ohje") {
                NavigationLink(value: Route.privacy) { SettingRow(title: "Tietosuoja", subtitle: "Tietojen vienti ja tilin sulkeminen", symbol: "hand.raised") }
                NavigationLink(value: Route.help) { SettingRow(title: "Ohje", subtitle: "Näin sovellus toimii", symbol: "questionmark.circle") }
            }
            Section {
                LabeledContent("Versio", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
                LabeledContent("Palvelin", value: AppConfig.apiBaseURL.host ?? "")
            } header: { Text("Tietoja") }
            Section {
                Button(role: .destructive) { confirmLogout = true } label: {
                    Label("Kirjaudu ulos", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Asetukset")
        // The lock lives outside SwiftUI state; read it again when coming back from its screen.
        .onAppear { lockEnabled = AppLock.shared.isEnabled }
        .confirmationDialog("Kirjaudutaanko ulos?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Kirjaudu ulos", role: .destructive) { Task { await app.logout() } }
        }
    }

    private func loadProfile() async {
        profileFailure = nil
        do {
            profile = (try await app.api.get("/api/profile") as ProfileResponse).profile
            app.profileChanged(profile)
        }
        catch is CancellationError {}
        catch { profileFailure = error.userMessage }
    }

    /// PATCH /api/profile answers without the mailboxes; keep the ones already loaded.
    private func saved(_ new: Profile) {
        var merged = new
        if merged.imapAccounts == nil { merged.imapAccounts = profile?.imapAccounts }
        profile = merged
        app.profileChanged(merged)
    }

    private func mailSubtitle(_ accounts: [ImapAccount]) -> String {
        switch accounts.count {
        case 0: "Yhdistä Gmail tai muu sähköposti"
        case 1: accounts[0].email
        default: "\(accounts.count) tiliä yhdistetty"
        }
    }

    private func entityLabel(_ type: String) -> String {
        switch type { case "toiminimi": "Toiminimi"; case "kevytyrittaja": "Kevytyrittäjä"; case "oy": "Osakeyhtiö"; default: type }
    }
}

struct SettingRow: View {
    let title: String
    let subtitle: String?
    let symbol: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Theme.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.isEmpty ? "Profiili" : title)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(Theme.ink2) }
            }
        }
    }
}

struct ProfileForm: View {
    enum Section_ { case person, company, seller }
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let original: Profile
    let section: Section_
    let onSaved: (Profile) -> Void
    @State private var edited: Profile?
    /// Perintä fields as typed; checked on save, like the web form.
    @State private var collection: CollectionFields?
    @State private var showCollectionErrors = false
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        Form {
            if let binding = Binding($edited) {
                switch section {
                case .person:
                    Section {
                        TextField("Etunimi", text: binding.firstName.orEmpty)
                        TextField("Sukunimi", text: binding.lastName.orEmpty)
                    } footer: { Text("Sähköposti: \(original.email)") }
                case .company:
                    Section {
                        Picker("Yritysmuoto", selection: binding.entityType) {
                            Text("Toiminimi").tag("toiminimi")
                            Text("Kevytyrittäjä").tag("kevytyrittaja")
                            Text("Osakeyhtiö").tag("oy")
                        }
                        Toggle("ALV-rekisterissä", isOn: binding.vatRegistered)
                        if binding.wrappedValue.vatRegistered {
                            Picker("ALV-verokausi", selection: binding.vatPeriod.orDefault("month")) {
                                Text("Kuukausi").tag("month")
                                Text("Neljännesvuosi").tag("quarter")
                                Text("Vuosi").tag("year")
                            }
                        }
                    }
                case .seller:
                    Section("Yritys") {
                        TextField("Yrityksen nimi", text: binding.businessName.orEmpty)
                        TextField("Y-tunnus", text: binding.businessId.orEmpty)
                        TextField("Puhelin", text: binding.phone.orEmpty).keyboardType(.phonePad)
                    }
                    Section("Osoite") {
                        TextField("Katuosoite", text: binding.addressStreet.orEmpty)
                        TextField("Postinumero", text: binding.addressPostalCode.orEmpty).keyboardType(.numberPad)
                        TextField("Kaupunki", text: binding.addressCity.orEmpty)
                    }
                    Section("Maksutiedot") {
                        TextField("IBAN", text: binding.invoiceIban.orEmpty).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        TextField("BIC", text: binding.invoiceBic.orEmpty).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        TextField("Maksuehdot laskulla", text: binding.invoiceTerms.orEmpty, axis: .vertical)
                    }
                    if let fields = Binding($collection) { collectionSection(fields) }
                }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Tallenna") { Task { await save() } }.disabled(busy) } }
        .onAppear {
            if edited == nil { edited = original }
            if collection == nil { collection = CollectionFields(profile: original) }
        }
    }

    /// "Perintä" (SellerProfileCard.tsx): late interest % per year and the reminder fee.
    private func collectionSection(_ fields: Binding<CollectionFields>) -> some View {
        Section {
            LabeledContent("Viivästyskorko % / v") {
                TextField("11,5", text: fields.interest).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            }
            if showCollectionErrors, let problem = fields.wrappedValue.interestError {
                Text(problem).font(.footnote).foregroundStyle(Theme.danger)
            }
            LabeledContent("Muistutusmaksu (€)") {
                TextField("5,00", text: fields.fee).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            }
            if showCollectionErrors, let problem = fields.wrappedValue.feeError {
                Text(problem).font(.footnote).foregroundStyle(Theme.danger)
            }
        } header: {
            Text("Perintä")
        } footer: {
            Text(CollectionFields.interestHint)
        }
    }

    private var title: String {
        switch section { case .person: "Profiili"; case .company: "Yritysmuoto ja ALV"; case .seller: "Laskuttajan tiedot" }
    }

    private func save() async {
        guard var edited else { return }
        if section == .seller, let collection {
            guard collection.isValid else {
                showCollectionErrors = true
                Haptics.error()
                return
            }
            collection.apply(to: &edited, from: original)
        }
        let patch = ProfilePatch(from: original, to: edited)
        if patch.isEmpty { dismiss(); return }
        busy = true
        defer { busy = false }
        do {
            let response: ProfileResponse = try await app.api.send("PATCH", "/api/profile", body: patch)
            Haptics.success()
            onSaved(response.profile)
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

extension Binding where Value == String? {
    /// A text field over an optional string: empty text is nil.
    var orEmpty: Binding<String> {
        Binding<String>(get: { wrappedValue ?? "" }, set: { wrappedValue = $0.isEmpty ? nil : $0 })
    }
    func orDefault(_ fallback: String) -> Binding<String> {
        Binding<String>(get: { wrappedValue ?? fallback }, set: { wrappedValue = $0 })
    }
}

struct PasswordView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var again = ""
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        Form {
            Section {
                SecureField("Nykyinen salasana", text: $current).textContentType(.password)
                SecureField("Uusi salasana", text: $next).textContentType(.newPassword)
                SecureField("Uusi salasana uudelleen", text: $again).textContentType(.newPassword)
            } footer: { Text("Vähintään 8 merkkiä.") }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .navigationTitle("Vaihda salasana")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Tallenna") { Task { await save() } }.disabled(busy || current.isEmpty || next.count < 8 || next != again)
            }
        }
    }

    private func save() async {
        struct Body: Encodable { let currentPassword: String; let newPassword: String }
        busy = true
        defer { busy = false }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/auth/password", body: Body(currentPassword: current, newPassword: next))
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

struct DevicesView: View {
    @Environment(AppModel.self) private var app
    @State private var sessions: Loadable<[DeviceSession]> = .idle
    @State private var failure: String?
    @State private var limit = ShowMore()

    var body: some View {
        List {
            if let list = sessions.value {
                ForEach(list.prefix(limit.visible(list.count))) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.label + (s.current ? " (tämä laite)" : ""))
                        Text("Käytetty \(InvoiceDetailView.timestamp(s.lastSeenAt ?? s.createdAt))").font(.caption).foregroundStyle(Theme.ink2)
                    }
                    .swipeActions {
                        if !s.current { Button("Kirjaa ulos", role: .destructive) { Task { await signOut(id: s.id) } } }
                    }
                }
                ShowMoreButton(limit: $limit, total: list.count)
                if list.count > 1 {
                    Button(role: .destructive) { Task { await signOutOthers() } } label: { Text("Kirjaa ulos kaikki muut laitteet") }
                }
            } else {
                LoadState(state: sessions, retry: load) { (_: [DeviceSession]) in EmptyView() }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .navigationTitle("Laitteet")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { sessions = .loaded(DeviceSession.currentFirst((try await app.api.get("/api/auth/sessions") as DeviceSessions).sessions)) }
        catch is CancellationError {}
        catch { sessions = .failed(error.userMessage) }
    }

    private func signOut(id: String) async {
        struct Body: Encodable { let id: String }
        do { let _: Ignored = try await app.api.send("POST", "/api/auth/sessions", body: Body(id: id)); await load() }
        catch { failure = error.userMessage }
    }

    private func signOutOthers() async {
        struct Body: Encodable { let scope = "others" }
        do { let _: Ignored = try await app.api.send("POST", "/api/auth/sessions", body: Body()); Haptics.success(); await load() }
        catch { failure = error.userMessage }
    }
}
