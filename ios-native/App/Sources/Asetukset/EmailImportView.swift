import SwiftUI
import LashKirjaCore

/// Sähköpostien tuonti: the mailboxes the server reads receipts from, as on the web settings page.
struct EmailImportView: View {
    @Environment(AppModel.self) private var app
    let onChange: (Profile) -> Void
    @State private var accounts: Loadable<[ImapAccount]> = .idle
    @State private var adding = false
    @State private var syncing = false
    @State private var note: (text: String, failed: Bool)?
    @State private var disconnecting: ImapAccount?

    var body: some View {
        List {
            Section {
                Text("Yhdistä sähköpostiosoitteesi, niin sovellus hakee ja analysoi automaattisesti siihen saapuneet kuitit.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            }
            if let list = accounts.value {
                if !list.isEmpty {
                    Section {
                        ForEach(list) { account in
                            HStack(spacing: 12) {
                                Image(systemName: "envelope.fill").foregroundStyle(Theme.success).frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(account.email).lineLimit(1).truncationMode(.middle)
                                    Text("Aktiivinen").font(.caption).foregroundStyle(Theme.success)
                                }
                            }
                            .swipeActions {
                                Button("Katkaise", role: .destructive) { disconnecting = account }
                            }
                        }
                        Button {
                            Task { await sync() }
                        } label: {
                            HStack {
                                Label("Synkronoi kuitit nyt", systemImage: "arrow.triangle.2.circlepath")
                                if syncing { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(syncing)
                    } header: {
                        Text("Yhdistetyt tilit")
                    } footer: {
                        if let note { Text(note.text).foregroundStyle(note.failed ? Theme.danger : Theme.success) }
                    }
                }
                Section {
                    Button { adding = true } label: {
                        Label(list.isEmpty ? "Yhdistä sähköpostitili" : "Lisää toinen sähköpostitili", systemImage: "plus.circle.fill")
                    }
                }
            } else {
                LoadState(state: accounts, retry: load) { (_: [ImapAccount]) in EmptyView() }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Sähköpostien tuonti")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if accounts.value == nil { await load() } }
        .sheet(isPresented: $adding) {
            ConnectMailboxSheet { Task { await load() } }
        }
        .confirmationDialog(
            "Katkaise yhteys?",
            isPresented: Binding(get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }),
            titleVisibility: .visible,
            presenting: disconnecting
        ) { account in
            Button("Katkaise yhteys", role: .destructive) { Task { await disconnect(account) } }
        } message: { account in
            Text("Kuitteja ei enää haeta osoitteesta \(account.email). Jo tuodut kuitit säilyvät.")
        }
    }

    private func load() async {
        do {
            let profile = (try await app.api.get("/api/profile") as ProfileResponse).profile
            withAnimation { accounts = .loaded(profile.imapAccounts ?? []) }
            onChange(profile)
        } catch is CancellationError {
        } catch {
            accounts = .failed(error.userMessage)
        }
    }

    private func sync() async {
        guard !syncing else { return }
        syncing = true
        note = ("Etsitään kuitteja…", false)
        defer { syncing = false }
        do {
            let result: ImapSyncResult = try await app.api.send("POST", "/api/integrations/imap/sync", body: EmptyBody())
            note = ("Synkronointi valmis. Löytyi \(result.count) uutta kuittia.", false)
            Haptics.success()
        } catch {
            note = (error.userMessage, true)
            Haptics.error()
        }
    }

    private func disconnect(_ account: ImapAccount) async {
        do {
            let _: Ignored = try await app.api.send("DELETE", "/api/integrations/imap", query: ["id": account.id], body: Optional<EmptyBody>.none)
            Haptics.success()
            await load()
        } catch {
            note = (error.userMessage, true)
            Haptics.error()
        }
    }
}

private struct ConnectMailboxSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let onConnected: () -> Void
    @State private var provider: MailProvider?
    @State private var email = ""
    @State private var password = ""
    @State private var host = ""
    @State private var port = "993"
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focusedField: Bool

    private var request: ImapConnectRequest? {
        ImapConnectRequest(email: email, password: password, host: host, port: port)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let provider {
                    Section {
                        ForEach(Array(provider.steps.enumerated()), id: \.offset) { index, step in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text("\(index + 1).").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.ink2)
                                Text(step).font(.subheadline)
                            }
                        }
                        if let url = provider.helpURL {
                            Button { openURL(url) } label: {
                                Label("Avaa \(provider.title)-tilin asetukset", systemImage: "arrow.up.right.square")
                            }
                        }
                    } header: { Text("Sovellussalasana") }
                    if provider == .other {
                        Section("Palvelin") {
                            TextField("Saapuvan postin palvelin", text: $host)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            TextField("Portti", text: $port).keyboardType(.numberPad)
                        }
                    }
                    Section {
                        TextField("Sähköpostiosoite", text: $email)
                            .textContentType(.emailAddress).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focusedField)
                        SecureField("Sovellussalasana", text: $password)
                            .textContentType(.password)
                    } footer: {
                        Text("Salasana tallennetaan salattuna. Käytä sovellussalasanaa, älä tilin omaa salasanaa.")
                    }
                    if let failure { Text(failure).foregroundStyle(Theme.danger) }
                } else {
                    Section("Valitse palveluntarjoaja") {
                        ForEach(MailProvider.allCases) { option in
                            Button { choose(option) } label: {
                                HStack {
                                    Text(option.title).foregroundStyle(Theme.ink)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2)
                                }
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle(provider?.title ?? "Yhdistä sähköposti")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if provider != nil {
                        Button { withAnimation { provider = nil; failure = nil } } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Takaisin")
                    } else {
                        Button("Peruuta") { dismiss() }
                    }
                }
                if provider != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        if busy { ProgressView() } else {
                            Button("Yhdistä") { Task { await connect() } }.disabled(request == nil)
                        }
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func choose(_ option: MailProvider) {
        withAnimation {
            provider = option
            host = option.host ?? ""
            port = "993"
            failure = nil
        }
        // The field only exists after this update; focus it once it is on screen.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            focusedField = true
        }
    }

    private func connect() async {
        guard let request, !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            // The server logs in to the mailbox before saving it, so this can take a few seconds.
            let _: Ignored = try await app.api.send("POST", "/api/integrations/imap", body: request)
            Haptics.success()
            onConnected()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
