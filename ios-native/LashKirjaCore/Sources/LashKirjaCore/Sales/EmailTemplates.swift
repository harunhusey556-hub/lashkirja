import Foundation

/// Sähköpostimallit (`/api/invoice-email-templates`): the owner's own subject and message for an
/// invoice e-mail. The text keeps placeholders such as {asiakas}; the server fills them per invoice.
public struct EmailTemplate: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let subject: String
    public let body: String
    public let kind: String
    public let isDefault: Bool
}

public struct EmailTemplateList: Decodable, Sendable {
    public let templates: [EmailTemplate]
    public let placeholders: [EmailPlaceholder]?
}

public struct EmailTemplateResponse: Decodable, Sendable { public let template: EmailTemplate }

/// POST body, and PATCH body for a full edit.
public struct EmailTemplateDraft: Encodable, Sendable, Equatable {
    public var name: String
    public var subject: String
    public var body: String
    public var isDefault: Bool
    public var kind = "invoice"

    public init(name: String, subject: String, body: String, isDefault: Bool) {
        self.name = InvoiceMailText.oneLine(name)
        self.subject = InvoiceMailText.oneLine(subject)
        self.body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        self.isDefault = isDefault
    }

    /// The first thing the server would refuse, in form order; nil when it can be saved.
    public var problem: String? {
        InvoiceMailText.nameError(name) ?? InvoiceMailText.subjectError(subject) ?? InvoiceMailText.messageError(body)
    }
}

/// PATCH `{ isDefault: true }`: "Aseta oletukseksi" from the list.
public struct EmailTemplateDefault: Encodable, Sendable { public let isDefault = true; public init() {} }

public struct EmailPlaceholder: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    public var id: String { key }
    public var token: String { "{\(key)}" }

    /// The server's list (`PLACEHOLDERS`), for the help row before the list has loaded.
    public static let all: [EmailPlaceholder] = [
        .init(key: "asiakas", label: "Asiakkaan nimi"),
        .init(key: "laskunumero", label: "Laskun numero"),
        .init(key: "summa", label: "Laskun summa"),
        .init(key: "erapaiva", label: "Eräpäivä"),
        .init(key: "viitenumero", label: "Viitenumero"),
        .init(key: "tilinumero", label: "Tilinumero (IBAN)"),
        .init(key: "yritys", label: "Yrityksesi nimi"),
    ]

    /// One line for the help row: "{asiakas} asiakkaan nimi, {summa} laskun summa, ..."
    public static func help(_ list: [EmailPlaceholder] = all) -> String {
        list.map { "\($0.token) \($0.label.prefix(1).lowercased() + $0.label.dropFirst())" }.joined(separator: ", ")
    }
}

/// "Tallenna mallina" from the send sheet: the text there is already filled for one invoice, so
/// this invoice's values are turned back into placeholders, or the reuse would greet the next
/// customer by this one's name.
public enum EmailTemplateText {
    /// Each value of this invoice replaced by its placeholder, the longest value first, only where
    /// it stands on its own (not inside a longer number or word). "–" and one-letter values stay.
    public static func toPlaceholders(_ text: String, values: [String: String]) -> String {
        let order = EmailPlaceholder.all.map(\.key)
        let pairs = values
            .map { (key: $0.key, value: $0.value.trimmingCharacters(in: .whitespaces)) }
            .filter { order.contains($0.key) && $0.value.count > 1 && $0.value != "–" }
            .sorted { $0.value.count != $1.value.count ? $0.value.count > $1.value.count
                : (order.firstIndex(of: $0.key) ?? 0) < (order.firstIndex(of: $1.key) ?? 0) }
        // Placeholders, typed or just made, are not searched again.
        var segments = existingPlaceholders(text)
        for pair in pairs {
            segments = segments.flatMap { segment -> [(text: String, done: Bool)] in
                segment.done ? [segment] : split(segment.text, value: pair.value, token: "{\(pair.key)}")
            }
        }
        return segments.map(\.text).joined()
    }

    /// True when "Tallenna mallina" has something of this invoice to offer to replace.
    public static func hasInvoiceValues(_ text: String, values: [String: String]) -> Bool {
        toPlaceholders(text, values: values) != text
    }

    private static func existingPlaceholders(_ text: String) -> [(text: String, done: Bool)] {
        var out: [(text: String, done: Bool)] = []
        var rest = text[...]
        while let range = rest.range(of: #"\{[A-Za-zÄÖäö]+\}"#, options: .regularExpression) {
            out.append((String(rest[rest.startIndex..<range.lowerBound]), false))
            out.append((String(rest[range]), true))
            rest = rest[range.upperBound...]
        }
        out.append((String(rest), false))
        return out.filter { !$0.text.isEmpty }
    }

    private static func split(_ text: String, value: String, token: String) -> [(text: String, done: Bool)] {
        var out: [(text: String, done: Bool)] = []
        let whole = text[...]
        var rest = whole
        while let range = rest.range(of: value) {
            if standsAlone(range, in: whole) {
                out.append((String(rest[rest.startIndex..<range.lowerBound]), false))
                out.append((token, true))
            } else {
                out.append((String(rest[rest.startIndex..<range.upperBound]), false))
            }
            rest = rest[range.upperBound...]
        }
        out.append((String(rest), false))
        return out.filter { !$0.text.isEmpty }
    }

    /// Not glued to a letter or digit, nor to a number through "." "," "-" or "/" (so "12" is not
    /// found in "12.1.2026", but is in "lasku 12.").
    private static func standsAlone(_ range: Range<Substring.Index>, in text: Substring) -> Bool {
        let joiners: Set<Character> = [".", ",", "-", "/"]
        if range.lowerBound > text.startIndex {
            let before = text[text.index(before: range.lowerBound)]
            if before.isLetter || before.isNumber { return false }
            if joiners.contains(before), text.index(before: range.lowerBound) > text.startIndex,
               text[text.index(text.index(before: range.lowerBound), offsetBy: -1)].isNumber { return false }
        }
        if range.upperBound < text.endIndex {
            let after = text[range.upperBound]
            if after.isLetter || after.isNumber { return false }
            let next = text.index(after: range.upperBound)
            if joiners.contains(after), next < text.endIndex, text[next].isNumber { return false }
        }
        return true
    }
}
