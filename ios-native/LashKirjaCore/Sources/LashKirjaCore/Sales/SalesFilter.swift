import Foundation

/// The sales list's filter chips, in the web app's order (`lib/invoice-groups.ts`).
public enum SalesFilter: String, CaseIterable, Sendable, Identifiable, Hashable {
    case all, overdue, draft, sent, paid, credited

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "Kaikki"
        case .overdue: "Myöhässä"
        case .draft: "Luonnokset"
        case .sent: "Odottaa maksua"
        case .paid: "Maksetut"
        case .credited: "Hyvitetyt"
        }
    }

    /// The group an invoice belongs to: a credit note always sits with the credited ones.
    public static func group(status: InvoiceStatus, documentKind: String?) -> SalesFilter {
        if documentKind == "credit_note" { return .credited }
        switch status {
        case .draft: return .draft
        case .sent: return .sent
        case .overdue: return .overdue
        case .paid: return .paid
        case .credited: return .credited
        }
    }

    public static func group(of invoice: Invoice) -> SalesFilter {
        group(status: invoice.displayStatus, documentKind: invoice.documentKind)
    }

    public func matches(_ invoice: Invoice) -> Bool {
        self == .all || Self.group(of: invoice) == self
    }

    private static let statusOrder: [SalesFilter] = [.overdue, .draft, .sent, .paid, .credited]

    /// "Kaikki" plus one chip per status with its count from `/api/invoices/counts`.
    /// "Hyvitetyt" only shows once something has been credited. Without counts
    /// (not loaded, or the request failed) the chips carry no numbers.
    public static func chips(_ counts: [String: Int]?) -> [SalesFilterChip] {
        guard let counts else {
            return [.all, .overdue, .draft, .sent, .paid].map { SalesFilterChip(filter: $0, count: nil) }
        }
        let total = statusOrder.reduce(0) { $0 + (counts[$1.rawValue] ?? 0) }
        var chips = [SalesFilterChip(filter: .all, count: total)]
        for filter in statusOrder {
            let count = counts[filter.rawValue] ?? 0
            if filter == .credited && count == 0 { continue }
            chips.append(SalesFilterChip(filter: filter, count: count))
        }
        return chips
    }
}

public struct SalesFilterChip: Sendable, Hashable, Identifiable {
    public let filter: SalesFilter
    public let count: Int?
    public var id: String { filter.rawValue }

    public init(filter: SalesFilter, count: Int?) {
        self.filter = filter
        self.count = count
    }

    /// "Odottaa maksua 3", or the bare title while the counts are unknown.
    public var label: String { count.map { "\(filter.title) \($0)" } ?? filter.title }
}

/// `GET /api/invoices/match` (dry run) and the body of `POST` (the run): bank
/// payments whose reference number matches an open invoice.
public struct BankMatchPreview: Decodable, Sendable {
    public struct Row: Decodable, Sendable, Hashable, Identifiable {
        public let invoiceId: String?
        public let invoiceNumber: Int
        public let customerName: String
        public let transactionId: String?
        public let amount: Decimal
        public let paidDate: String?
        public var id: String { "\(invoiceNumber)-\(transactionId ?? "")-\(amount)" }
    }

    public let preview: [Row]?
    public let suggestions: [Ignored]?
    public let skippedLocked: [Ignored]?

    public var rows: [Row] { preview ?? [] }
    private var lockedCount: Int { skippedLocked?.count ?? 0 }
    private var suggestionCount: Int { suggestions?.count ?? 0 }

    public var headline: String {
        let count = rows.count
        if count == 0 {
            return lockedCount > 0
                ? "Avoimille kausille ei ole kirjattavia maksuja."
                : "Tiliotteilla ei ole maksuja, joiden viitenumero vastaisi avointa laskua."
        }
        return count == 1
            ? "Viitenumero täsmää yhteen maksuun. Se kirjataan laskulle:"
            : "Viitenumero täsmää \(count) maksuun. Ne kirjataan laskuille:"
    }

    public var lockedText: String? {
        lockedCount > 0 ? "\(BankMatchResult.lockedNote(lockedCount)) Voit avata kauden kohdassa Kirjanpito > Suljetut kaudet, jos maksu kuuluu kirjata." : nil
    }

    public var suggestionText: String? {
        switch suggestionCount {
        case 0: return nil
        case 1: return "Lisäksi 1 maksu täsmää summaltaan. Se ei kirjaudu automaattisesti, vaan tarkistat sen laskulla."
        default: return "Lisäksi \(suggestionCount) maksua täsmää summaltaan. Ne eivät kirjaudu automaattisesti, vaan tarkistat ne laskuilla."
        }
    }
}

public struct BankMatchResult: Decodable, Sendable {
    public let applied: [Ignored]
    public let suggestions: [Ignored]?
    public let skippedLocked: [Ignored]?

    static func lockedNote(_ count: Int) -> String {
        count == 1
            ? "1 maksu on lukitulla kaudella, joten sitä ei kirjata."
            : "\(count) maksua on lukitulla kaudella, joten niitä ei kirjata."
    }

    public var appliedCount: Int { applied.count }

    public var message: String {
        let booked = applied.count == 1 ? "1 maksu kohdistettiin laskulle." : "\(applied.count) maksua kohdistettiin laskuille."
        let skipped = skippedLocked?.count ?? 0
        return skipped > 0 ? "\(booked) \(Self.lockedNote(skipped))" : booked
    }
}
