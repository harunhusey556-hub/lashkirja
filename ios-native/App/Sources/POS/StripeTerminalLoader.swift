import Foundation
import LashKirjaCore

/// Loads LashKirjaStripe.framework (Stripe Terminal behind `StripeTerminalDriving`) the first time a
/// card payment needs it. Linked, the SDK cost every launch its load before `main` (w56, row 27);
/// embedded but not linked, an owner who never takes a card payment never loads it.
@MainActor
enum StripeTerminalLoader {
    /// The driver once loaded; nil before the first card payment.
    private(set) static var loaded: StripeTerminalDriving?
    private static var failed = false

    /// The driver, loading the framework on first use. Nil when this install cannot load it: the
    /// payment then fails like a missing reader instead of crashing.
    static func driver() -> StripeTerminalDriving? {
        if let loaded { return loaded }
        guard !failed else { return nil }
        let made = load()
        loaded = made
        failed = made == nil
        return made
    }

    private static func load() -> StripeTerminalDriving? {
        guard let url = Bundle.main.privateFrameworksURL?.appendingPathComponent("LashKirjaStripe.framework"),
              let bundle = Bundle(url: url) else {
            EventLog.shared.log(.action("stripe-load-failed: no LashKirjaStripe.framework", screen: "pos"))
            return nil
        }
        do { try bundle.loadAndReturnError() } catch {
            EventLog.shared.log(.action("stripe-load-failed: \(error.localizedDescription)", screen: "pos"))
            return nil
        }
        guard let type = NSClassFromString("LKStripeTerminalDriver") as? NSObject.Type,
              let driver = type.init() as? StripeTerminalDriving else {
            EventLog.shared.log(.action("stripe-load-failed: no LKStripeTerminalDriver", screen: "pos"))
            return nil
        }
        return driver
    }
}
