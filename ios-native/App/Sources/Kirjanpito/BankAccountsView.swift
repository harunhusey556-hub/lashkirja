import SwiftUI
import AuthenticationServices
import LashKirjaCore

struct BankAccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var overview: BankAccountsOverview?
    @State private var connections: BankConnections?
    @State private var showPicker = false
    @State private var failure: String?
    @State private var notice: String?
    @State private var syncing: String?
    @State private var loadFailed = false
    @State private var showArchived = false
    @State private var detail: BankAccount?
    @State private var adding = false
    @State private var disconnecting: BankConnection?

    var body: some View {
        List {
            if let overview {
                Section {
                    LabeledContent("Saldo yhteensä") { MoneyText(amount: overview.totalBalance).fontWeight(.semibold) }
                    if overview.needsAttention > 0 {
                        Text("\(overview.needsAttention) vaatii saldon tarkistusta").font(.caption).foregroundStyle(Theme.danger)
                    }
                }
                Section {
                    if overview.accounts.isEmpty {
                        Text((overview.archivedCount ?? 0) > 0
                             ? "Ei käytössä olevia tilejä. Arkistoituja tilejä on \(overview.archivedCount ?? 0)."
                             : "Ei vielä tilejä. Yhdistä pankki tai tuo tiliote tiedostona.")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(overview.accounts) { account in
                        Button { detail = account } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(account.name).foregroundStyle(Theme.ink)
                                    Spacer()
                                    if let balance = account.balance { MoneyText(amount: balance).foregroundStyle(Theme.ink) }
                                }
                                Text(BankAccountText.subtitle(account)).font(.caption).foregroundStyle(Theme.ink2)
                            }
                            .contentShape(Rectangle())
                            .opacity(account.archivedAt == nil ? 1 : 0.6)
                        }
                        .buttonStyle(.plain)
                    }
                    Button { adding = true } label: { Label("Lisää tili käsin", systemImage: "plus.circle") }
                    if showArchived || (overview.archivedCount ?? 0) > 0 {
                        Button(showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut (\(overview.archivedCount ?? 0))") {
                            showArchived.toggle()
                        }
                    }
                } header: {
                    Text("Kirjanpidon tilit")
                }
            }
            Section("Pankkiyhteys") {
                if let connections {
                    if !connections.enabled || !connections.ready {
                        Text(connections.message ?? "Pankkiyhteys ei ole käytössä.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(connections.connections) { connection in
                        HStack {
                            BankLogo(name: connection.aspspName, logo: connection.aspspLogo)
                            VStack(alignment: .leading) {
                                Text(connection.aspspName)
                                Text(status(connection)).font(.caption).foregroundStyle(Theme.ink2)
                            }
                            Spacer()
                            if syncing == connection.id { ProgressView() }
                        }
                        .swipeActions {
                            Button("Katkaise", role: .destructive) { disconnecting = connection }
                            Button("Päivitä") { Task { await sync(connection) } }.tint(Theme.accentFill)
                        }
                        .contextMenu {
                            Button { Task { await sync(connection) } } label: { Label("Päivitä", systemImage: "arrow.clockwise") }
                            Button(role: .destructive) { disconnecting = connection } label: { Label("Katkaise yhteys", systemImage: "xmark.circle") }
                        }
                    }
                    if connections.enabled && connections.ready {
                        Button { showPicker = true } label: { Label("Yhdistä pankki", systemImage: "plus.circle") }
                    }
                } else if loadFailed {
                    Button("Yritä uudelleen") { Task { await load() } }
                } else {
                    ProgressView()
                }
            }
            if let notice { Text(notice).foregroundStyle(Theme.success) }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Pankkiyhteys ja tilit")
        .sheet(isPresented: $showPicker, onDismiss: { Task { await load() } }) { BankPickerSheet() }
        .sheet(isPresented: $adding) {
            BankAccountFormSheet(account: nil) { message in Task { await changed(message) } }
        }
        .sheet(item: $detail) { account in
            BankAccountDetailSheet(account: account) { message in Task { await changed(message) } }
        }
        .confirmationDialog(
            "Katkaise pankkiyhteys?",
            isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }),
            titleVisibility: .visible,
            presenting: disconnecting
        ) { connection in
            Button("Katkaise yhteys", role: .destructive) { Task { await disconnect(connection) } }
        } message: { _ in
            Text("Suostumus pankissa suljetaan. Jo haetut tiliotteet säilyvät.")
        }
        .refreshable { await load() }
        .task(id: showArchived) { await load() }
    }

    private func status(_ c: BankConnection) -> String {
        if let error = c.lastError, !error.isEmpty { return error }
        if let last = c.lastSyncAt { return "Haettu \(InvoiceDetailView.timestamp(last))" }
        return c.status == "active" ? "Yhdistetty" : c.status
    }

    private func load() async {
        var problem: String?
        do { overview = try await app.api.get("/api/bank-accounts", query: showArchived ? ["includeArchived": "1"] : [:]) }
        catch is CancellationError { return }
        catch { problem = error.userMessage }
        do { connections = try await app.api.get("/api/bank/connections") }
        catch is CancellationError { return }
        catch { problem = problem ?? error.userMessage }
        loadFailed = connections == nil && problem != nil
        failure = problem
    }

    private func changed(_ message: String?) async {
        notice = message
        app.dataVersion += 1
        await load()
    }

    private func sync(_ c: BankConnection) async {
        syncing = c.id
        defer { syncing = nil }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/bank/connections/\(c.id)/sync", body: EmptyBody())
            Haptics.success()
            app.dataVersion += 1
            await load()
        } catch {
            failure = error.userMessage
        }
    }

    private func disconnect(_ c: BankConnection) async {
        syncing = c.id
        defer { syncing = nil }
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/bank/connections/\(c.id)", body: Optional<EmptyBody>.none)
            Haptics.success()
            await changed("Pankkiyhteys katkaistu. Jo haetut tiliotteet säilyvät.")
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// Add or edit a ledger bank account (`POST /api/bank-accounts`, `PATCH /api/bank-accounts/[id]`).
struct BankAccountFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let account: BankAccount?
    /// Called after a save with the message to show, if any.
    let onSaved: (String?) -> Void
    @State private var draft = BankAccountDraft()
    @State private var date = Date()
    @State private var errors = BankAccountDraft.Errors()
    @State private var busy = false
    @State private var failure: String?
    @State private var filled = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tilin nimi", text: $draft.name, prompt: Text("Käyttötili"))
                    fieldError(errors.name)
                    TextField("IBAN", text: $draft.iban, prompt: Text("FI21 1234 5600 0007 85"))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    fieldError(errors.iban)
                    TextField("Pankki", text: $draft.bankName, prompt: Text("Nordea"))
                    TextField("BIC", text: $draft.bic)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("Valuutta", text: $draft.currency)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    fieldError(errors.currency)
                } footer: {
                    Text("IBAN on vapaaehtoinen – käteiskassalla ei ole IBANia.")
                }
                Section {
                    TextField("Avaussaldo", text: $draft.openingBalance).keyboardType(.numbersAndPunctuation)
                    fieldError(errors.openingBalance)
                    DatePicker("Avauspäivä", selection: $date, displayedComponents: .date)
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
            }
            .navigationTitle(account == nil ? "Uusi pankkitili" : "Muokkaa tiliä")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(account == nil ? "Lisää tili" : "Tallenna") { Task { await save() } }.disabled(busy)
                }
            }
            .onAppear(perform: fill)
        }
    }

    @ViewBuilder private func fieldError(_ text: String?) -> some View {
        if let text { Text(text).font(.caption).foregroundStyle(Theme.danger) }
    }

    private func fill() {
        guard !filled else { return }
        filled = true
        if let account { draft = BankAccountDraft(account: account) }
        date = APIDate.day(draft.openingDate) ?? Date()
    }

    private func save() async {
        struct Saved: Decodable {
            struct Account: Decodable { let name: String? }
            let restored: Bool?
            let account: Account?
        }
        var current = draft
        current.openingDate = APIDate.dayString(date)
        let payload: BankAccountPayload
        switch current.validate() {
        case .success(let value):
            payload = value
            errors = BankAccountDraft.Errors()
        case .failure(let problems):
            errors = problems
            Haptics.error()
            return
        }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let saved: Saved
            if let account {
                saved = try await app.api.send("PATCH", "/api/bank-accounts/\(account.id)", body: payload)
            } else {
                saved = try await app.api.send("POST", "/api/bank-accounts", body: payload)
            }
            Haptics.success()
            var message: String?
            if saved.restored == true {
                let name = saved.account?.name.map { " \"\($0)\"" } ?? ""
                message = "Tämä IBAN kuului arkistoituun tiliin\(name). Tili palautettiin käyttöön entisillä tiedoillaan."
            }
            onSaved(message)
            dismiss()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}

