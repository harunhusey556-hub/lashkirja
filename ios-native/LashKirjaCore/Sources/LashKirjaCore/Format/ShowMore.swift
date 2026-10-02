/// Long lists open on their first rows and grow by the same step ("Näytä enemmän"), so a phone
/// screen is not one endless scroll. Fully open, the button folds the list back.
public struct ShowMore: Sendable, Equatable {
    public static let defaultStep = 10
    public let step: Int
    public private(set) var shown: Int

    public init(step: Int = ShowMore.defaultStep) {
        self.step = max(step, 1)
        self.shown = self.step
    }

    public func visible(_ total: Int) -> Int { min(total, shown) }

    public func buttonTitle(total: Int) -> String? {
        guard total > step else { return nil }
        let hidden = total - visible(total)
        return hidden > 0 ? "Näytä enemmän (\(hidden))" : "Näytä vähemmän"
    }

    public mutating func more(total: Int) {
        shown = visible(total) >= total ? step : shown + step
    }

    /// Back to the first rows, e.g. when a filter changes what the list holds.
    public mutating func reset() { shown = step }
}
