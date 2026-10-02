/// A response whose body the caller does not need (`{ok:true}`, `{invoice:...}`).
public struct Ignored: Decodable, Sendable {
    public init(from decoder: Decoder) throws {}
}
