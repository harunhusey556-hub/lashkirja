import Foundation

/// Days late, as the server buckets open receivables (`lib/invoices.ts agingBucket`).
public enum AgingBucket: String, CaseIterable, Sendable, Hashable, Identifiable {
    case notDue = "not_due"
    case days1to30 = "1-30"
    case days31to60 = "31-60"
    case days61to90 = "61-90"
    case over90 = "90+"

    public var id: String { rawValue }
    public static let late: [AgingBucket] = [.days1to30, .days31to60, .days61to90, .over90]

    public var label: String {
        switch self {
        case .notDue: "Ei erääntynyt"
        case .days1to30: "1–30 pv"
        case .days31to60: "31–60 pv"
        case .days61to90: "61–90 pv"
        case .over90: "yli 90 pv"
        }
    }

    public static func of(daysLate: Int) -> AgingBucket {
        switch daysLate {
        case ...0: .notDue
        case 1...30: .days1to30
        case 31...60: .days31to60
        case 61...90: .days61to90
        default: .over90
        }
    }

    /// Both dates "YYYY-MM-DD"; nil when either cannot be read.
    public static func of(dueDate: String, today: String) -> AgingBucket? {
        guard let due = dayNumber(dueDate), let now = dayNumber(today) else { return nil }
        return of(daysLate: now - due)
    }

    /// Whole days since 1970 for a calendar date, independent of time zones.
    static func dayNumber(_ day: String) -> Int? {
        let parts = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, day.count >= 10 else { return nil }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return nil }
        return Int((date.timeIntervalSince1970 / 86_400).rounded())
    }
}

/// One part of the "Saatavat" bar (web `lib/receivables-summary.ts`): it opens the list chip it names.
public struct ReceivablesSegment: Sendable, Hashable, Identifiable {
    public enum Tone: Sendable, Hashable { case success, neutral, danger }
    public let filter: SalesFilter
    public let label: String
    public let amount: Decimal
    public let tone: Tone
    public var id: String { filter.rawValue }
}

/// One "N pv myöhässä" figure under the bar.
public struct ReceivablesLateBucket: Sendable, Hashable, Identifiable {
    public let bucket: AgingBucket
    public let amount: Decimal
    public let count: Int
    public var label: String { bucket.label }
    public var id: String { bucket.rawValue }
}

extension InvoiceList.Aging {
    /// How far back "Maksettu" looks (web `PAID_WINDOW_DAYS`).
    public static let paidWindowDays = 90

    /// Paid, waiting, late, in reading order. Without the paid figure (an older server) the paid
    /// part is left out instead of drawn as a false zero.
    public var segments: [ReceivablesSegment] {
        var segments: [ReceivablesSegment] = []
        if let paidRecentCents {
            segments.append(.init(filter: .paid, label: "Maksettu \(Self.paidWindowDays) pv", amount: Self.euros(paidRecentCents), tone: .success))
        }
        let waiting = buckets?[AgingBucket.notDue.rawValue].map { Self.euros($0.openCents) } ?? max(0, totalOpen - overdue)
        segments.append(.init(filter: .sent, label: "Odottaa maksua", amount: waiting, tone: .neutral))
        segments.append(.init(filter: .overdue, label: "Myöhässä", amount: overdue, tone: .danger))
        return segments
    }

    /// The late money by days late; empty when the server sent no buckets.
    public var lateBuckets: [ReceivablesLateBucket] {
        guard let buckets else { return [] }
        return AgingBucket.late.map { bucket in
            let figure = buckets[bucket.rawValue]
            return ReceivablesLateBucket(bucket: bucket, amount: Self.euros(figure?.openCents ?? 0), count: figure?.count ?? 0)
        }
    }

    static func euros(_ cents: Int) -> Decimal { Decimal(cents) / 100 }
}

/// `GET /api/invoices` the way the web asks for it: the chip's status and the search go to the
/// server, so an old invoice is not hidden behind the newest 200 rows (`INVOICE_LIST_LIMIT`).
public enum SalesListQuery {
    public static let rowLimit = 200

    public static func query(scope: InvoiceScope, filter: SalesFilter, search: String) -> [String: String] {
        var query = scope.query
        if filter != .all { query["status"] = filter.rawValue }
        let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { query["search"] = String(text.prefix(80)) }
        return query
    }

    public static func limitNote(rowCount: Int) -> String? {
        rowCount >= rowLimit ? "Näytetään \(rowLimit) uusinta laskua. Hae tai valitse suodatin nähdäksesi muut." : nil
    }
}
