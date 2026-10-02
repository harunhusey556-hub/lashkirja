import Foundation

/// The three folders of Sähköposti. Mail sync stores every attachment as a receipt with
/// `source: "email_sync"`: what reads as a bill waits for review, the rest is archived
/// (`rejected`) on arrival and can be restored.
public enum EmailInboxFolder: String, CaseIterable, Sendable, Identifiable {
    case pending, approved, rejected
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pending: "Odottaa"
        case .approved: "Hyväksytyt"
        case .rejected: "Arkisto"
        }
    }

    public var emptyText: String {
        switch self {
        case .pending: "Ei käsiteltäviä laskuja. Uudet sähköpostilla tulleet laskut näkyvät tässä."
        case .approved: "Sähköpostista ei ole vielä hyväksyttyjä laskuja."
        case .rejected: "Arkisto on tyhjä. Liitteet, jotka eivät ole laskuja, arkistoidaan tänne."
        }
    }

    /// `GET /api/receipts`: the newest arrivals first, as in a mail app; the server sends at most
    /// 200 rows from `offset`.
    public func listQuery(offset: Int = 0) -> [String: String] {
        var q = countsQuery()
        q["sort"] = ReceiptSort.createdDesc.rawValue
        if offset > 0 { q["offset"] = String(offset) }
        return q
    }

    /// `GET /api/receipts/counts`: its `all` is this folder's size.
    public func countsQuery() -> [String: String] {
        ["source": "email_sync", "reviewStatus": rawValue]
    }
}

/// Folder sizes for the chips; a folder whose count did not load shows no number.
public struct EmailInboxCounts: Sendable, Equatable {
    public var pending: Int?
    public var approved: Int?
    public var rejected: Int?

    public init(pending: Int? = nil, approved: Int? = nil, rejected: Int? = nil) {
        self.pending = pending
        self.approved = approved
        self.rejected = rejected
    }

    public subscript(folder: EmailInboxFolder) -> Int? {
        get {
            switch folder {
            case .pending: pending
            case .approved: approved
            case .rejected: rejected
            }
        }
        set {
            switch folder {
            case .pending: pending = newValue
            case .approved: approved = newValue
            case .rejected: rejected = newValue
            }
        }
    }
}

/// `PATCH /api/receipts/{id}/review`: archiving is `rejected`, restoring is `pending`.
public struct ReceiptReviewBody: Encodable, Sendable {
    public let reviewStatus: String
    public init(_ folder: EmailInboxFolder) { reviewStatus = folder.rawValue }
}

/// `POST /api/integrations/imap/archive`: how many amountless waiting receipts were archived.
public struct EmailArchiveResult: Decodable, Sendable {
    public let archived: Int
}

/// The words of the Sähköposti screen.
public enum EmailInboxText {
    /// The newest check of any mailbox: the server's own runs, or a "Tarkista nyt" on this device
    /// (kept locally for a server that does not send the time yet).
    public static func lastCheck(_ accounts: [ImapAccount], device: Date?) -> Date? {
        let server = accounts.compactMap { $0.lastCheckedAt.flatMap(APIDate.instant) }.max()
        return [server, device].compactMap { $0 }.max()
    }

    /// After "Tarkista nyt". `bills` is the server's count (only what reads as a bill);
    /// `archived` is how much the archive grew meanwhile, when both counts loaded.
    public static func syncNotice(bills: Int, archived: Int?) -> String {
        var text = switch bills {
        case 0: "Ei uusia laskuja."
        case 1: "1 uusi lasku."
        default: "\(bills) uutta laskua."
        }
        if let archived, archived > 0 {
            text += archived == 1 ? " 1 muu liite arkistoitiin." : " \(archived) muuta liitettä arkistoitiin."
        }
        return text
    }

    /// After "Siivoa".
    public static func cleanupNotice(_ archived: Int) -> String {
        switch archived {
        case 0: "Ei arkistoitavaa."
        case 1: "Arkistoitiin 1 liite, jossa ei ollut summaa."
        default: "Arkistoitiin \(archived) liitettä, joissa ei ollut summaa."
        }
    }

    /// Rows the cleanup would archive: the server archives waiting mail receipts with no amount
    /// (or a zero one), so the button is offered only when the loaded list has some.
    public static func cleanupCandidates(_ receipts: [Receipt]) -> Int {
        receipts.filter { $0.reviewStatus == "pending" && ($0.totalAmount ?? 0) == 0 }.count
    }

    private static let zone = TimeZone(identifier: "Europe/Helsinki")!

    /// "Tarkistettu juuri nyt", "… tänään klo 9.05", "… 1.10.2026 klo 9.05" in Helsinki time.
    public static func checked(_ date: Date, now: Date = Date()) -> String {
        if abs(now.timeIntervalSince(date)) < 60 { return "Tarkistettu juuri nyt" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        if calendar.isDate(date, inSameDayAs: now) {
            formatter.dateFormat = "'tänään klo' H.mm"
        } else {
            formatter.dateFormat = "d.M.yyyy 'klo' H.mm"
        }
        return "Tarkistettu \(formatter.string(from: date))"
    }
}
