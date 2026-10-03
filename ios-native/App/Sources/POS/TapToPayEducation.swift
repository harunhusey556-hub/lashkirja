import UIKit
#if canImport(ProximityReader)
import ProximityReader
#endif
import LashKirjaCore

/// Apple's own "How to Tap" guide (ProximityReaderDiscovery), shown before the owner's first card
/// payment on this device and again from Asetukset → Maksut. Apple requires merchants to be shown it.
@MainActor
enum TapToPayEducation {
    static func wasShown(userId: String) -> Bool {
        UserDefaults.standard.bool(forKey: POSEducation.key(userId: userId))
    }

    static func markShown(userId: String) {
        UserDefaults.standard.set(true, forKey: POSEducation.key(userId: userId))
    }

    /// Shows the guide once per owner; later calls do nothing.
    static func showIfFirstUse(userId: String) async {
        guard !wasShown(userId: userId) else { return }
        if (try? await present()) == true { markShown(userId: userId) }
    }

    /// Presents the system guide over the top screen. False when this device has none to show
    /// (simulator, unsupported iPhone).
    @discardableResult
    static func present() async throws -> Bool {
        #if canImport(ProximityReader) && !targetEnvironment(simulator)
        guard PaymentCardReader.isSupported, let top = topViewController() else { return false }
        let discovery = ProximityReaderDiscovery()
        let content = try await discovery.content(for: .payment(.howToTap))
        try await discovery.presentContent(content, from: top)
        return true
        #else
        return false
        #endif
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
