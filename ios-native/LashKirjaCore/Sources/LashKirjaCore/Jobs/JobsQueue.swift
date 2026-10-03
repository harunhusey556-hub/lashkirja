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
    /// What the job worked on (a bank connection, a mailbox); a later success for it closes a failure.
    public let resourceId: String?

    enum CodingKeys: String, CodingKey { case id, kind, status, title, detail, error, progressLabel, createdAt, resourceId }

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
        resourceId = try c.decodeIfPresent(String.self, forKey: .resourceId)
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
    /// A card refund made after its month was locked: accepting posts the correction
    /// (`POST /api/pos/corrections/:id/accept`) in the first open month.
    public let correctionId: String?

    enum CodingKeys: String, CodingKey { case id, kind, title, detail, href, retryJobId, retryJobIds, count, correctionId }

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
        correctionId = try c.decodeIfPresent(String.self, forKey: .correctionId)
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
                                   "link_error", "ambiguous_match", "payment_duplicate", "card_refund_correction"]
    public static let workKindLabels = [
        "pending_review": "Odottaa tarkistusta",
        "missing_document": "Kuitti puuttuu",
        "amount_mismatch": "Summa ei täsmää",
        "corrupt_file": "Kuittia ei voitu lukea",
        "link_error": "Kohdistus ei onnistunut",
        "ambiguous_match": "Epäselvä kohdistus",
        "payment_duplicate": "Mahdollinen tuplamaksu",
        "card_refund_correction": "Korttipalautuksen korjaus",
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

/// Failed jobs as the owner should see them: still open, explained, with the way to fix them.
extension JobsQueue {
    public enum FailureAction: Equatable, Sendable {
        case chooseAccounts, bankConnection, emailSettings, none
    }

    public struct FailureHelp: Equatable, Sendable {
        public let explanation: String
        public let action: FailureAction
        public let actionTitle: String?
    }

    /// What Koti and "Tuonnit ja virheet" know of a bank connection, to tell a stale failure.
    public struct ConnectionState: Equatable, Sendable {
        public let id: String
        public let lastSuccessAt: String?
        /// Revoked or replaced: nothing will ever sync it again.
        public let retired: Bool
        public init(id: String, lastSuccessAt: String?, retired: Bool = false) {
            self.id = id
            self.lastSuccessAt = lastSuccessAt
            self.retired = retired
        }
    }

    /// The connection states from `GET /api/bank/connections`; a revoked one is retired.
    public static func connectionStates(_ list: BankConnections) -> [ConnectionState] {
        list.connections.map { ConnectionState(id: $0.id, lastSuccessAt: $0.lastSuccessAt, retired: $0.status == "revoked") }
    }

    /// Failures not yet put right. A failure is over when the owner dismissed it ("Kuittaa"),
    /// when a later run of the same kind on the same resource finished, or, for a bank sync,
    /// when its connection is gone (reconnected under a new id, removed) or has fetched since.
    /// Without the connection list (`nil`, it failed to load) nothing is guessed away.
    public static func openFailures(_ jobs: [BackgroundJob], connections: [ConnectionState]? = nil,
                                    dismissedLocally: Set<String> = []) -> [BackgroundJob] {
        jobs.enumerated().compactMap { index, job in
            guard job.status == "failed", !dismissedLocally.contains(job.id) else { return nil }
            // Without a resource (each receipt read is its own file) nothing later closes it.
            guard let resource = job.resourceId else { return job }
            let fixedLater = jobs[..<index].contains { later in
                later.kind == job.kind && later.resourceId == resource && later.status == "done"
            }
            if fixedLater { return nil }
            if job.kind == "bank_sync", let connections {
                guard let connection = connections.first(where: { $0.id == resource }), !connection.retired else { return nil }
                if let success = connection.lastSuccessAt.flatMap(APIDate.instant),
                   let failed = APIDate.instant(job.createdAt), success > failed { return nil }
            }
            return job
        }
    }

    /// The failures listed on "Tuonnit ja virheet": a failed receipt read is left to Korjattavat,
    /// where it has its retry, so it is not shown twice.
    public static func listedFailures(_ jobs: [BackgroundJob], connections: [ConnectionState]? = nil,
                                      dismissedLocally: Set<String> = []) -> [BackgroundJob] {
        openFailures(jobs, connections: connections, dismissedLocally: dismissedLocally).filter { $0.kind != "document_analysis" }
    }

    public static func help(for job: BackgroundJob) -> FailureHelp {
        let error = job.error ?? ""
        let lower = error.lowercased()
        switch job.kind {
        case "bank_sync":
            if lower.contains("valitse ainakin yksi tili") {
                return FailureHelp(
                    explanation: "Pankki on yhdistetty, mutta yhtään tiliä ei ole valittu kirjanpitoon, joten tapahtumia ei haettu.",
                    action: .chooseAccounts, actionTitle: "Valitse tilit")
            }
            return FailureHelp(
                explanation: error.isEmpty ? "Tapahtumien haku pankista epäonnistui." : error,
                action: .bankConnection, actionTitle: "Avaa pankkiyhteys")
        case "email_scan":
            return FailureHelp(
                explanation: error.isEmpty ? "Sähköpostin tarkistus epäonnistui." : error,
                action: .emailSettings, actionTitle: "Sähköpostiasetukset")
        default:
            return FailureHelp(explanation: error.isEmpty ? "Työ epäonnistui." : error, action: .none, actionTitle: nil)
        }
    }
}