/// One ledger account: edit, default, archive/restore, remove, and the monthly balances.
struct BankAccountDetailSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let account: BankAccount
    let onChanged: (String?) -> Void
    @State private var rollforward: Loadable<BankRollforward> = .idle
    @State private var editing = false
    @State private var confirmRemove = false
    @State private var balanceMonth: String?
    @State private var balanceText = ""
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(BankAccountText.subtitle(account)).font(.caption).foregroundStyle(Theme.ink2)
                    if let iban = account.iban {
                        LabeledContent("IBAN") { Text(BankIBAN.format(iban)).textSelection(.enabled) }
                    }
                    if let balance = account.balance {
                        LabeledContent("Saldo") { MoneyText(amount: balance).fontWeight(.semibold) }
                    }
                }
                Section {
                    Button { editing = true } label: { Label("Muokkaa", systemImage: "pencil") }
                    if account.isDefault != true && account.archivedAt == nil {
                        Button { Task { await patch(isDefault: true) } } label: { Label("Aseta oletukseksi", systemImage: "star") }
                    }
                    if account.archivedAt != nil {
                        Button { Task { await patch(archived: false) } } label: { Label("Palauta käyttöön", systemImage: "arrow.uturn.backward") }
                    }
                    if !(account.archivedAt != nil && (account.statementCount ?? 0) > 0) {
                        Button(role: .destructive) { confirmRemove = true } label: { Label("Poista", systemImage: "trash") }
                    }
                }
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                Section {
                    switch rollforward {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity)
                    case .failed(let message):
                        Text(message).foregroundStyle(Theme.danger)
                        Button("Yritä uudelleen") { Task { await load() } }
                    case .loaded(let value):
                        if let note = excludedNote(value) {
                            Text(note).font(.caption).foregroundStyle(Theme.warning)
                        }
                        if value.months.isEmpty {
                            Text("Ei vielä kuukausia.").foregroundStyle(Theme.ink2)
                        }
                        ForEach(Array(value.months.reversed())) { month in
                            Button { startBalance(month) } label: { BankBalanceRow(month: month) }
                                .buttonStyle(.plain)
                                .swipeActions {
                                    if month.reportedClosing != nil {
                                        Button("Poista", role: .destructive) { Task { await clearBalance(month.month) } }
                                    }
                                }
                        }
                    }
                } header: {
                    Text("Kuukausien saldot")
                } footer: {
                    Text("Napauta kuukautta ja kirjaa pankin ilmoittama loppusaldo.")
                }
            }
            .navigationTitle(account.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Valmis") { dismiss() } } }
            .disabled(busy)
            .sheet(isPresented: $editing) {
                BankAccountFormSheet(account: account) { message in
                    onChanged(message)
                    dismiss()
                }
            }
            .confirmationDialog("Poistetaanko pankkitili?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Poista", role: .destructive) { Task { await remove() } }
            } message: {
                Text(BankAccountText.removeDescription(account))
            }
            .alert("Kirjaa saldo", isPresented: Binding(get: { balanceMonth != nil }, set: { if !$0 { balanceMonth = nil } })) {
                TextField("Pankin saldo", text: $balanceText).keyboardType(.numbersAndPunctuation)
                Button("Tallenna") { Task { await saveBalance() } }
                Button("Peruuta", role: .cancel) { balanceMonth = nil }
            } message: {
                Text("Kuukauden \(StatementText.month(balanceMonth)) loppusaldo pankin mukaan.")
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func excludedNote(_ r: BankRollforward) -> String? {
        var parts: [String] = []
        if let n = r.excluded?.preOpeningTxCount, n > 0 {
            parts.append("\(n) tapahtumaa on ennen avauspäivää (\(Money.format(r.excluded?.preOpeningAmount ?? 0))) eikä niitä lasketa mukaan.")
        }
        if let n = r.excluded?.undatedTxCount, n > 0 { parts.append("\(n) tapahtumalta puuttuu päivä.") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func startBalance(_ month: BankRollforward.Month) {
        balanceText = Money.format(month.reportedClosing ?? month.computedClosing).replacingOccurrences(of: "\u{00A0}€", with: "")
        balanceMonth = month.month
    }

    private func load() async {
        if rollforward.value == nil { rollforward = .loading }
        do {
            let value: BankRollforward = try await app.api.get("/api/bank-accounts/\(account.id)")
            rollforward = .loaded(value)
        } catch is CancellationError {
        } catch {
            if rollforward.value == nil { rollforward = .failed(error.userMessage) }
        }
    }

    private func run(_ work: () async throws -> Void) async -> Bool {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await work()
            Haptics.success()
            return true
        } catch is CancellationError {
            return false
        } catch {
            failure = error.userMessage
            Haptics.error()
            return false
        }
    }

    private func saveBalance() async {
        guard let month = balanceMonth else { return }
        balanceMonth = nil
        let text = balanceText
        let ok = await run {
            let body = try BankBalanceInput.make(month: month, amount: text)
            let _: Ignored = try await app.api.send("PUT", "/api/bank-accounts/\(account.id)/balances", body: body)
        }
        if ok {
            app.dataVersion += 1
            await load()
        }
    }

    private func clearBalance(_ month: String) async {
        let ok = await run {
            let _: Ignored = try await app.api.send("DELETE", "/api/bank-accounts/\(account.id)/balances", query: ["month": month], body: Optional<EmptyBody>.none)
        }
        if ok {
            app.dataVersion += 1
            await load()
        }
    }

    private func patch(isDefault: Bool? = nil, archived: Bool? = nil) async {
        struct Body: Encodable { let isDefault: Bool?; let archived: Bool? }
        let ok = await run {
            let _: Ignored = try await app.api.send("PATCH", "/api/bank-accounts/\(account.id)", body: Body(isDefault: isDefault, archived: archived))
        }
        if ok {
            onChanged(archived == false ? "Tili on taas käytössä." : nil)
            dismiss()
        }
    }

    private func remove() async {
        var message: String?
        let ok = await run {
            let result: BankAccountRemoval = try await app.api.send("DELETE", "/api/bank-accounts/\(account.id)", body: Optional<EmptyBody>.none)
            message = result.message
        }
        if ok {
            onChanged(message)
            dismiss()
        }
    }
}

/// One month of an account's balance roll-forward.
struct BankBalanceRow: View {
    let month: BankRollforward.Month
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(StatementText.month(month.month)).foregroundStyle(Theme.ink)
                Text(month.statusLabel)
                    .font(.caption)
                    .foregroundStyle(month.status == "reconciled" ? Theme.success : month.status == "mismatch" ? Theme.danger : Theme.ink2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                MoneyText(amount: month.computedClosing).foregroundStyle(Theme.ink)
                if let reported = month.reportedClosing {
                    Text("Pankin saldo: \(Money.format(reported))").font(.caption).foregroundStyle(Theme.ink2)
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// Bank selection and the Enable Banking consent in a system auth session.
struct BankPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var psuType = "personal"
    @State private var banks: Loadable<[Aspsp]> = .idle
    @State private var search = ""
    @State private var connecting: String?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                Picker("Tili", selection: $psuType) {
                    Text("Henkilö").tag("personal")
                    Text("Yritys").tag("business")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                if let failure { Text(failure).foregroundStyle(Theme.danger) }
                if let list = banks.value {
                    ForEach(list.filter { BankSearch.matches($0.name, search) }) { bank in
                        Button { Task { await connect(bank) } } label: {
                            HStack {
                                BankLogo(name: bank.name, logo: bank.logo)
                                Text(bank.name).foregroundStyle(Theme.ink)
                                Spacer()
                                if connecting == bank.name { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(Theme.ink2) }
                            }
                        }
                        .disabled(connecting != nil)
                    }
                } else {
                    LoadState(state: banks, retry: load) { (_: [Aspsp]) in EmptyView() }
                }
            }
            .searchable(text: $search, prompt: "Hae pankkia")
            .navigationTitle("Yhdistä pankki")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() } } }
            .task(id: psuType) { await load() }
        }
    }

    private func load() async {
        banks = .loading
        do {
            let list: AspspList = try await app.api.get("/api/bank/aspsps", query: ["country": "FI", "psuType": psuType])
            banks = .loaded(list.aspsps)
        } catch is CancellationError {
        } catch {
            banks = .failed(error.userMessage)
        }
    }

    private func connect(_ bank: Aspsp) async {
        struct Start: Encodable { let aspspName: String; let aspspCountry = "FI"; let psuType: String; let client = "app" }
        struct Started: Decodable { let url: String }
        struct Callback: Encodable { let code: String; let state: String }
        connecting = bank.name
        failure = nil
        defer { connecting = nil }
        do {
            let started: Started = try await app.api.send("POST", "/api/bank/connections", body: Start(aspspName: bank.name, psuType: psuType))
            guard let url = URL(string: started.url) else { return }
            let callback = try await webAuth.authenticate(using: url, callbackURLScheme: "lashkirja", preferredBrowserSession: .shared)
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let error = items.first(where: { $0.name == "error" })?.value {
                failure = error == "access_denied" || error == "cancelled" ? "Yhdistäminen peruttiin." : "Pankki palautti virheen: \(error)"
                return
            }
            guard let code = items.first(where: { $0.name == "code" })?.value, let state = items.first(where: { $0.name == "state" })?.value else {
                failure = "Pankin paluuosoitteesta puuttui tunniste."
                return
            }
            let _: Ignored = try await app.api.send("POST", "/api/bank/connections/callback", body: Callback(code: code, state: state))
            Haptics.success()
            dismiss()
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            failure = nil
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }
}


