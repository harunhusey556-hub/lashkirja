import Testing
import Foundation
@testable import LashKirjaCore

@Test func parsesEvents() {
    var p = SSEParser()
    let events = p.feed(Data("data: {\"a\":1}\n\ndata: {\"delta\":\"Hei\"}\n\n".utf8))
    #expect(events == [#"{"a":1}"#, #"{"delta":"Hei"}"#])
}

@Test func splitAcrossChunks() {
    var p = SSEParser()
    let whole = Array("data: {\"delta\":\"Päivää\"}\n\n".utf8)
    var out: [String] = []
    for byte in whole { out += p.feed(Data([byte])) }
    #expect(out == [#"{"delta":"Päivää"}"#])
}

@Test func ignoresCommentsAndCRLF() {
    var p = SSEParser()
    #expect(p.feed(Data(": keepalive\r\n\r\ndata: x\r\n\r\n".utf8)) == ["x"])
}

@Test func incompleteEventWaits() {
    var p = SSEParser()
    #expect(p.feed(Data("data: half".utf8)).isEmpty)
    #expect(p.feed(Data("\n\n".utf8)) == ["half"])
}
