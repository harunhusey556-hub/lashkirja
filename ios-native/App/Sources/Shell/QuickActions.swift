import SwiftUI
import AppIntents
import LashKirjaCore

/// Where Home Screen quick actions and App Intents hand over: both become the same
/// `lashkirja://` URL that `AppModel.handle(url:)` reads, so there is one route to maintain.
@MainActor
enum QuickActions {
    private static var handler: ((URL) -> Void)?
    /// An action that arrived before the app model existed (a cold launch from a quick action).
    private static var waiting: URL?

    static func attach(_ handler: @escaping (URL) -> Void) {
        self.handler = handler
        if let url = waiting {
            waiting = nil
            handler(url)
        }
    }

    @discardableResult
    static func deliver(_ action: QuickAction) -> Bool {
        if let handler { handler(action.url) } else { waiting = action.url }
        return true
    }

    @discardableResult
    static func deliver(shortcutType: String) -> Bool {
        guard let action = QuickAction(shortcutType: shortcutType) else { return false }
        return deliver(action)
    }
}

/// SwiftUI has no hook for quick actions: a cold launch passes the item in the connection
/// options, a running app gets it on the window scene delegate.
final class QuickActionAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { QuickActions.deliver(shortcutType: item.type) }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = QuickActionSceneDelegate.self
        return configuration
    }
}

final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(QuickActions.deliver(shortcutType: shortcutItem.type))
    }
}

// MARK: App Intents (Siri, Spotlight, Shortcuts). They only open the app on a screen: no
// data goes in or out, so nothing here touches the network.

struct CaptureReceiptIntent: AppIntent {
    static let title: LocalizedStringResource = "Kuvaa kuitti"
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        QuickActions.deliver(.capture)
        return .result()
    }
}

struct NewInvoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "Uusi lasku"
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        QuickActions.deliver(.newInvoice)
        return .result()
    }
}

struct OpenAssistantIntent: AppIntent {
    static let title: LocalizedStringResource = "Avaa avustaja"
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        QuickActions.deliver(.assistant)
        return .result()
    }
}

struct LashKirjaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CaptureReceiptIntent(),
                    phrases: ["Kuvaa kuitti \(.applicationName)", "Kuvaa kuitti sovelluksella \(.applicationName)"],
                    shortTitle: "Kuvaa kuitti", systemImageName: "camera")
        AppShortcut(intent: NewInvoiceIntent(),
                    phrases: ["Uusi lasku \(.applicationName)", "Tee uusi lasku sovelluksella \(.applicationName)"],
                    shortTitle: "Uusi lasku", systemImageName: "doc.badge.plus")
        AppShortcut(intent: OpenAssistantIntent(),
                    phrases: ["Avaa avustaja \(.applicationName)", "Avustaja \(.applicationName)"],
                    shortTitle: "Avustaja", systemImageName: "bubble.left")
    }
}
