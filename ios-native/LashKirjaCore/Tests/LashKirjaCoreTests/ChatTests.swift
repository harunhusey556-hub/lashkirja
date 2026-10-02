import Testing
import Foundation
@testable import LashKirjaCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

@Test func decodesRealConversationsAndHistory() throws {
    let list = try JSONDecoder().decode(ConversationList.self, from: fixture("conversations.json"))
    #expect(!list.conversations.isEmpty)
    let history = try JSONDecoder().decode(ChatHistory.self, from: fixture("chat-history.json"))
    #expect(history.messages.contains { $0.role == "assistant" })
}

@Test func streamEvents() throws {
    #expect(try ChatEvent.parse(#"{"conversationId":"c1","userMessageId":"m1"}"#) == .started(conversationId: "c1"))
    #expect(try ChatEvent.parse(#"{"delta":"Hei"}"#) == .delta("Hei"))
    let final = try ChatEvent.parse(#"{"done":true,"status":"complete","id":"a1","content":"Hei!","sources":[{"label":"Kuitit","href":"/kuitit"}],"conversationId":"c1","limited":false}"#)
    guard case .finished(let message) = final else { Issue.record("not finished"); return }
    #expect(message.content == "Hei!")
    #expect(message.sources.first?.href == "/kuitit")
    #expect(try ChatEvent.parse(#"{"incomplete":true,"status":"busy","error":"Odota hetki"}"#) == .failed("Odota hetki"))
}

@Test func sseFinishFlushesTrailingEvent() {
    var p = SSEParser()
    #expect(p.feed(Data("data: last".utf8)).isEmpty)
    #expect(p.finish() == ["last"])
}

@Test func sseHandlesManyEventsInOneChunk() {
    var p = SSEParser()
    let chunk = (0..<2000).map { "data: \($0)\n\n" }.joined()
    let events = p.feed(Data(chunk.utf8))
    #expect(events.count == 2000)
    #expect(events.last == "1999")
}