/// Bank logos decoded once per app run, shared by every row and the picker.
@MainActor
enum BankLogoCache {
    static let images = NSCache<NSString, UIImage>()
    private static var inFlight: [String: Task<UIImage?, Never>] = [:]
    private static var failed: Set<String> = []

    static func cached(_ src: String?) -> UIImage? {
        guard let src else { return nil }
        return images.object(forKey: src as NSString)
    }

    /// One download per logo: a second row asking meanwhile waits for the first.
    static func image(for src: String, api: APIClient) async -> UIImage? {
        if let hit = cached(src) { return hit }
        if failed.contains(src) { return nil }
        if let running = inFlight[src] { return await running.value }
        let task = Task<UIImage?, Never> {
            guard let response = try? await api.raw("GET", "/api/bank/logo", query: ["src": src], body: nil, contentType: nil),
                  let decoded = UIImage(data: response.body) else { return nil }
            return await decoded.byPreparingForDisplay() ?? decoded
        }
        inFlight[src] = task
        let result = await task.value
        inFlight[src] = nil
        if let result { images.setObject(result, forKey: src as NSString) } else { failed.insert(src) }
        return result
    }
}

/// The bank's logo through the server's proxy, or its initial.
struct BankLogo: View {
    @Environment(AppModel.self) private var app
    let name: String
    let logo: String?
    @State private var image: UIImage?

    /// A cached copy paints at once, without waiting for the task.
    private var shown: UIImage? { image ?? BankLogoCache.cached(logo) }

    var body: some View {
        Group {
            if let shown {
                Image(uiImage: shown).resizable().scaledToFit().padding(4)
            } else {
                Text(String(name.prefix(1))).font(.headline).foregroundStyle(Theme.ink2)
            }
        }
        .frame(width: 36, height: 36)
        .background(shown == nil ? Theme.surface : Color.white, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line))
        .task(id: logo) {
            guard let logo, shown == nil else { return }
            image = await BankLogoCache.image(for: logo, api: app.api)
        }
    }
}
