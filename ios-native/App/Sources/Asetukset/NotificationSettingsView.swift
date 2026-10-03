import SwiftUI
import UserNotifications
import LashKirjaCore

/// Asetukset → Ilmoitukset: the master switch with iOS's permission, which reminders come,
/// quiet hours, the daily summary and a test notification. The choices stay on this phone.
struct NotificationSettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var prefs = AppNotifications.shared.prefs
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var testMessage: String?

    private var allowed: Bool { status == .authorized || status == .provisional || status == .ephemeral }

    var body: some View {
        Form {
            Section {
                Toggle("Ilmoitukset", isOn: Binding(get: { prefs.enabled }, set: { on in
                    prefs.enabled = on
                    if on && status == .notDetermined { Task { await ask() } }
                }))
                if prefs.enabled { permissionRow }
            } footer: {
                Text("LashKirja muistuttaa, kun ostolle puuttuu kuitti, lasku on myöhässä tai ALV-ilmoitus lähestyy.")
            }

            if prefs.enabled {
                Section("Mistä muistutetaan") {
                    ForEach(NotificationKind.allCases, id: \.self) { kind in
                        Toggle(isOn: Binding(get: { prefs.isOn(kind) }, set: { prefs.set(kind, on: $0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(kind.label)
                                Text(kind.detail).font(.footnote).foregroundStyle(Theme.ink2)
                            }
                        }
                    }
                }

                Section {
                    Toggle("Hiljaiset tunnit", isOn: $prefs.quietHoursOn)
                    if prefs.quietHoursOn {
                        hourPicker("Alkaa", selection: $prefs.quietHours.startHour)
                        hourPicker("Päättyy", selection: $prefs.quietHours.endHour)
                    }
                } footer: {
                    Text("Hiljaisina tunteina ilmoituksia ei näytetä. Ne tulevat, kun hiljaiset tunnit ovat ohi ja sovellus hakee tiedot seuraavan kerran.")
                }

                Section {
                    Toggle("Päivän yhteenveto", isOn: $prefs.dailySummary)
                    if prefs.dailySummary {
                        DatePicker("Aika", selection: summaryTime, displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    Text("Kerran päivässä: mitä on auki. Luvut päivittyvät aina, kun sovellus hakee tiedot. Kun mitään ei ole auki, yhteenvetoa ei tule.")
                }

                Section {
                    Button("Lähetä testi-ilmoitus") { Task { await sendTest() } }
                    if let testMessage { Text(testMessage).font(.footnote).foregroundStyle(Theme.ink2) }
                } footer: {
                    Text("Tiedot haetaan aina, kun avaat sovelluksen. Taustalla iOS päättää itse, milloin ja kuinka usein sovellus saa hakea: yleensä muutaman tunnin välein, harvemmin kun akku on vähissä tai sovellusta käytetään harvoin. Taustapäivitys pitää olla sallittu iOS:n asetuksissa.")
                }
            }
        }
        .navigationTitle("Ilmoitukset")
        .task { status = await AppNotifications.shared.permission() }
        // Back from iOS's own settings: the permission may have changed there.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { status = await AppNotifications.shared.permission() } }
        }
        .onChange(of: prefs) { _, new in AppNotifications.shared.update(new) }
    }

    @ViewBuilder private var permissionRow: some View {
        switch status {
        case .denied:
            VStack(alignment: .leading, spacing: 6) {
                Text("Ilmoitukset on estetty iOS:n asetuksissa.").foregroundStyle(Theme.danger)
                Button("Avaa iOS:n asetukset") { openSettings() }
            }
        case .notDetermined:
            Button("Salli ilmoitukset") { Task { await ask() } }
        default:
            Label("Sallittu", systemImage: "checkmark.circle").foregroundStyle(Theme.success)
        }
    }

    private func hourPicker(_ title: String, selection: Binding<Int>) -> some View {
        Picker(title, selection: selection) {
            ForEach(0..<24, id: \.self) { hour in Text(String(format: "%02d.00", hour)).tag(hour) }
        }
    }

    private var summaryTime: Binding<Date> {
        Binding(
            get: { Calendar.current.date(from: DateComponents(hour: prefs.summaryHour, minute: prefs.summaryMinute)) ?? Date() },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                prefs.summaryHour = parts.hour ?? 18
                prefs.summaryMinute = parts.minute ?? 0
            })
    }

    private func ask() async {
        await AppNotifications.shared.requestPermission()
        status = await AppNotifications.shared.permission()
        if allowed { await AppNotifications.shared.appBecameActive() }
    }

    private func sendTest() async {
        if status == .notDetermined { await ask() }
        guard allowed else {
            testMessage = "Salli ilmoitukset ensin."
            Haptics.error()
            return
        }
        if await AppNotifications.shared.sendTest() {
            testMessage = "Ilmoitus tulee muutaman sekunnin kuluttua."
            Haptics.success()
        } else {
            testMessage = "Ilmoitusta ei voitu lähettää."
            Haptics.error()
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
    }
}
