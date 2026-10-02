import Foundation

/// Wording of the tiliote screen, the same as the web app.
public enum StatementText {
    /// "Lokakuu 2026"; "Ei kuukautta" without one.
    public static func month(_ key: String?) -> String {
        guard let key else { return "Ei kuukautta" }
        guard key.range(of: #"^\d{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil else { return key }
        return "\(MonthKey.name(key)) \(key.prefix(4))"
    }

    /// "Tiliote · Syyskuu 2026", or "Pankkiyhteys · …" for a bank-feed statement.
    public static func title(_ s: Statement) -> String {
        let label = s.fileType == "enablebanking" ? "Pankkiyhteys" : "Tiliote"
        guard let m = s.periodMonth else { return label }
        return "\(label) · \(month(m))"
    }

    static let invoiceStaysPaid = "Lasku jää maksetuksi, ja siitä tehty hyväksytty myynti merkitään hylätyksi, jotta myynti ei tuplaannu."

    /// The delete confirmation's body.
    public static func deleteDescription(title: String, rows: [BankTransaction]) -> String {
        let sales = rows.contains { $0.matchStatus == "suggested" && $0.suggestedReceipt?.source == "auto_income" }
        let invoices = rows.contains { $0.settlesInvoice == true }
        return [
            "\(title) ja kaikki sen tapahtumat poistetaan pysyvästi.",
            sales ? "Niistä tehdyt hyväksymättömät myyntiehdotukset poistuvat myös." : "",
            invoices ? "Osa tapahtumista on maksanut laskuja. \(invoiceStaysPaid)" : "",
            "Tätä ei voi perua.",
        ].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// "Meno", "Tulo", "Palkka", "Siirto".
    public static func typeLabel(_ type: String) -> String {
        switch type {
        case "tulo": "Tulo"
        case "palkka": "Palkka"
        case "oma_siirto": "Siirto"
        default: "Meno"
        }
    }
}

/// `POST /api/statements/[id]/reinfer-types`.
public struct StatementReinferResult: Decodable, Sendable {
    public let updated: Int?
    public let statement: Statement?
    public var message: String {
        let n = updated ?? 0
        return n > 0 ? "\(n) tapahtuman tyyppi päivitetty" : "Tyypit olivat jo ajan tasalla"
    }
}

extension LKError {
    /// The server refused because the month is closed (Kirjanpito > Suljetut kaudet).
    public var isPeriodLocked: Bool { code == "PERIOD_LOCKED" }
}

extension StatementText {
    /// The row delete confirmation's body.
    public static func deleteRowDescription(_ row: BankTransaction) -> String {
        let sale = row.matchStatus == "suggested" && row.suggestedReceipt?.source == "auto_income"
        return [
            "Tapahtuma poistetaan pysyvästi.",
            sale ? "Siitä tehty hyväksymätön myyntiehdotus poistuu myös." : "",
            row.settlesInvoice == true ? "Tapahtuma on maksanut laskun. \(invoiceStaysPaid)" : "",
        ].filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// `PATCH /api/statements/[id]/transactions`: one row's edit, as the web sends it.
/// Empty texts go as null (cleared); the amount's sign follows the type.
public struct StatementRowPatch: Encodable, Sendable, Equatable {
    public static let types = ["meno", "tulo", "palkka", "oma_siirto"]

    public let transactionId: String
    public let counterparty: String?
    public let date: String?
    public let amount: Decimal
    public let type: String
    public let message: String?

    enum CodingKeys: String, CodingKey { case transactionId, counterparty, date, amount, type, message }

    public static func make(transactionId: String, counterparty: String?, date: String?, amount: String, type: String, message: String?) throws -> StatementRowPatch {
        guard let value = Money.parse(amount) else { throw LKError(status: 0, message: "Anna tapahtumalle kelvollinen summa") }
        let magnitude = value < 0 ? -value : value
        let signed: Decimal
        switch type {
        case "tulo": signed = magnitude
        case "meno", "palkka": signed = -magnitude
        default: signed = value
        }
        func clean(_ text: String?) -> String? {
            let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return t.isEmpty ? nil : t
        }
        return StatementRowPatch(transactionId: transactionId, counterparty: clean(counterparty), date: clean(date),
                                 amount: signed, type: type, message: clean(message))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(transactionId, forKey: .transactionId)
        try c.encode(counterparty, forKey: .counterparty)
        try c.encode(date, forKey: .date)
        try c.encode(amount, forKey: .amount)
        try c.encode(type, forKey: .type)
        try c.encode(message, forKey: .message)
    }
}
