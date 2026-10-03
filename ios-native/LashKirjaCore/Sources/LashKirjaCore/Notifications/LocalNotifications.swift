import Foundation

/// Local notifications fed by `GET /api/notifications`. The app is installed without a paid
/// developer account, so there is no remote push: the phone asks the server when it opens and
/// when iOS lets it refresh in the background, and shows each id once. The rules live here so
/// they are tested without UserNotifications.
public enum NotificationKind: String, CaseIterable, Codable, Sendable {
    case missingReceipt = "missing_receipt"
    case receiptReview = "receipt_review"
    case overdueInvoice = "overdue_invoice"
    case vatDue = "vat_due"
    case monthClose = "month_close"
    case bankSyncFailed = "bank_sync_failed"

    /// Notifications of one kind stack together in Notification Center.
    public var threadId: String { "lk.\(rawValue)" }

    public var label: String {
        switch self {
        case .missingReceipt: "Puuttuvat kuitit"
        case .receiptReview: "Kuitit sähköpostista"
        case .overdueInvoice: "Myöhässä olevat laskut"
        case .vatDue: "ALV-ilmoitus"
        case .monthClose: "Kuukauden sulku"
        case .bankSyncFailed: "Pankkihaku epäonnistui"
        }
    }

    public var detail: String {
        switch self {
        case .missingReceipt: "Pankkiin tuli osto, jolle ei ole kuittia."
        case .receiptReview: "Sähköpostista tullut kuitti odottaa tarkistusta."
        case .overdueInvoice: "Asiakas ei ole maksanut, ja muistutuksen voi lähettää."
        case .vatDue: "Ilmoitus on tekemättä, ja määräpäivä on kolmen päivän sisällä."
        case .monthClose: "Edellinen kuukausi on sulkematta kuun 5. päivän jälkeen."
        case .bankSyncFailed: "Tapahtumien haku pankista ei onnistunut."
        }
    }
}

/// One row of `GET /api/notifications`.
public struct FeedNotification: Decodable, Sendable, Equatable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let href: String?
    public let createdAt: String

    public init(id: String, kind: String, title: String, body: String, href: String?, createdAt: String) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.href = href
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey { case id, kind, title, body, href, createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        href = try c.decodeIfPresent(String.self, forKey: .href)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }

    /// Nil for a kind a newer server added: this app version does not show it.
    public var knownKind: NotificationKind? { NotificationKind(rawValue: kind) }

    /// The bank row of a "Kuitti puuttuu" item, for the "Kuvaa kuitti" action.
    public var transactionId: String? {
        let prefix = "missing-receipt:"
        guard knownKind == .missingReceipt, id.hasPrefix(prefix) else { return nil }
        let rest = String(id.dropFirst(prefix.count))
        return rest.isEmpty ? nil : rest
    }
}

public struct NotificationFeed: Decodable, Sendable {
    public let items: [FeedNotification]
    /// Sent back as `since` next time.
    public let cursor: String?
    /// What is open now per kind (the daily summary reads these).
    public let counts: [String: Int]

    enum CodingKeys: String, CodingKey { case items, cursor, counts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([FeedNotification].self, forKey: .items) ?? []
        cursor = try c.decodeIfPresent(String.self, forKey: .cursor)
        counts = try c.decodeIfPresent([String: Int].self, forKey: .counts) ?? [:]
    }
}

/// Hours of the day when nothing is shown (default 21–8). Start == end means no quiet hours.
public struct QuietHours: Codable, Equatable, Sendable {
    public var startHour: Int
    public var endHour: Int

    public init(startHour: Int, endHour: Int) {
        self.startHour = startHour
        self.endHour = endHour
    }

    public func contains(_ date: Date, calendar: Calendar) -> Bool {
        guard startHour != endHour else { return false }
        let hour = calendar.component(.hour, from: date)
        return startHour < endHour ? (hour >= startHour && hour < endHour) : (hour >= startHour || hour < endHour)
    }

    /// The next moment the quiet hours end, after `date`.
    public func end(after date: Date, calendar: Calendar) -> Date {
        calendar.nextDate(after: date, matching: DateComponents(hour: endHour, minute: 0, second: 0), matchingPolicy: .nextTime)
            ?? date.addingTimeInterval(3600)
    }
}

/// The owner's choices on "Ilmoitukset". Kept on the phone; read leniently so a setting added
/// later keeps its default for data saved by an older version.
public struct NotificationPrefs: Codable, Equatable, Sendable {
    public var enabled = true
    public var disabledKinds: [String] = []
    public var quietHoursOn = true
    public var quietHours = QuietHours(startHour: 21, endHour: 8)
    public var dailySummary = false
    public var summaryHour = 18
    public var summaryMinute = 0

    public init() {}

