import SwiftUI
import AuthenticationServices
import LashKirjaCore

struct BankAccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var overview: BankAccountsOverview?
    @State private var connections: BankConnections?
    @State private var showPicker = false
    @State private var failure: String?
    @State private var syncing: String?

    var body: some View {
        List {
            if let overview {
                Section {
                    LabeledContent("Saldo yhteensä") { MoneyText(amount: overview.totalBalance).fontWeight(.semibold) }
                }
                if !overview.accounts.isEmpty {
                    Section("Tilit") {
                        ForEach(overview.accounts) { account in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(account.name)
                                    Spacer()
                                    if let balance = account.balance { MoneyText(amount: balance) }
                                }
                                if let iban = account.iban { Text(iban).font(.caption).foregroundStyle(Theme.ink2) }
                            }
                        }
                    }
                }
            }
            Section("Pankkiyhteys") {
                if let connections {
                    if !connections.enabled || !connections.ready {
                        Text(connections.message ?? "Pankkiyhteys ei ole käytössä.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(connections.connections) { connection in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                BankLogo(name: connection.aspspName, logo: connection.aspspLogo)
                                VStack(alignment: .leading) {
                                    Text(connection.aspspName)
                                    Text(status(connection)).font(.caption).foregroundStyle(Theme.ink2)
                                }
                                Spacer()
                                if syncing == connection.id { ProgressView() }
                            }
                        }
                        .swipeActions {
                            Button("Päivitä") { Task { await sync(connection) } }.tint(Theme.accent)
                        }
                    }
                    if connections.enabled && connections.ready {
                        Button { showPicker = true } label: { Label("Yhdistä pankki", systemImage: "plus.circle") }
                    }
                } else {
                    ProgressView()
                }
            }
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Pankkiyhteys ja tilit")
        .sheet(isPresented: $showPicker, onDismiss: { Task { await load() } }) { BankPickerSheet() }
        .refreshable { await load() }
        .task { await load() }
    }

    private func status(_ c: BankConnection) -> String {
        if let error = c.lastError, !error.isEmpty { return error }
        if let last = c.lastSyncAt { return "Haettu \(InvoiceDetailView.timestamp(last))" }
        return c.status == "active" ? "Yhdistetty" : c.status
    }

    private func load() async {
        overview = try? await app.api.get("/api/bank-accounts")
        connections = try? await app.api.get("/api/bank/connections")
    }

    private func sync(_ c: BankConnection) async {
        syncing = c.id
        defer { syncing = nil }
        do {
            let _: Ignored = try await app.api.send("POST", "/api/bank/connections/\(c.id)/sync", body: EmptyBody())
            Haptics.success()
            await load()
        } catch {
            failure = error.userMessage
        }
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

/// The bank's logo through the server's proxy, or its initial.
struct BankLogo: View {
    @Environment(AppModel.self) private var app
    let name: String
    let logo: String?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit().padding(4)
            } else {
                Text(String(name.prefix(1))).font(.headline).foregroundStyle(Theme.ink2)
            }
        }
        .frame(width: 36, height: 36)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line))
        .task(id: logo) {
            guard let logo, image == nil else { return }
            if let response = try? await app.api.raw("GET", "/api/bank/logo", query: ["src": logo], body: nil, contentType: nil) {
                image = UIImage(data: response.body)
            }
        }
    }
}
