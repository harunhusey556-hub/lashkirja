import Foundation

/// `GET /api/ai/status`: whether a language model answers free-form questions.
public struct AssistantStatus: Decodable, Sendable { public let available: Bool }

/// The assistant's limited mode and the chat rate limit (429 "Liian monta viestiä").
public enum AssistantCooldown {
    public static let defaultSeconds: TimeInterval = 60
    public static let maxSeconds: TimeInterval = 600

    /// When sending opens again after a 429, from its `Retry-After` seconds.
    public static func until(retryAfter: String?, now: Date = Date()) -> Date {
        let seconds = retryAfter.flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) }.map { max(1, $0) } ?? defaultSeconds
        return now.addingTimeInterval(min(seconds, maxSeconds))
    }

    public static func intro(available: Bool?) -> String {
        available == false
            ? "Voin opastaa sovelluksessa, avata pankin yhdistämisen ja auttaa kuittien kohdistamisessa sekä ALV:ssa."
            : "Autan tilisi tietojen ja kirjanpidon perusteella. Kysy tai avaa seuraava vaihe suoraan vastauksen painikkeesta."
    }

    /// The server's 429 sentence for the chat (api/ai/chat).
    public static let rateLimitedMessage = "Liian monta viestiä. Odota hetki."
    public static let cooldownNote = "Liian monta viestiä. Voit lähettää uuden hetken kuluttua."

    public static let unavailableNote = "Tekoälyavustaja ei ole juuri nyt käytössä. Pikakomennot toimivat silti."

    public struct Shortcut: Sendable, Identifiable {
        public let label: String
        public let message: String
        public var id: String { label }
    }

    /// The limited mode's shortcut row under the conversation, kept at hand after each reply.
    public enum ShortcutRow: Equatable, Sendable {
        case none
        /// Laid out but not shown, while a reply is on its way.
        case reserved
        case shown
    }

    /// Where the conversation ends in that row. It stands under the messages, never above them,
    /// and takes its place as soon as a question is sent: the reply landing then only fades the
    /// row in, and nothing above it moves (motion audit chat-send).
    public static func shortcutRow(available: Bool?, messageCount: Int, replying: Bool, lastRole: String?) -> ShortcutRow {
        guard available == false, messageCount > 0 else { return .none }
        if replying { return .reserved }
        return lastRole == "assistant" ? .shown : .none
    }

    /// The shortcuts that always work, model or not.
    public static let shortcuts = [
        Shortcut(label: "Yhdistä pankki", message: "Mistä voin yhdistää pankkini?"),
        Shortcut(label: "Kohdista kuitit", message: "Kohdista kuitit"),
        Shortcut(label: "Tämän kuun ALV", message: "Mikä on tämän kuun ALV?"),
    ]
}
