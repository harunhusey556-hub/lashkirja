import SwiftUI
import LashKirjaCore

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var profile: Profile?
    @State private var profileFailure: String?
    @State private var profileAsked = false
    @State private var lockSubtitle: String = SettingsView.lockRowSubtitle(AppLock.shared)
    @State private var confirmLogout = false
    @State private var queue = OfflineReceiptQueueModel.shared
    @State private var savingAutoLink = false
    @State private var settingFailure: String?

    var body: some View {
        List {
            // The profile AppModel already holds (the launch prefetch read it) shows at once.
            if let profile = profile ?? app.profile {
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
                    // By route, as Laitteet and Pääsyavaimet: the screen is built when pushed, with what
                    // the warm-up below has painted by then. A link's destination was built with this
                    // list, before the warm-up had answered.
                    NavigationLink(value: Route.emailTemplates) {
                        // A message's text, not a mail icon with a dot: the dot read as something unread (X116).
                        SettingRow(title: "Sähköpostimallit", subtitle: "Laskun saateviesti ja aihe", symbol: "text.bubble")
                    }
                    NavigationLink { PaymentsSettingsView() } label: {
                        SettingRow(title: "Maksut", subtitle: "Korttimaksut Stripellä ja Tap to Pay", symbol: "creditcard")
                    }
                }
                Section("Kuitit") {
                    NavigationLink { EmailImportView { self.profile = $0; app.profileChanged($0) } } label: {
                        SettingRow(title: "Sähköpostien tuonti", subtitle: mailSubtitle(profile.imapAccounts ?? []), symbol: "envelope")
                    }
                    // Off by default; "Kohdista varmat (N)" in Kuitit does the same by hand (owner 2026-10-15).
                    Toggle(isOn: Binding(get: { profile.autoLinkSureMatches ?? false }, set: { on in Task { await setAutoLink(on) } })) {
                        SettingRow(title: "Kohdista varmat automaattisesti", subtitle: "Kun viite ja summa täsmäävät, kuitti kohdistetaan pankkitapahtumaan heti.", symbol: "link")
                    }
                    .disabled(profile.autoLinkSureMatches == nil || savingAutoLink)
                    if let settingFailure {
                        Text(settingFailure).font(.footnote).foregroundStyle(Theme.danger)
                    }
                }
            } else if let profileFailure {
                Section {
                    Text(profileFailure).foregroundStyle(Theme.danger)
                    Button("Yritä uudelleen") { Task { await loadProfile() } }
                }
            } else {
                ProgressView()
            }
            Section("Tili ja turvallisuus") {
                NavigationLink { PasswordView() } label: { SettingRow(title: "Vaihda salasana", subtitle: nil, symbol: "key") }
                NavigationLink(value: Route.changeEmail) { SettingRow(title: "Vaihda sähköposti", subtitle: nil, symbol: "at") }
                NavigationLink(value: Route.passkeys) { SettingRow(title: "Pääsyavaimet", subtitle: "Kirjaudu Face ID:llä ilman salasanaa", symbol: "person.badge.key") }
                NavigationLink(value: Route.devices) { SettingRow(title: "Laitteet", subtitle: "Kirjautuneet laitteet", symbol: "iphone") }
                NavigationLink { AppLockSettingsView() } label: { SettingRow(title: "Sovelluslukitus", subtitle: lockSubtitle, symbol: "lock") }
                NavigationLink { NotificationSettingsView() } label: { SettingRow(title: "Ilmoitukset", subtitle: "Muistutukset kuiteista ja laskuista", symbol: "bell") }
            }
            Section("Tietosuoja ja ohje") {
                NavigationLink(value: Route.privacy) { SettingRow(title: "Tietosuoja", subtitle: "Tietojen vienti ja tilin sulkeminen", symbol: "hand.raised") }
                NavigationLink(value: Route.help) { SettingRow(title: "Ohje", subtitle: "Näin sovellus toimii", symbol: "questionmark.circle") }
                NavigationLink { ReportProblemView() } label: { SettingRow(title: "Ilmoita ongelmasta", subtitle: "Lähettää tapahtumalokin tästä hetkestä", symbol: "ladybug") }
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
        .onAppear { lockSubtitle = Self.lockRowSubtitle(AppLock.shared) }
        .perfReady("asetukset", profile ?? app.profile != nil)
        .task {
            // Once per opening: the server's profile replaces the one shown, in place.
            guard !profileAsked else { return }
            profileAsked = true
            if profile == nil { profile = app.profile }
            await loadProfile()
        }
        .task {
            // Maksut's status, asked while the owner reads this screen, so Maksut opens on it.
            let pos = POSCoordinator.shared
            pos.bind(app)
            if pos.status == nil { await pos.refreshStatus() }
        }
        // Laitteet, Sähköpostimallit and Pääsyavaimet, asked while the owner reads this screen: each
        // push slid in a spinner that its list then replaced (M053 M054 M057).
        .task { await app.warmAsetukset() }
        // Signing out deletes the receipts still on the phone (as the web does): the question says how many.
        .confirmSheet(isPresented: $confirmLogout, title: "Kirjaudutaanko ulos?", message: queue.signOutWarning ?? "",
                      confirmTitle: "Kirjaudu ulos") {
            Task { await app.logout() }
        }
    }

    /// The PIN lock and the idle Face ID lock are both on the Sovelluslukitus screen: either one on
    /// reads 'Käytössä'. Read from the PIN alone, the row said 'Ei käytössä' while the app would
    /// lock after 12 hours unused (X153).
    static func lockRowSubtitle(_ lock: AppLock) -> String {
        lock.isEnabled || lock.idleLockEnabled ? "Käytössä" : "Ei käytössä"
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

    private func setAutoLink(_ on: Bool) async {
        guard let current = profile, !savingAutoLink else { return }
        var next = current
        next.autoLinkSureMatches = on
        savingAutoLink = true
        settingFailure = nil
        defer { savingAutoLink = false }
        do {
            let response: ProfileResponse = try await app.api.send("PATCH", "/api/profile", body: ProfilePatch(from: current, to: next))
            Haptics.success()
            saved(response.profile)
        } catch is CancellationError {
        } catch {
            settingFailure = error.userMessage
            Haptics.error()
        }
    }

    /// PATCH /api/profile answers without the mailboxes; keep the ones already loaded.
    private func saved(_ new: Profile) {
        var merged = new
        if merged.imapAccounts == nil { merged.imapAccounts = (profile ?? app.profile)?.imapAccounts }
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
            Image(systemName: symbol).foregroundStyle(Theme.accent).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.isEmpty ? "Profiili" : title)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(Theme.ink2) }
            }
        }
        // The icon is hidden from VoiceOver, so a UI test reads which symbol the row draws from here.
        .accessibilityIdentifier("setting-\(symbol)")
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
    @State private var confirmDiscard = false

    /// What Tallenna would send: the same diff `save()` builds, so "dirty" never disagrees with it.
    private var dirty: Bool {
        guard var edited else { return false }
        if section == .seller, let collection { collection.apply(to: &edited, from: original) }
        return !ProfilePatch(from: original, to: edited).isEmpty
    }

    var body: some View {
        Form {
            if let binding = Binding($edited) {
                switch section {
                case .person:
                    // Each field named in its row: filled, a field lost its only name, the placeholder
                    // (U004, X146). Names are not words to correct (U009).
                    Section {
                        LabeledContent("Etunimi") {
                            TextField("", text: binding.firstName.orEmpty)
                                .textContentType(.givenName).textInputAutocapitalization(.words).autocorrectionDisabled()
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Sukunimi") {
                            TextField("", text: binding.lastName.orEmpty)
                                .textContentType(.familyName).textInputAutocapitalization(.words).autocorrectionDisabled()
                                .multilineTextAlignment(.trailing)
                        }
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
                    // Named in their rows, as the Perintä fields below are: a filled profile was bare
                    // values ('0201256-6', 'NDEAFIHH') once the placeholders had gone (U004).
                    Section("Yritys") {
                        LabeledContent("Yrityksen nimi") {
                            TextField("", text: binding.businessName.orEmpty)
                                .textContentType(.organizationName).textInputAutocapitalization(.words).autocorrectionDisabled()
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Y-tunnus") {
                            TextField("1234567-8", text: binding.businessId.orEmpty).codeInput(.never).multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Puhelin") {
                            TextField("", text: binding.phone.orEmpty).phoneInput().multilineTextAlignment(.trailing)
                        }
                    }
                    Section("Osoite") {
                        LabeledContent("Katuosoite") {
                            TextField("", text: binding.addressStreet.orEmpty)
                                .textContentType(.streetAddressLine1).textInputAutocapitalization(.words)
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Postinumero") {
                            TextField("", text: binding.addressPostalCode.orEmpty).keyboardType(.numberPad).textContentType(.postalCode)
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledContent("Kaupunki") {
                            TextField("", text: binding.addressCity.orEmpty)
                                .textContentType(.addressCity).textInputAutocapitalization(.words)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                    Section("Maksutiedot") {
                        LabeledContent("IBAN") {
                            TextField("FI…", text: binding.invoiceIban.orEmpty).codeInput().multilineTextAlignment(.trailing)
                        }
                        LabeledContent("BIC") {
                            TextField("", text: binding.invoiceBic.orEmpty).codeInput().multilineTextAlignment(.trailing)
                        }
                        // Several lines: the name over the text, which then has the row's width.
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Maksuehdot laskulla").font(.caption).foregroundStyle(Theme.ink2)
                            TextField("", text: binding.invoiceTerms.orEmpty, axis: .vertical).accessibilityLabel("Maksuehdot laskulla")
                        }
                    }
                    if let fields = Binding($collection) { collectionSection(fields) }
                }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .formKeyboard()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Tallenna") { Task { await save() } }.disabled(busy) } }
        .pushedDiscardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
        .onAppear {
            if edited == nil { edited = original }
            if collection == nil { collection = CollectionFields(profile: original) }
        }
    }

    /// "Perintä" (SellerProfileCard.tsx): late interest % per year and the reminder fee.
    private func collectionSection(_ fields: Binding<CollectionFields>) -> some View {
        Section {
            LabeledContent("Viivästyskorko % / v") {
                TextField("11,5", text: fields.interest).moneyInput().multilineTextAlignment(.trailing)
            }
            if showCollectionErrors, let problem = fields.wrappedValue.interestError {
                Text(problem).font(.footnote).foregroundStyle(Theme.danger)
            }
            LabeledContent("Muistutusmaksu (€)") {
                TextField("5,00", text: fields.fee).moneyInput().multilineTextAlignment(.trailing)
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
    private enum Field: Hashable { case current, new, again }
    @FocusState private var focus: Field?
    @State private var confirmDiscard = false
    private var dirty: Bool { !current.isEmpty || !next.isEmpty || !again.isEmpty }

    var body: some View {
        Form {
            // Named in their rows: three rows of dots read alike once typed into (X146). A tap on a row's
            // name opens its field too: the field starts after the name, and 'Uusi salasana uudelleen'
            // covered the row's middle, where a tap went nowhere (P0 K, run 39374559226).
            Section {
                LabeledContent("Nykyinen salasana") {
                    SecureField("", text: $current).textContentType(.password).multilineTextAlignment(.trailing)
                        .focused($focus, equals: .current).submitLabel(.next).onSubmit { focus = .new }
                }
                .contentShape(Rectangle())
                .onTapGesture { focus = .current }
                LabeledContent("Uusi salasana") {
                    SecureField("", text: $next).textContentType(.newPassword).multilineTextAlignment(.trailing)
                        .focused($focus, equals: .new).submitLabel(.next).onSubmit { focus = .again }
                }
                .contentShape(Rectangle())
                .onTapGesture { focus = .new }
                LabeledContent("Uusi salasana uudelleen") {
                    SecureField("", text: $again).textContentType(.newPassword).multilineTextAlignment(.trailing)
                        .focused($focus, equals: .again).submitLabel(.done).onSubmit { focus = nil }
                }
                .contentShape(Rectangle())
                .onTapGesture { focus = .again }
            } footer: { Text("Vähintään 8 merkkiä.") }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .formKeyboard()
        .navigationTitle("Vaihda salasana")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Tallenna") { Task { await save() } }.disabled(busy || current.isEmpty || next.count < 8 || next != again)
            }
        }
        .pushedDiscardGuard(dirty: dirty, busy: busy, asking: $confirmDiscard) { dismiss() }
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
    static let path = "/api/auth/sessions"
    @Environment(AppModel.self) private var app
    @State private var sessions = ScreenLoad<[DeviceSession]>()
    @State private var failure: String?
    @State private var limit = ShowMore()
    @State private var signingOut = false
    @State private var confirmSession: DeviceSession?
    @State private var confirmOthers = false

    /// `preview` (the app's `lastPainted` list, which Asetukset warms) is on screen in the first
    /// frame: the push slid in a 200 pt spinner card that the rows replaced 0.9 s later (M053).
    /// `load` then refreshes it in place.
    init(preview: [DeviceSession]? = nil) {
        guard let preview else { return }
        var shown = ScreenLoad<[DeviceSession]>()
        shown.succeed(preview)
        _sessions = State(initialValue: shown)
    }

    var body: some View {
        List {
            if let list = sessions.value {
                if let banner = sessions.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                ForEach(list.prefix(limit.visible(list.count))) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.label + (s.current ? " (tämä laite)" : ""))
                        Text("Käytetty \(InvoiceDetailView.timestamp(s.lastSeenAt ?? s.createdAt))" + (s.trusted == true ? " · Luotettu laite" : ""))
                            .font(.caption).foregroundStyle(Theme.ink2)
                    }
                    .swipeActions {
                        if !s.current { Button("Kirjaa ulos", role: .destructive) { confirmSession = s } }
                    }
                }
                ShowMoreButton(limit: $limit, total: list.count)
                if list.count > 1 {
                    Button(role: .destructive) { confirmOthers = true } label: { Text("Kirjaa ulos kaikki muut laitteet") }
                        .disabled(signingOut)
                }
            } else {
                ScreenStateView(state: sessions, retry: load) { (_: [DeviceSession]) in EmptyView() }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Laitteet")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmSheet(presenting: $confirmSession) { session in
            ConfirmRequest(
                title: "Kirjataanko laite ulos?",
                message: "\(session.label) kirjataan ulos, ja sinne pitää kirjautua uudelleen.",
                confirmTitle: "Kirjaa ulos",
                onConfirm: { Task { await signOut(id: session.id) } }
            )
        }
        .confirmSheet(
            isPresented: $confirmOthers,
            title: "Kirjataanko kaikki muut laitteet ulos?",
            message: "Vain tämä laite jää kirjautuneeksi. Muille laitteille pitää kirjautua uudelleen.",
            confirmTitle: "Kirjaa ulos kaikki muut"
        ) {
            Task { await signOutOthers() }
        }
    }

    private func load() async {
        let fromSpinner = sessions.value == nil
        sessions.begin()
        do {
            let list = DeviceSession.currentFirst((try await app.api.get(Self.path) as DeviceSessions).sessions)
            // Nothing painted yet: the rows ease in where the spinner was instead of cutting in.
            if fromSpinner { withMotion(.snappy) { sessions.succeed(list) } } else { sessions.succeed(list) }
            app.rememberPainted(list, Self.path)
        }
        catch is CancellationError {}
        catch { sessions.fail(error) }
    }

    private func signOut(id: String) async {
        struct Body: Encodable { let id: String }
        guard !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        do { let _: Ignored = try await app.api.send("POST", "/api/auth/sessions", body: Body(id: id)); await load() }
        catch { failure = error.userMessage }
    }

    private func signOutOthers() async {
        struct Body: Encodable { let scope = "others" }
        guard !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        do { let _: Ignored = try await app.api.send("POST", "/api/auth/sessions", body: Body()); Haptics.success(); await load() }
        catch { failure = error.userMessage }
    }
}
