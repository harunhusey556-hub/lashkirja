import SwiftUI
import LashKirjaCore

/// Tietosuoja (/asetukset/tietosuoja): what is kept, a copy of the data, and closing the account.
struct PrivacyView: View {
    @Environment(AppModel.self) private var app
    @State private var requests = ScreenLoad<[AccountRequest]>()
    @State private var password = ""
    @State private var passwordError: String?
    @State private var formError: String?
    @State private var note: String?
    @State private var busy: AccountRequestBody.Kind?
    @State private var confirmClose = false
    @State private var download: AccountRequest?
    @State private var requestLimit = ShowMore()

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Tilillä ovat nimesi, sähköpostisi ja salasanan tiiviste, yrityksen laskutustiedot, kuitit ja niiden tiedostot, tiliotteet, pankkitilit, asiakkaat, laskut, maksut, yhdistetyn postilaatikon tiedot ja keskustelut avustajan kanssa.")
                    Text("Tietojen kopio sisältää nämä tiedot ja kuittien tiedostot. Siinä ei ole salasanaasi, postilaatikon salasanaa eikä pankkiyhteyden salaisuuksia, eikä tiliotteiden alkuperäisiä tiedostoja.")
                }
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
                .padding(.vertical, 4)
            } header: {
                Text("Mitä LashKirja säilyttää")
            }
            Section {
                Text("Kun kysyt avustajalta jotain, kysymys ja saman keskustelun aiemmat viestit lähetetään tekoälypalveluun vastauksen muodostamista varten. Pankkiyhteyden salaisuuksia ei lähetetä.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
            } header: {
                Text("Avustaja")
            }
            Section {
                Text("Kirjanpitoaineistoa säilytetään \(AccountCopy.retentionYears) vuotta tilikauden päättymisestä. Tilin sulkeminen ei poista kuitteja eikä laskuja. Kuukauden viennin zip löytyy Raporteista.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
            } header: {
                Text("Säilytys")
            }

            requestsSection

            Section {
                SecureField("Nykyinen salasana", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit { Task { await send(.export) } }
                    .onChange(of: password) { _, _ in passwordError = nil }
                if let passwordError {
                    Text(passwordError).font(.footnote).foregroundStyle(Theme.danger)
                }
            } header: {
                Text("Pyyntö tuelle")
            } footer: {
                Text("Nykyinen salasana vahvistaa, että pyyntö tulee sinulta. Tuki käsittelee pyynnön ja ilmoittaa sinulle sähköpostilla.")
            }

            Section {
                Button {
                    Task { await send(.export) }
                } label: {
                    row("Pyydä kopio tiedoista", busy: busy == .export, symbol: "square.and.arrow.down")
                }
                .disabled(password.isEmpty || busy != nil)
                Button(role: .destructive) {
                    if requirePassword() { confirmClose = true }
                } label: {
                    row("Pyydä tilin sulkemista", busy: busy == .close, symbol: "person.crop.circle.badge.xmark")
                }
                .disabled(password.isEmpty || busy != nil)
            } footer: {
                if let formError {
                    Text(formError).foregroundStyle(Theme.danger)
                } else if let note {
                    Text(note).foregroundStyle(Theme.success)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Tietosuoja")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if requests.value == nil { await load() } }
        .sheet(isPresented: $confirmClose) {
            CloseAccountSheet { await send(.close) }
        }
        .sheet(item: $download) { request in
            DocumentPreviewSheet(path: "/api/account/request/\(request.id)/package", fileName: "tietokopio.zip")
        }
    }

    @ViewBuilder private var requestsSection: some View {
        switch requests.display {
        case .failed(let failure):
            Section {
                LoadFailureView(failure: failure, retry: load)
            } header: {
                Text("Pyynnöt")
            }
            .listRowBackground(Color.clear)
        case .content(let rows):
            if let banner = requests.banner {
                Section { RefreshFailureBanner(failure: banner, retry: load) }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if !rows.isEmpty {
            Section {
                ForEach(rows.prefix(requestLimit.visible(rows.count))) { request in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(request.kindLabel).foregroundStyle(Theme.ink)
                            Text(request.statusLabel).font(.caption).foregroundStyle(Theme.ink2)
                            if request.isOpen {
                                Text("Kirjattu \(APIDate.displayDay(request.createdAt)). Tuki ilmoittaa sähköpostilla, kun pyyntö on käsitelty.")
                                    .font(.caption)
                                    .foregroundStyle(Theme.ink2)
                            }
                        }
                        Spacer(minLength: 8)
                        if request.downloadable {
                            Button("Lataa") { download = request }
                                .buttonStyle(.borderless)
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
                ShowMoreButton(limit: $requestLimit, total: rows.count)
            } header: {
                Text("Pyynnöt")
            }
            }
        case .loading:
            EmptyView()
        }
    }

    private func row(_ title: String, busy: Bool, symbol: String) -> some View {
        HStack {
            Label(busy ? "Lähetetään…" : title, systemImage: symbol)
            if busy { Spacer(); ProgressView() }
        }
    }

    /// No request leaves without the password (AUTH-04).
    private func requirePassword() -> Bool {
        if !password.isEmpty { return true }
        passwordError = "Kirjoita nykyinen salasana."
        Haptics.error()
        return false
    }

    private func load() async {
        requests.begin()
        do {
            let list: AccountRequestList = try await app.api.get("/api/account/request")
            requests.succeed(list.requests)
        } catch is CancellationError {
        } catch {
            requests.fail(error)
        }
    }

    /// True when the request was recorded.
    @discardableResult
    private func send(_ kind: AccountRequestBody.Kind) async -> Bool {
        guard busy == nil, requirePassword() else { return false }
        busy = kind
        passwordError = nil
        formError = nil
        note = nil
        defer { busy = nil }
        do {
            let answer: AccountMessageResponse = try await app.api.send("POST", "/api/account/request", body: AccountRequestBody(kind: kind, currentPassword: password))
            password = ""
            Haptics.success()
            note = answer.message ?? "Pyyntö on kirjattu."
            await load()
            return true
        } catch is CancellationError {
            return false
        } catch let error as LKError where error.status == 401 {
            // From this endpoint a 401 means the password was wrong.
            Haptics.error()
            passwordError = error.message
            return false
        } catch {
            Haptics.error()
            formError = error.userMessage
            return false
        }
    }
}

/// Closing the account is asked twice: the full consequences, then the typed word.
private struct CloseAccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    let confirm: () async -> Bool
    @State private var typed = ""
    @State private var sending = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(AccountCopy.closeConfirmation)
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink)
                        .padding(.vertical, 4)
                }
                Section {
                    TextField("Kirjoita \(AccountCopy.closeConfirmWord)", text: $typed)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                } header: {
                    Text("Vahvista")
                } footer: {
                    Text("Kirjoita \(AccountCopy.closeConfirmWord) vahvistaaksesi, että haluat pyytää tilin sulkemista.")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(Theme.danger) }
                }
                Section {
                    Button(role: .destructive) {
                        Task {
                            sending = true
                            let ok = await confirm()
                            sending = false
                            if ok { dismiss() } else { failure = "Pyyntöä ei voitu kirjata. Tarkista salasana ja yritä uudelleen." }
                        }
                    } label: {
                        HStack {
                            Text(sending ? "Lähetetään…" : "Pyydä sulkemista")
                            if sending { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(sending || !AccountCopy.closeConfirmMatches(typed))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .navigationTitle("Pyydetäänkö tilin sulkemista?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Peruuta") { dismiss() }.disabled(sending) }
            }
        }
        .interactiveDismissDisabled(sending)
    }
}
