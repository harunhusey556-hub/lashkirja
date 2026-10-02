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
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(Theme.accent)
                .task { await app.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await app.foreground() } }
                    if phase == .background { AppLock.shared.lockIfEnabled() }
                }
        }
    }
}
