import SwiftUI
import LashKirjaCore

enum AppConfig {
    /// From Info.plist `LKAPIBaseURL` (build setting API_BASE_URL).
    static let apiBaseURL: URL = {
        let raw = Bundle.main.object(forInfoDictionaryKey: "LKAPIBaseURL") as? String ?? ""
        return URL(string: raw.trimmingCharacters(in: .whitespaces)) ?? URL(string: "https://invalid.local")!
    }()
}

@main
struct LashKirjaApp: App {
    @UIApplicationDelegateAdaptor(QuickActionAppDelegate.self) private var quickActionDelegate
    @State private var app: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let app = AppModel()
        _app = State(initialValue: app)
        // Before launch finishes: a notification tap that launched the app must find its delegate.
        AppNotifications.shared.activate(app: app)
        // A quick action that launched the app is already waiting in QuickActions.
        QuickActions.attach { url in app.handle(url: url) }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                // The app speaks Finnish: date pickers and system formatting follow it, not the
                // phone's language ("3.10.2026", not "3. Oct 2026").
                .environment(\.locale, Locale(identifier: "fi_FI"))
                .tint(Theme.accent)
                .task {
                    await app.start()
                    await AppNotifications.shared.appBecameActive()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task {
                            await app.foreground()
                            await AppNotifications.shared.appBecameActive()
                        }
                    }
                    if phase == .background {
                        app.background()
                        AppLock.shared.lockIfEnabled()
                        AppNotifications.shared.scheduleBackgroundRefresh()
                    }
                }
                // Links reach the app whatever screen is showing; the sign-in screen takes a
                // reset link from AppModel when it appears.
                .onOpenURL { url in app.handle(url: url) }
        }
        // Background App Refresh: iOS decides when (if ever) this runs; see AppNotifications.
        .backgroundTask(.appRefresh(AppNotifications.refreshTaskId)) {
            await AppNotifications.shared.backgroundRefresh()
        }
    }
}
