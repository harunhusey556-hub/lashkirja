import Testing
import Foundation
@testable import LashKirjaCore

@Test func helpTopicsHaveUniqueIdsAndText() {
    let topics = HelpContent.sections.flatMap(\.topics)
    #expect(!HelpContent.sections.isEmpty)
    #expect(Set(topics.map(\.id)).count == topics.count)
    #expect(topics.allSatisfy { !$0.title.isEmpty && !$0.body.isEmpty })
}

@Test func supportReferenceLooksLikeTheWebOne() {
    let ref = HelpContent.reference(build: "1.0.0 (7)", now: Date(timeIntervalSince1970: 1_000))
    #expect(ref == "LK-1007-" + String(1_000_000, radix: 36))
    #expect(HelpContent.reference(build: "", now: Date(timeIntervalSince1970: 0)) == "LK-unknown-0")
}

@Test func reportTextCarriesTheReference() {
    let text = HelpContent.reportText(reference: "LK-abc-1")
    #expect(text.hasPrefix("LashKirja-ongelma\nViite: LK-abc-1\n"))
    #expect(text.hasSuffix("Kerro tähän, mitä yritit tehdä:\n"))
}

@Test func supportLineWithoutAddress() {
    #expect(HelpContent.supportLine(nil).hasPrefix("Tukiosoitetta ei ole vielä määritetty"))
    #expect(HelpContent.supportLine("tuki@lk.fi") == "Voit myös kirjoittaa suoraan osoitteeseen tuki@lk.fi.")
}

@Test func assistantStatusDecodes() throws {
    #expect(try JSONDecoder().decode(AssistantStatus.self, from: Data(#"{"available":false}"#.utf8)).available == false)
}

@Test func retryAfterParsesSecondsAndDefaults() {
    let now = Date(timeIntervalSince1970: 100)
    #expect(AssistantCooldown.until(retryAfter: "30", now: now) == Date(timeIntervalSince1970: 130))
    #expect(AssistantCooldown.until(retryAfter: nil, now: now) == Date(timeIntervalSince1970: 160))
    #expect(AssistantCooldown.until(retryAfter: "abc", now: now) == Date(timeIntervalSince1970: 160))
    #expect(AssistantCooldown.until(retryAfter: "100000", now: now) == Date(timeIntervalSince1970: 100 + 600))
}

@Test func assistantIntroFollowsAvailability() {
    #expect(AssistantCooldown.intro(available: false).hasPrefix("Voin opastaa sovelluksessa"))
    #expect(AssistantCooldown.intro(available: nil).hasPrefix("Autan tilisi tietojen"))
    #expect(AssistantCooldown.shortcuts.map(\.label) == ["Yhdistä pankki", "Kohdista kuitit", "Tämän kuun ALV"])
}

/// chat-send: the row is laid out while the reply is on its way, so the reply landing does not
/// insert it (above the messages, it pushed the question down when the answer came).
@Test func limitedModeShortcutRowWaitsUnderTheConversation() {
    #expect(AssistantCooldown.shortcutRow(available: false, messageCount: 2, replying: true, lastRole: "assistant") == .reserved)
    #expect(AssistantCooldown.shortcutRow(available: false, messageCount: 2, replying: false, lastRole: "assistant") == .shown)
    // The empty conversation has the shortcuts in its greeting; a question with no reply has none.
    #expect(AssistantCooldown.shortcutRow(available: false, messageCount: 0, replying: false, lastRole: nil) == .none)
    #expect(AssistantCooldown.shortcutRow(available: false, messageCount: 1, replying: false, lastRole: "user") == .none)
    // With a model (or before its status is known) the replies carry their own next steps.
    #expect(AssistantCooldown.shortcutRow(available: true, messageCount: 2, replying: false, lastRole: "assistant") == .none)
    #expect(AssistantCooldown.shortcutRow(available: nil, messageCount: 2, replying: true, lastRole: "assistant") == .none)
}
