import Testing
import Foundation
@testable import LashKirjaCore

@Test func reloadGateLoadsFirstTimeThenWaits() {
    var gate = ReloadGate(maxAge: 60)
    let t0 = Date(timeIntervalSince1970: 1_000)
    #expect(gate.isDue(version: 0, now: t0))
    gate.mark(version: 0, now: t0)
    // Coming back to the screen 10 s later: nothing changed, no request.
    #expect(!gate.isDue(version: 0, now: t0.addingTimeInterval(10)))
    // Something changed elsewhere in the app.
    #expect(gate.isDue(version: 1, now: t0.addingTimeInterval(10)))
    // Or the figures are a minute old.
    #expect(gate.isDue(version: 0, now: t0.addingTimeInterval(61)))
}

@Test func reloadGateForgetsAfterReset() {
    var gate = ReloadGate()
    gate.mark(version: 3, now: Date())
    gate.reset()
    #expect(gate.isDue(version: 3, now: Date()))
}

@Test func reloadGateLoadsWhenTheFilterChanges() {
    var gate = ReloadGate()
    let now = Date()
    gate.mark(key: "pending", version: 0, now: now)
    #expect(!gate.isDue(key: "pending", version: 0, now: now))
    #expect(gate.isDue(key: "all", version: 0, now: now))
}

@Test func statementOpenCountDecodes() throws {
    let count = try JSONDecoder().decode(StatementOpenCount.self, from: Data(#"{"open":7}"#.utf8))
    #expect(count.open == 7)
}

@Test func asyncResultKeepsEachOutcome() async {
    struct Boom: Error {}
    let ok = await Result<Int, Error>(asyncCatching: { 7 })
    let bad = await Result<Int, Error>(asyncCatching: { throw Boom() })
    #expect((try? ok.get()) == 7)
    #expect((try? bad.get()) == nil)
}