    public func isOn(_ kind: NotificationKind) -> Bool { !disabledKinds.contains(kind.rawValue) }

    public mutating func set(_ kind: NotificationKind, on: Bool) {
        disabledKinds.removeAll { $0 == kind.rawValue }
        if !on { disabledKinds.append(kind.rawValue) }
    }

    enum CodingKeys: String, CodingKey { case enabled, disabledKinds, quietHoursOn, quietHours, dailySummary, summaryHour, summaryMinute }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = NotificationPrefs()
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? defaults.enabled
        disabledKinds = try c.decodeIfPresent([String].self, forKey: .disabledKinds) ?? defaults.disabledKinds
        quietHoursOn = try c.decodeIfPresent(Bool.self, forKey: .quietHoursOn) ?? defaults.quietHoursOn
        quietHours = try c.decodeIfPresent(QuietHours.self, forKey: .quietHours) ?? defaults.quietHours
        dailySummary = try c.decodeIfPresent(Bool.self, forKey: .dailySummary) ?? defaults.dailySummary
        summaryHour = try c.decodeIfPresent(Int.self, forKey: .summaryHour) ?? defaults.summaryHour
        summaryMinute = try c.decodeIfPresent(Int.self, forKey: .summaryMinute) ?? defaults.summaryMinute
    }
}

/// The ids already shown, newest last. Bounded: a state that stays open (a late invoice) keeps
/// its id near the end because every fetch adds it again only while it is new.
public struct DeliveredIds: Codable, Equatable, Sendable {
    public static let limit = 500
    public private(set) var ids: [String] = []

    public init() {}

    public func contains(_ id: String) -> Bool { ids.contains(id) }

    public func adding(_ new: [String]) -> DeliveredIds {
        var copy = self
        let fresh = new.filter { !copy.ids.contains($0) }
        copy.ids = Array((copy.ids + fresh).suffix(Self.limit))
        return copy
    }
}

public enum NotificationAction {
    /// "Kuvaa kuitti" on a "Kuitti puuttuu" notification.
    public static let capture = "lk.capture"
    public static let missingReceiptCategory = "lk.missing_receipt"
    public static let dailySummaryId = "lk.daily"
}

/// What one notification request carries.
public struct OutgoingNotification: Equatable, Sendable {
    /// The request identifier: the item's id, or "lk.summary.<kind>" for a summed-up kind.
    public let id: String
    public let kind: NotificationKind
    public let title: String
    public let body: String
    public let href: String?
    public let threadId: String
    /// Set on a single "Kuitti puuttuu": the camera opens for this bank row.
    public let transactionId: String?
    public let categoryId: String?
}

public struct NotificationPlan: Equatable, Sendable {
    public let outgoing: [OutgoingNotification]
    /// Ids to remember as shown (or put aside, for a kind the owner turned off).
    public let markDelivered: [String]
    /// Quiet hours: nothing was shown, so the cursor must not move and the same items come again.
    public let hold: Bool
}

public enum NotificationTap: Equatable, Sendable {
    case route(String)
    case capture(String)
    case none

    public static func resolve(href: String?, transactionId: String?, action: String?) -> NotificationTap {
        if action == NotificationAction.capture, let transactionId, !transactionId.isEmpty { return .capture(transactionId) }
        guard let href, !href.isEmpty else { return .none }
        return .route(href)
    }
}

public enum NotificationPlanner {
    /// More new items than this in one fetch: each kind with several is summed up in one.
    public static let maxPerRun = 3
    /// How long iOS is asked to wait before the next background refresh.
    public static let refreshInterval: TimeInterval = 90 * 60

    public static func plan(_ items: [FeedNotification], prefs: NotificationPrefs, delivered: DeliveredIds,
                            now: Date, calendar: Calendar) -> NotificationPlan {
        let fresh = items.filter { $0.knownKind != nil && !delivered.contains($0.id) }
        let wanted = fresh.filter { prefs.isOn($0.knownKind!) }
        let muted = fresh.filter { !prefs.isOn($0.knownKind!) }.map(\.id)
        if prefs.quietHoursOn && prefs.quietHours.contains(now, calendar: calendar) {
            return NotificationPlan(outgoing: [], markDelivered: muted, hold: true)
        }
        var outgoing: [OutgoingNotification] = []
        if wanted.count <= maxPerRun {
            outgoing = wanted.map(single)
        } else {
            for kind in NotificationKind.allCases {
                let ofKind = wanted.filter { $0.knownKind == kind }
                if ofKind.count == 1 { outgoing.append(single(ofKind[0])) }
                if ofKind.count > 1 {
                    let text = summary(kind, count: ofKind.count)
                    outgoing.append(OutgoingNotification(id: "lk.summary.\(kind.rawValue)", kind: kind, title: text.title,
                                                         body: text.body, href: text.href, threadId: kind.threadId,
                                                         transactionId: nil, categoryId: nil))
                }
            }
        }
        return NotificationPlan(outgoing: outgoing, markDelivered: fresh.map(\.id), hold: false)
    }

