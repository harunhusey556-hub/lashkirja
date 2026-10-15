import Foundation

/// `GET /api/bootstrap`: who is signed in, the server's data version and the Kuitit counts in one
/// round trip. Every part is read leniently and may be missing; an older server answers 404 and
/// the app asks `/api/auth/me`, `/api/sync/version` and the counts on their own instead.
public struct AppBootstrap: Decodable, Sendable {
    public let user: AuthUser?
    /// The `/api/sync/version` answer, at the top level or under `version`/`sync`.
    public let version: SyncVersion?
    /// The Kuitit tab counts (`/api/receipts/counts`, kind=receipt), under `counts.receipts`,
    /// `receiptCounts` or `counts`.
    public let receiptCounts: ReceiptCounts.Counts?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: LenientKey.self)
        user = (try? c.decodeIfPresent(AuthUser.self, forKey: LenientKey("user"))) ?? nil
        if let nested = (try? c.decodeIfPresent(SyncVersion.self, forKey: LenientKey("version"))) ?? nil,
           nested.dataVersion != nil {
            version = nested
        } else if let nested = (try? c.decodeIfPresent(SyncVersion.self, forKey: LenientKey("sync"))) ?? nil,
                  nested.dataVersion != nil {
            version = nested
        } else if c.lenientString("dataVersion") != nil {
            version = try? SyncVersion(from: decoder)
        } else {
            version = nil
        }
        let counts = try? c.nestedContainer(keyedBy: LenientKey.self, forKey: LenientKey("counts"))
        receiptCounts = (try? counts?.decodeIfPresent(ReceiptCounts.Counts.self, forKey: LenientKey("receipts")))
            ?? (try? c.decodeIfPresent(ReceiptCounts.Counts.self, forKey: LenientKey("receiptCounts")))
            ?? (try? c.decodeIfPresent(ReceiptCounts.Counts.self, forKey: LenientKey("counts")))
            ?? nil
    }
}

/// One GET the app asks for ahead of the screen that shows it, with exactly the screen's query,
/// so the screen finds it in `ResourceCache`.
public struct PrefetchRequest: Sendable, Equatable {
    public let path: String
    public let query: [String: String]
    /// Written to disk: a cold launch paints it at once.
    public let persist: Bool

    public init(path: String, query: [String: String] = [:], persist: Bool = true) {
        self.path = path
        self.query = query
        self.persist = persist
    }
}

/// What is asked for right after sign-in (and on coming back to the app once the figures are
/// stale): Koti, Kuitit page 1 with its counts and review queues, Myynti's list, and the Pankki hub. The tab a
/// screen opens on then paints from the cache instead of waiting on the server.
public enum LaunchPrefetch {
    /// Koti's month and the Kuitit filters the owner left (`ReceiptListQuery.remembered`).
    public static func requests(month: String, kuititFilter: String) -> [PrefetchRequest] {
        let kuitit = ReceiptListQuery(remembered: kuititFilter)
        return [
            PrefetchRequest(path: "/api/dashboard", query: ["month": month]),
            PrefetchRequest(path: "/api/receipts", query: ReceiptListPaging.firstQuery(kuitit)),
            PrefetchRequest(path: "/api/receipts/counts", query: kuitit.countsQuery()),
            PrefetchRequest(path: "/api/receipts", query: ReceiptListQuery.pendingQueue()),
            PrefetchRequest(path: "/api/receipts", query: ReceiptListQuery.rejectedQueue()),
            // Myynti's first screen (no chip, no search): otherwise its first visit is a spinner
            // the list then replaces. Counts as the screen asks for them, in memory only.
            PrefetchRequest(path: "/api/invoices", query: SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: "")),
            PrefetchRequest(path: "/api/invoices/counts", query: InvoiceScope().query, persist: false),
            PrefetchRequest(path: "/api/bank-accounts"),
            PrefetchRequest(path: "/api/statements/counts"),
            // The hub's rows: the largest answer, so it goes last and is written to disk only
            // while it stays under `ResourceDiskStore.maxEntryBytes`.
            PrefetchRequest(path: "/api/statements"),
        ]
    }

    /// The request a bootstrap's counts stand for (the default Kuitit scope only: other filters
    /// count something else).
    public static func countsRequest(kuititFilter: String) -> PrefetchRequest? {
        let kuitit = ReceiptListQuery(remembered: kuititFilter)
        let query = kuitit.countsQuery()
        guard query == ReceiptListQuery().countsQuery() else { return nil }
        return PrefetchRequest(path: "/api/receipts/counts", query: query)
    }
}

extension ReceiptCounts {
    /// The `/api/receipts/counts` answer's bytes for these counts, to stand in the cache for it.
    public static func answer(_ counts: Counts) throws -> Data {
        var fields: [String: Int] = ["all": counts.all, "tulo": counts.tulo, "meno": counts.meno,
                                     "linked": counts.linked, "unlinked": counts.unlinked]
        if let laskut = counts.laskut { fields["laskut"] = laskut }
        return try JSONSerialization.data(withJSONObject: ["counts": fields], options: [.sortedKeys])
    }
}
