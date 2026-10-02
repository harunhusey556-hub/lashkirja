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
    var body: some Scene {
        WindowGroup {
            Text("LashKirja \(LashKirjaCore.apiVersion)")
        }
    }
}
