import SwiftUI
import AuthenticationServices
import LashKirjaCore

/// Asetukset → Maksut: the owner's own Stripe account for card payments (Stripe Connect; the money
/// goes straight to it), the on/off switch, and whether this iPhone can take Tap to Pay.
struct PaymentsSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var pos = POSCoordinator.shared
    @State private var state: Loadable<POSStatus> = .idle
    @State private var busy: String?
    @State private var failure: String?
    @State private var notice: String?

    var body: some View {
        List {
            if let status = state.value {
                stripeSection(status)
                if status.enabled { toggleSection(status) }
                deviceSection
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger).font(.footnote) } }
                if let notice { Section { Text(notice).foregroundStyle(Theme.success).font(.footnote) } }
            } else {
                LoadState(state: state, retry: load) { (_: POSStatus) in EmptyView() }.listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Maksut")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .disabled(busy != nil)
    }

    // MARK: Stripe

    @ViewBuilder
    private func stripeSection(_ status: POSStatus) -> some View {
        Section {
            if !status.enabled {
                Text(POSMissing.server.title).font(.subheadline.weight(.semibold))
                Text(POSMissing.server.detail).font(.caption).foregroundStyle(Theme.ink2)
            } else {
                row("Stripe-tili", status.account.connected ? "Yhdistetty" : "Ei yhdistetty", ok: status.account.connected)
                if status.account.connected {
                    row("Yrityksen tiedot", status.account.detailsSubmitted ? "Valmiit" : "Kesken", ok: status.account.detailsSubmitted)
                    row("Korttimaksut", status.account.chargesEnabled ? "Hyväksytty" : "Odottaa Stripeä", ok: status.account.chargesEnabled)
                    row("Tilitykset pankkiin", status.account.payoutsEnabled ? "Käytössä" : "Odottaa Stripeä", ok: status.account.payoutsEnabled)
                    row("Maksupaikka", status.locationId == nil ? "Puuttuu" : "Luotu", ok: status.locationId != nil)
                }
                if !status.account.connected || !status.account.detailsSubmitted || !status.account.chargesEnabled {
                    Button { Task { await onboard() } } label: {
                        HStack {
                            Label(status.account.connected ? "Jatka Stripessä" : "Yhdistä Stripe", systemImage: "link")
                            Spacer()
                            if busy == "onboarding" { ProgressView() }
                        }
                    }
                }
                if status.account.connected {
                    Button { Task { await refresh() } } label: {
                        HStack {
                            Label("Päivitä tila Stripestä", systemImage: "arrow.clockwise")
                            Spacer()
                            if busy == "refresh" { ProgressView() }
                        }
                    }
                }
                if let link = status.dashboardUrl, let url = URL(string: link) {
                    Link(destination: url) { Label("Avaa Stripen hallintapaneeli", systemImage: "arrow.up.right.square") }
                }
            }
        } header: {
            Text("Stripe")
        } footer: {
            if status.enabled {
                Text("Korttimaksut menevät suoraan yrityksesi omalle Stripe-tilille. LashKirja kirjaa maksun laskulle vasta, kun Stripe on vahvistanut sen.")
            }
        }
    }

    private func toggleSection(_ status: POSStatus) -> some View {
        Section {
            Toggle(isOn: Binding(get: { status.posEnabled }, set: { on in Task { await setEnabled(on) } })) {
                Text("Korttimaksut käytössä")
            }
            .tint(Theme.accent)
            .disabled(!status.account.chargesEnabled && !status.posEnabled)
        } footer: {
            if !status.account.chargesEnabled {
                Text("Valinta avautuu, kun Stripe on hyväksynyt korttimaksut.")
            } else {
                Text("Laskulle tulee Korttimaksu-painike, kun lasku on lähetetty ja siinä on avointa summaa.")
            }
        }
    }

    // MARK: Device

    private var deviceSection: some View {
        let device = POSDevice.capability
        return Section {
            row("Tämä iPhone", device.supportsTapToPay ? "Tukee Tap to Payta" : "Ei tue", ok: device.supportsTapToPay)
            row("Tap to Pay -oikeus", device.hasEntitlement ? "Käytössä" : "Puuttuu tästä versiosta", ok: device.hasEntitlement)
            if device.supportsTapToPay {
                Button { Task { await showGuide() } } label: { Label("Näytä ohje", systemImage: "wave.3.right.circle") }
            }
        } header: {
            Text(POSReaderKind.tapToPay.label)
        } footer: {
            if !device.supportsTapToPay {
                Text(POSMissing.deviceSupport.detail)
            } else if !device.hasEntitlement {
                Text(POSMissing.entitlement.detail)
            } else {
                Text("Asiakas vie kortin tai puhelimen iPhonen yläosan päälle. Erillistä maksupäätettä ei tarvita.")
            }
        }
    }

    private func row(_ title: String, _ value: String, ok: Bool) -> some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                Text(value)
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundStyle(ok ? Theme.success : Theme.warning)
            }
            .font(.subheadline)
        }
    }

    // MARK: Actions

    private func load() async {
        pos.bind(app)
        if state.value == nil { state = .loading }
        do {
            let response: POSStatusEnvelope = try await app.api.get("/api/pos/status")
            show(response.status)
        } catch let error as LKError where error.status == 503 || error.status == 404 {
            show(.unavailable)
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.userMessage) } else { failure = error.userMessage }
        }
    }

    private func show(_ status: POSStatus) {
        state = .loaded(status)
        pos.update(status: status)
    }

    /// Stripe's hosted onboarding in an in-app browser; it returns to `lashkirja://pos/onboarding`.
    /// Whatever the owner did there, the account is read again from Stripe afterwards.
    private func onboard() async {
        busy = "onboarding"
        failure = nil
        notice = nil
        defer { busy = nil }
        do {
            let link: POSOnboardingLink = try await app.api.send("POST", "/api/pos/onboarding", body: EmptyBody())
            guard let url = URL(string: link.url) else { failure = "Stripe palautti virheellisen osoitteen."; return }
            do {
                _ = try await webAuth.authenticate(using: url, callbackURLScheme: "lashkirja", preferredBrowserSession: .shared)
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                // Closed early: the details given so far are still saved at Stripe.
            }
            try await refreshStatus()
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func refresh() async {
        busy = "refresh"
        failure = nil
        notice = nil
        defer { busy = nil }
        do {
            try await refreshStatus()
            notice = "Tila päivitetty."
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func refreshStatus() async throws {
        let response: POSStatusEnvelope = try await app.api.send("POST", "/api/pos/onboarding/refresh", body: EmptyBody())
        show(response.status)
        Haptics.success()
    }

    private func setEnabled(_ on: Bool) async {
        busy = "toggle"
        failure = nil
        notice = nil
        defer { busy = nil }
        do {
            let response: POSStatusEnvelope = try await app.api.send("PATCH", "/api/pos/settings", body: POSSettingsPatch(posEnabled: on))
            show(response.status)
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func showGuide() async {
        do {
            if try await TapToPayEducation.present(), case .signedIn(let user) = app.phase {
                TapToPayEducation.markShown(userId: user.userId)
            } else if !POSDevice.isSimulator {
                failure = "Ohjetta ei voitu näyttää tällä laitteella."
            }
        } catch {
            failure = "Ohjetta ei voitu näyttää. Yritä uudelleen."
        }
    }
}
