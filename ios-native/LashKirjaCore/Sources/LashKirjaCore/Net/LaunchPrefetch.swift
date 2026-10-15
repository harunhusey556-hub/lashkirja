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
/// stale): Koti, Kuitit page 1 with its counts and review queues, Myynti's list, Raportit's year and the Pankki hub. The tab a
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
            // Raportit's year (RaportitView asks for the whole calendar year): its first visit was
            // a 3 s spinner and then the figures pushed the rest of the page down.
            PrefetchRequest(path: "/api/reports/profit-loss", query: ["from": "\(month.prefix(4))-01", "to": "\(month.prefix(4))-12"], persist: false),
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

/// The screens one tap away, warmed before the owner taps: after the launch prefetch (Koti is on
/// screen) and when a tab is chosen. Exactly the screens' queries, so each opens painted from
/// `ResourceCache` and refreshes in place. Kept in memory only; the launch lists are the ones on disk.
public enum NextPrefetch {
    /// With Koti on screen: Myynti's list and chip counts, the Kirjanpito hub's waiting count,
    /// Raportit's year and the assistant's latest conversation.
    public static func afterKoti(month: String) -> [PrefetchRequest] {
        let year = String(month.prefix(4))
        return [
            PrefetchRequest(path: "/api/invoices", query: SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: "")),
            PrefetchRequest(path: "/api/invoices/counts", query: InvoiceScope().query, persist: false),
            PrefetchRequest(path: "/api/receipts/counts", query: ReceiptListQuery.pendingCountQuery, persist: false),
            PrefetchRequest(path: "/api/reports/profit-loss", query: ["from": "\(year)-01", "to": "\(year)-12"], persist: false),
            PrefetchRequest(path: "/api/ai/chat", persist: false),
        ]
    }

    /// Kirjanpito chosen: Pankkitapahtumat's first page, the bank connections (the feed's menu and
    /// Pankkiyhteys), the month-close checklist and lock, and the ALV return the screen opens on
    /// (`alvPeriod`, known once the profile tells the VAT period's kind).
    public static func kirjanpito(month: String, alvPeriod: String?) -> [PrefetchRequest] {
        var requests = [
            PrefetchRequest(path: "/api/statements", query: CursorPaging.firstQuery(BankFeed.query(month: nil)), persist: false),
            PrefetchRequest(path: "/api/bank/connections", persist: false),
            PrefetchRequest(path: "/api/dashboard/month", query: ["month": PeriodClose.startMonth(nil, current: month)], persist: false),
            PrefetchRequest(path: "/api/period-lock", persist: false),
        ]
        if let alvPeriod, !alvPeriod.isEmpty {
            requests.append(PrefetchRequest(path: "/api/alv", query: ["period": alvPeriod], persist: false))
        }
        return requests
    }

    /// Myynti chosen: the new-invoice form's customers and catalog, and Toistuvat laskut (active
    /// only, as the screen opens): its first visit was a spinner the list then replaced.
    public static func myynti() -> [PrefetchRequest] {
        [PrefetchRequest(path: "/api/customers", persist: false), PrefetchRequest(path: "/api/catalog", persist: false),
         PrefetchRequest(path: "/api/recurring-invoices", persist: false)]
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
