/// Koti's rows the owner just acted on (Hyväksy, Kohdista): gone from the list at once,
/// and kept hidden across reloads while the action waits for "Kumoa" or is on its way.
/// After the server has accepted it, only a load that started later shows the truth: a
/// load that was already running answers with the old row and must not bring it back.
public struct KotiHiddenRows: Sendable, Equatable {
    public private(set) var ids: Set<String> = []
    private var inFlight: Set<String> = []
    /// Row id → the load generation current when its action was accepted.
    private var settledAt: [String: Int] = [:]

    public init() {}

    public func contains(_ id: String) -> Bool { ids.contains(id) }

    public mutating func hide(_ id: String) {
        ids.insert(id)
        inFlight.insert(id)
        settledAt[id] = nil
    }

    /// Undone, or the server refused: the row comes back.
    public mutating func unhide(_ id: String) {
        ids.remove(id)
        inFlight.remove(id)
        settledAt[id] = nil
    }

    /// The server accepted the action while `loadGeneration` was the latest load.
    public mutating func settled(_ id: String, loadGeneration: Int) {
        guard inFlight.remove(id) != nil else { return }
        settledAt[id] = loadGeneration
    }

    /// Fresh data from the load numbered `loadGeneration`: an id stays hidden while its row is
    /// still there and its action is pending, or was accepted after this load started.
    public mutating func reloaded(present: some Sequence<String>, loadGeneration: Int) {
        let present = Set(present)
        ids = ids.filter { id in
            guard present.contains(id) else { return false }
            if inFlight.contains(id) { return true }
            if let settled = settledAt[id] { return loadGeneration <= settled }
            return false
        }
        inFlight.formIntersection(ids)
        settledAt = settledAt.filter { ids.contains($0.key) }
    }
}
