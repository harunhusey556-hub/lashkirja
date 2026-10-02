/// `ShowMore` for a list the server sends a page at a time (kuitit, sähköposti). The button first
/// reveals the loaded rows ten by ten; only once all of them are on screen and the server holds
/// more does it ask for the next page. Nothing loads by itself on scroll.
public enum PagedShowMore {
    public enum Step: Equatable, Sendable { case reveal, fetch, fold }

    /// What the button does now; nil when the list has no button.
    public static func step(_ limit: ShowMore, loaded: Int, serverHasMore: Bool) -> Step? {
        if limit.visible(loaded) < loaded { return .reveal }
        if serverHasMore { return .fetch }
        return loaded > limit.step ? .fold : nil
    }

    /// "Näytä enemmän (N)", where N also counts what the server still holds.
    public static func title(_ limit: ShowMore, loaded: Int, total: Int, serverHasMore: Bool, loading: Bool = false) -> String? {
        guard let step = step(limit, loaded: loaded, serverHasMore: serverHasMore) else { return nil }
        if loading { return "Ladataan…" }
        if step == .fold { return "Näytä vähemmän" }
        let hidden = max(total, loaded) - limit.visible(loaded)
        return hidden > 0 ? "Näytä enemmän (\(hidden))" : "Näytä enemmän"
    }

    /// After a fetched page: the next rows open. A page that added nothing leaves the list as it was
    /// (a plain `more` would fold it back).
    public static func revealFetched(_ limit: inout ShowMore, before: Int, after: Int) {
        guard after > before else { return }
        limit.more(total: after)
    }
}

extension ShowMore {
    /// Opens the list far enough that the row at `index` is on screen (a deep-linked row).
    public mutating func expand(toInclude index: Int, total: Int) {
        guard index >= 0, index < total else { return }
        while visible(total) <= index { more(total: total) }
    }
}

/// One group of rows at a time (a month, a status, a checklist step): the group picked stays while it
/// still has rows, otherwise the preferred one, otherwise the first.
public enum GroupChoice {
    public static func pick<Key: Equatable>(_ current: Key?, available: [Key], preferred: Key? = nil) -> Key? {
        if let current, available.contains(current) { return current }
        if let preferred, available.contains(preferred) { return preferred }
        return available.first
    }
}
