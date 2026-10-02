import Foundation

extension KeyedDecodingContainer {
    /// A JSON euro number as an exact Decimal: 401.27 stays 401.27 (decoding
    /// Decimal directly can carry binary noise like 401.27000000000001).
    public func decodeMoney(_ key: Key) throws -> Decimal {
        let value = try decode(Double.self, forKey: key)
        return Decimal(string: String(describing: value), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(value)
    }

    public func decodeMoneyIfPresent(_ key: Key) throws -> Decimal? {
        guard let value = try decodeIfPresent(Double.self, forKey: key) else { return nil }
        return Decimal(string: String(describing: value), locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(value)
    }
}
