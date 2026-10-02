import Foundation

/// The body of `POST /api/customers/import`: first a check (no `commit`), then the import.
public struct CustomerImportRequest: Encodable, Sendable {
    public static let maxCharacters = 200_000

    public let csv: String
    public let commit: Bool

    public init(csv: String, commit: Bool) {
        self.csv = csv
        self.commit = commit
    }

    enum CodingKeys: String, CodingKey { case csv, commit }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(csv, forKey: .csv)
        if commit { try c.encode(true, forKey: .commit) }
    }

    /// A picked file as text: UTF-8 (without its BOM), or the Windows-1252 that
    /// Excel writes on a Finnish machine.
    public static func text(from data: Data) -> String? {
        var bytes = data
        if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes = bytes.dropFirst(3) }
        if let text = String(data: bytes, encoding: .utf8) { return text }
        return String(data: bytes, encoding: .windowsCP1252)
    }

    /// The server takes at most 200 000 characters.
    public static func sizeError(_ csv: String) -> String? {
        csv.count > maxCharacters ? "Tiedosto on liian suuri (enintään 200 000 merkkiä)." : nil
    }
}

public struct CustomerImportResult: Decodable, Sendable {
    public struct Row: Decodable, Sendable, Hashable, Identifiable {
        public let line: Int
        public let name: String?
        public let email: String?
        public let phone: String?
        public let businessId: String?
        public let errors: [String]

        public var id: Int { line }
        public var isValid: Bool { errors.isEmpty }

        /// "Rivi 2: A Oy. Kelvollinen" / "Rivi 3: –. Nimi puuttuu."
        public var text: String {
            "Rivi \(line): \(name ?? "–")" + (errors.isEmpty ? ". Kelvollinen" : ". \(errors.joined(separator: " "))")
        }
    }

    public let rows: [Row]
    public let created: Int

    public var validCount: Int { rows.filter(\.isValid).count }
    public var invalidCount: Int { rows.count - validCount }

    public var statusText: String {
        "\(validCount) kelvollista" + (invalidCount > 0 ? ", \(invalidCount) virheellistä (ei tuoda)" : "")
    }

    public static func createdText(_ created: Int) -> String {
        created == 1 ? "1 asiakas tuotiin" : "\(created) asiakasta tuotiin"
    }
}

/// `POST /api/customers/merge`: `mergeId`'s invoices and schedules move to `keepId`, which stays.
public struct CustomerMergeRequest: Encodable, Sendable {
    public let keepId: String
    public let mergeId: String

    public init(keepId: String, mergeId: String) {
        self.keepId = keepId
        self.mergeId = mergeId
    }
}
