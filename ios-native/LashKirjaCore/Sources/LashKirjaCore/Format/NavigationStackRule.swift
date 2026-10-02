/// A tab's pushed screens never hold the same screen twice: following a link to a screen that is
/// already open further back returns to it, so cross-links (Pankkiyhteys ↔ Tiliotteet) cannot
/// grow an endless stack.
public enum NavigationStackRule {
    public static func collapse<T: Equatable>(_ path: [T]) -> [T] {
        guard let last = path.last, let first = path.dropLast().firstIndex(of: last) else { return path }
        return Array(path[...first])
    }
}
