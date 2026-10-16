import Foundation

/// Raportit's warm of the Kuitit lists its figures open (motion audit raportit-drill-open): a
/// receipts drill's first page and chip counts are in the cache before the owner taps, so the
/// pushed list paints its rows with the push instead of grey rows the answer then replaces.
public enum ReportDrillWarm {
    /// One GET a drilled `ReceiptsView` asks first, under the query it asks it with.
    public struct Request: Hashable, Sendable {
        public enum Kind: Hashable, Sendable { case list, counts }
        public let kind: Kind
        public let query: [String: String]

        public init(kind: Kind, query: [String: String]) {
            self.kind = kind
            self.query = query
        }

        public var path: String { kind == .list ? "/api/receipts" : "/api/receipts/counts" }
    }

    /// The distinct GETs behind `drills`, in the order the figures are shown: one per query however
    /// many figures open the same list (the counts ignore the tab, so Tulot and Menot share theirs).
    public static func requests(_ drills: [ReportDrill]) -> [Request] {
        var seen = Set<Request>()
        var requests: [Request] = []
        for query in drills.compactMap(\.receiptQuery) {
            for request in [Request(kind: .list, query: ReceiptListPaging.firstQuery(query)),
                            Request(kind: .counts, query: query.countsQuery())] where seen.insert(request).inserted {
                requests.append(request)
            }
        }
        return requests
    }
}

/// Runs Raportit's warms, one screen's worth. The screen reloads often (a pull-to-refresh, a write
/// elsewhere, coming back after a minute), and each reload used to ask every drill again: two
/// GETs per receipts drill the owner mostly never opens (row 23). A list with an answer in the
/// cache, fresh or not, paints with the push and refreshes itself there, so it is not asked here.
public actor ReportDrillWarmer {
    /// At most this many warms on their way at once: a reload (another year, new figures) cancels
    /// the warm, and the GETs not started by then are not sent.
    public static let width = 2

    /// Asked by this screen, answered or on its way; a failed one is dropped, so a later reload tries again.
    private var asked: Set<ReportDrillWarm.Request> = []

    public init() {}

    /// `isCached`: the cache holds an answer for the request. `fetch`: asks it through the cache;
    /// false when it failed.
    public func warm(_ requests: [ReportDrillWarm.Request],
                     isCached: @escaping @Sendable (ReportDrillWarm.Request) async -> Bool,
                     fetch: @escaping @Sendable (ReportDrillWarm.Request) async -> Bool) async {
        var missing: [ReportDrillWarm.Request] = []
        for request in requests where !asked.contains(request) {
            // Claimed before the await, so a second warm running meanwhile does not ask it too.
            asked.insert(request)
            if Task.isCancelled { missing.append(request); continue }
            if await !isCached(request) { missing.append(request) }
        }
        guard !Task.isCancelled else {
            asked.subtract(missing)
            return
        }
        var pending = missing[...]
        await withTaskGroup(of: (ReportDrillWarm.Request, Bool).self) { group in
            func startNext() {
                guard let request = pending.popFirst() else { return }
                group.addTask { (request, await fetch(request)) }
            }
            for _ in 0..<Self.width { startNext() }
            while let (request, answered) = await group.next() {
                if !answered { asked.remove(request) }
                if !Task.isCancelled { startNext() }
            }
        }
        asked.subtract(pending)
    }
}
