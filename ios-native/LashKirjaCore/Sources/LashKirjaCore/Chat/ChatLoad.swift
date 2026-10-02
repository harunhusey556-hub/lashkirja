import Foundation

/// Marks which load is the latest: a slow answer to an older request is dropped
/// instead of overwriting what the owner has done since.
public struct LoadGeneration: Sendable, Equatable {
    public private(set) var current = 0

    public init() {}

    /// Starts a new generation; results of every earlier one are stale from now on.
    @discardableResult
    public mutating func next() -> Int {
        current &+= 1
        return current
    }

    public func isCurrent(_ generation: Int) -> Bool { generation == current }
}

public extension Array where Element: Identifiable {
    /// Each id once (the first occurrence wins, order kept): lists and lazy stacks
    /// must never see the same id twice.
    func uniquedById() -> [Element] {
        var seen = Set<Element.ID>()
        return filter { seen.insert($0.id).inserted }
    }
}