    private static func single(_ item: FeedNotification) -> OutgoingNotification {
        let kind = item.knownKind!
        let transactionId = item.transactionId
        return OutgoingNotification(id: item.id, kind: kind, title: item.title, body: item.body, href: item.href,
                                    threadId: kind.threadId, transactionId: transactionId,
                                    categoryId: transactionId == nil ? nil : NotificationAction.missingReceiptCategory)
    }

    /// One notification for several new items of a kind ("4 ostoa odottaa kuittia.").
    public static func summary(_ kind: NotificationKind, count: Int) -> (title: String, body: String, href: String) {
        switch kind {
        case .missingReceipt:
            ("Kuitteja puuttuu", "\(count) \(count == 1 ? "osto" : "ostoa") odottaa kuittia.", "/pankki/tapahtumat?nayta=toimet")
        case .receiptReview:
            ("Uusia kuitteja sähköpostista", "\(count) \(count == 1 ? "kuitti" : "kuittia") odottaa tarkistusta.", "/sahkoposti")
        case .overdueInvoice:
            ("Laskuja myöhässä", "\(count) \(count == 1 ? "lasku" : "laskua") on myöhässä.", "/laskut?status=overdue")
        case .bankSyncFailed:
            ("Pankkitapahtumien haku epäonnistui", "Haku epäonnistui \(count) pankkiyhteydessä.", "/tyot")
        case .vatDue:
            ("ALV-ilmoitus on tekemättä", "Avaa ALV-ilmoitus.", "/kirjanpito/alv")
        case .monthClose:
            ("Kuukausi on sulkematta", "Tarkista kirjaukset ja sulje kuukausi.", "/kirjanpito/kuukausi")
        }
    }

    /// The daily summary from the counts of the latest fetch, the kinds the owner keeps on only;
    /// nil when it is off or nothing is open (no notification beats "Kaikki kunnossa" every day).
    public static func dailySummary(counts: [String: Int], prefs: NotificationPrefs) -> (title: String, body: String)? {
        guard prefs.enabled, prefs.dailySummary else { return nil }
        var parts: [String] = []
        func count(_ kind: NotificationKind) -> Int { prefs.isOn(kind) ? (counts[kind.rawValue] ?? 0) : 0 }
        let missing = count(.missingReceipt)
        if missing > 0 { parts.append("\(missing) \(missing == 1 ? "osto" : "ostoa") odottaa kuittia") }
        let review = count(.receiptReview)
        if review > 0 { parts.append("\(review) \(review == 1 ? "kuitti" : "kuittia") odottaa tarkistusta") }
        let overdue = count(.overdueInvoice)
        if overdue > 0 { parts.append("\(overdue) \(overdue == 1 ? "lasku" : "laskua") myöhässä") }
        if count(.vatDue) > 0 { parts.append("ALV-ilmoitus tekemättä") }
        if count(.monthClose) > 0 { parts.append("edellinen kuukausi sulkematta") }
        if count(.bankSyncFailed) > 0 { parts.append("pankkihaku epäonnistui") }
        guard !parts.isEmpty else { return nil }
        return ("Päivän yhteenveto", parts.joined(separator: ", ") + ".")
    }

    /// The next time of day the owner chose for the summary, strictly after `now`. One summary
    /// at a time, rescheduled on every fetch, so it never repeats stale counts.
    public static func nextDailySummary(after now: Date, prefs: NotificationPrefs, calendar: Calendar) -> Date {
        calendar.nextDate(after: now, matching: DateComponents(hour: prefs.summaryHour, minute: prefs.summaryMinute, second: 0),
                          matchingPolicy: .nextTime) ?? now.addingTimeInterval(86_400)
    }

    /// The earliest begin date for the next background refresh. iOS decides the real time; there
    /// is no point waking during quiet hours, when nothing would be shown.
    public static func nextRefresh(after now: Date, prefs: NotificationPrefs, calendar: Calendar) -> Date {
        let candidate = now.addingTimeInterval(refreshInterval)
        guard prefs.quietHoursOn, prefs.quietHours.contains(candidate, calendar: calendar) else { return candidate }
        return prefs.quietHours.end(after: candidate, calendar: calendar)
    }

    /// Asked once, gently: when a bank row first waits for its receipt, never on the first run.
    public static func shouldAskPermission(undetermined: Bool, askedBefore: Bool, firstRun: Bool, missingReceipts: Int) -> Bool {
        undetermined && !askedBefore && !firstRun && missingReceipts > 0
    }
}
