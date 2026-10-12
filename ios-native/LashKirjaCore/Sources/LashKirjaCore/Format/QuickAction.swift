import Foundation

/// What a `lashkirja://` link, a Home Screen quick action or an App Intent asks the app to open.
/// All three arrive as the same URL so one route in the app handles them.
public enum QuickAction: String, CaseIterable, Equatable, Sendable {
    case capture
    case newInvoice
    case assistant

    private static let scheme = "lashkirja"
    private static let shortcutPrefix = "fi.tiyouba.lashkirja."

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        // `lashkirja://invoice/new` has host "invoice"; `lashkirja:///capture` has none.
        let parts = ([url.host(percentEncoded: false)] + url.path.split(separator: "/").map(String.init))
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .map { $0.lowercased() }
        switch parts {
        case ["capture"]: self = .capture
        case ["invoice", "new"]: self = .newInvoice
        case ["assistant"]: self = .assistant
        default: return nil
        }
    }

    public init?(shortcutType: String) {
        guard let match = Self.allCases.first(where: { $0.shortcutType == shortcutType }) else { return nil }
        self = match
    }

    public var url: URL {
        switch self {
        case .capture: URL(string: "lashkirja://capture")!
        case .newInvoice: URL(string: "lashkirja://invoice/new")!
        case .assistant: URL(string: "lashkirja://assistant")!
        }
    }

    /// The Home Screen quick action's `UIApplicationShortcutItemType` (matches project.yml).
    public var shortcutType: String { Self.shortcutPrefix + rawValue }
}
