import Foundation

/// The "Tiliotteet" section of Pankkiyhteys ja tilit (web `StatementFilesSection`):
/// the files newest month first (the server's order), six recent ones until "Näytä kaikki".
public enum StatementFiles {
    public static let recentLimit = 6

    public static func visible(_ list: [Statement], showAll: Bool) -> [Statement] {
        showAll ? list : Array(list.prefix(recentLimit))
    }

    /// "Näytä kaikki (8)" / "Näytä vähemmän"; nil when everything fits.
    public static func toggleLabel(count: Int, showAll: Bool) -> String? {
        guard count > recentLimit else { return nil }
        return showAll ? "Näytä vähemmän" : "Näytä kaikki (\(count))"
    }

    public static func txCount(_ s: Statement) -> Int { s.totals?.txCount ?? s.transactions.count }

    public static func net(_ s: Statement) -> Decimal {
        s.totals?.net ?? s.transactions.reduce(Decimal(0)) { $0 + $1.amount }
    }

    /// "tiliote-syyskuu.csv · Käyttötili · 12 tapahtumaa". The title already names the month, so
    /// three files of one month read apart by the file they came from (X095); a bank-feed statement
    /// has no file, and one without a month says so here, where its title cannot.
    public static func secondary(_ s: Statement) -> String {
        let parts: [String?] = [s.periodMonth == nil ? StatementText.month(nil) : nil, isBankFeed(s) ? nil : s.fileName,
                                s.bankAccount?.name, "\(txCount(s)) tapahtumaa"]
        return parts
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// Fetched over the bank connection rather than imported as a file.
    public static func isBankFeed(_ s: Statement) -> Bool { s.fileType == "enablebanking" }
}

/// The answer of `POST /api/statements` (multipart `file`, optional `bankAccountId`).
public struct StatementUploadResult: Decodable, Sendable {
    public struct Made: Decodable, Sendable { public let id: String? }
    public let count: Int?
    public let notice: String?
    public let statement: Made?

    public var statementId: String? { statement?.id }

    /// "Tuotiin 4 tapahtumaa." plus the server's note, if any.
    public var message: String {
        ["Tuotiin \(count ?? 0) tapahtumaa.", notice].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }
}
