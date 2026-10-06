import Foundation

/// A customer or invoice a `lashkirja://customer/<id>` / `lashkirja://invoice/<id>` link opens.
/// Spotlight results carry such a link as their identifier, so a tap goes through the same
/// URL handling as quick actions. `QuickAction` keeps `invoice/new`; this reads the id forms.
public enum OpenTarget: Equatable, Sendable {
    case customer(String)
    case invoice(String)

    private static let scheme = "lashkirja"

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let host = url.host(percentEncoded: false) ?? ""
        var parts = url.path.split(separator: "/").map(String.init)
        if !host.isEmpty { parts.insert(host, at: 0) }
        guard parts.count == 2, !parts[1].isEmpty else { return nil }
        // The id keeps its case; only the kind is case-insensitive.
        switch parts[0].lowercased() {
        case "customer": self = .customer(parts[1])
        case "invoice" where parts[1].lowercased() != "new": self = .invoice(parts[1])
        default: return nil
        }
    }

    public var url: URL {
        switch self {
        case .customer(let id): URL(string: "lashkirja://customer/\(Self.escape(id))")!
        case .invoice(let id): URL(string: "lashkirja://invoice/\(Self.escape(id))")!
        }
    }

    private static func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    }
}
