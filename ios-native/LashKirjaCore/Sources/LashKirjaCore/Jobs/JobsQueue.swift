import Foundation

/// One row of `GET /api/jobs`.
public struct BackgroundJob: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let status: String
    public let title: String
    public let detail: String?
    public let error: String?
    public let progressLabel: String?
    public let createdAt: String

    enum CodingKeys: String, CodingKey { case id, kind, status, title, detail, error, progressLabel, createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Työ"
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        progressLabel = try c.decodeIfPresent(String.self, forKey: .progressLabel)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }

    public var isActive: Bool { status == "pending" || status == "running" }
    public var statusLabel: String { JobsQueue.statusLabels[status] ?? status }
    public var kindLabel: String { JobsQueue.kindLabels[kind] ?? "Työ" }

    /// "Kuitin lukeminen · Luetaan": the progress only while running and when it says more than the status.
    public var secondary: String {
        if isActive, let progress = progressLabel, !progress.isEmpty, progress != statusLabel {
            return "\(kindLabel) · \(progress)"
        }
        return kindLabel
    }
}

public struct JobsList: Decodable, Sendable {
    public let jobs: [BackgroundJob]
    enum CodingKeys: String, CodingKey { case jobs }
    public init(from decoder: Decoder) throws {
        jobs = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([BackgroundJob].self, forKey: .jobs) ?? []
    }
}

/// One row of `GET /api/work-queue`.
public struct WorkQueueItem: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let title: String
    public let detail: String
    public let href: String?
    public let retryJobId: String?
    public let retryJobIds: [String]?
    public let count: Int?

    enum CodingKeys: String, CodingKey { case id, kind, title, detail, href, retryJobId, retryJobIds, count }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        href = try c.decodeIfPresent(String.self, forKey: .href)
        retryJobId = try c.decodeIfPresent(String.self, forKey: .retryJobId)
        retryJobIds = try c.decodeIfPresent([String].self, forKey: .retryJobIds)
        count = try c.decodeIfPresent(Int.self, forKey: .count)
    }

    /// Every failed job the row's one retry starts again (F29).
    public var retryIds: [String] {
        if let ids = retryJobIds, !ids.isEmpty { return ids }
        return retryJobId.map { [$0] } ?? []
    }

    public var kindLabel: String { JobsQueue.workKindLabels[kind] ?? "Huomioitava" }
}

public struct WorkQueueList: Decodable, Sendable {
    public let items: [WorkQueueItem]
    enum CodingKeys: String, CodingKey { case items }
    public init(from decoder: Decoder) throws {
        items = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([WorkQueueItem].self, forKey: .items) ?? []
    }
}

/// The /tyot page's rules (lib/job-labels.ts and app/tyot/page.tsx).
public enum JobsQueue {
    public static let kindLabels = [
        "document_analysis": "Kuitin lukeminen",
        "bank_sync": "Pankkitapahtumien haku",
        "email_scan": "Sähköpostin tarkistus",
    ]
    public static let statusLabels = [
        "pending": "Jonossa",
        "running": "Käynnissä",
        "failed": "Epäonnistui",
        "done": "Valmis",
        "cancelled": "Peruttu",
    ]
    public static let workKinds = ["pending_review", "missing_document", "amount_mismatch", "corrupt_file",
                                   "link_error", "ambiguous_match", "payment_duplicate"]
    public static let workKindLabels = [
        "pending_review": "Odottaa tarkistusta",
        "missing_document": "Kuitti puuttuu",
        "amount_mismatch": "Summa ei täsmää",
        "corrupt_file": "Kuittia ei voitu lukea",
        "link_error": "Kohdistus ei onnistunut",
        "ambiguous_match": "Epäselvä kohdistus",
        "payment_duplicate": "Mahdollinen tuplamaksu",
    ]
    /// The server caps each kind at this many rows, so a count on it may be more.
    public static let take = 40
    public static let recentFinished = 3

    /// What runs now plus the last few finished; a failed one lives in the queue with its retry.
    public static func visibleJobs(_ jobs: [BackgroundJob]) -> [BackgroundJob] {
        let active = jobs.filter(\.isActive)
        let finished = jobs.filter { $0.status == "done" || $0.status == "cancelled" }.prefix(recentFinished)
        return active + finished
    }

    public struct Chip: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let count: String
    }

    /// "Kaikki" and each kind that has rows (or is the one selected).
    public static func chips(_ items: [WorkQueueItem], selected: String) -> [Chip] {
        var anyCapped = false
        var kinds: [Chip] = []
        for kind in workKinds {
            let count = items.filter { $0.kind == kind }.count
            let capped = count >= take
            anyCapped = anyCapped || capped
            if count > 0 || kind == selected {
                kinds.append(Chip(id: kind, label: workKindLabels[kind] ?? kind, count: capped ? "\(count)+" : "\(count)"))
            }
        }
        let all = Chip(id: "all", label: "Kaikki", count: anyCapped ? "\(items.count)+" : "\(items.count)")
        return [all] + kinds
    }

    public static func filter(_ items: [WorkQueueItem], kind: String) -> [WorkQueueItem] {
        kind == "all" ? items : items.filter { $0.kind == kind }
    }
}
