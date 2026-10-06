import Foundation

/// What the one quiet indicator says. The phone having no network path is not the only way the
/// server is out of reach (a tunnel or the server itself may be down while the path is fine), so
/// consecutive requests that never got an answer count too.
public struct ReachabilityState: Equatable, Sendable {
    public enum Notice: Equatable, Sendable {
        case offline
        case serverUnreachable

        public var title: String {
            switch self {
            case .offline: "Ei verkkoyhteyttä"
            case .serverUnreachable: "Palvelimeen ei saada yhteyttä"
            }
        }
    }

    /// One slow request is not an outage.
    public static let missesBeforeNotice = 2

    public private(set) var pathSatisfied = true
    public private(set) var misses = 0

    public init() {}

    public var notice: Notice? {
        if !pathSatisfied { return .offline }
        return misses >= Self.missesBeforeNotice ? .serverUnreachable : nil
    }

    public mutating func pathChanged(satisfied: Bool) {
        // Back on a network: judge the server by the next requests, not the ones from before.
        if satisfied && !pathSatisfied { misses = 0 }
        pathSatisfied = satisfied
    }

    public mutating func requestReachedServer() { misses = 0 }

    public mutating func requestMissedServer() { misses = min(misses + 1, 99) }
}
