import Testing
import Foundation
@testable import LashKirjaCore

@Test func loadGenerationDropsSupersededResults() {
    var gen = LoadGeneration()
    let first = gen.current
    #expect(gen.isCurrent(first))
    let second = gen.next()
    #expect(!gen.isCurrent(first))
    #expect(gen.isCurrent(second))
}

@Test func uniquedByIdKeepsFirstOccurrenceInOrder() {
    let a = ChatMessage(id: "a", role: "user", content: "1")
    let b = ChatMessage(id: "b", role: "assistant", content: "2")
    let dup = ChatMessage(id: "a", role: "user", content: "3")
    let result = [a, b, dup].uniquedById()
    #expect(result.map(\.id) == ["a", "b"])
    #expect(result.first?.content == "1")
}

@Test func kotiHiddenSurvivesReloadWhileActionPending() {
    var rows = KotiHiddenRows()
    rows.hide("r1")
    rows.hide("r2")
    // r1 waits for "Kumoa" and is still on the server; r2 is gone from the answer.
    rows.reloaded(present: ["r1", "r3"], loadGeneration: 1)
    #expect(rows.ids == ["r1"])
    rows.unhide("r1")
    #expect(!rows.contains("r1"))
}

@Test func kotiHiddenSettledRowStaysHiddenOnlyForOlderLoads() {
    var rows = KotiHiddenRows()
    rows.hide("r1")
    // Accepted while load 4 was running: load 4's old answer must not bring it back.
    rows.settled("r1", loadGeneration: 4)
    rows.reloaded(present: ["r1"], loadGeneration: 4)
    #expect(rows.contains("r1"))
    // A load that started after acceptance still has the row: the server's truth wins.
    rows.reloaded(present: ["r1"], loadGeneration: 5)
    #expect(!rows.contains("r1"))
}

@Test func kotiHiddenSettledRowForgottenWhenGone() {
    var rows = KotiHiddenRows()
    rows.hide("r1")
    rows.settled("r1", loadGeneration: 2)
    rows.reloaded(present: [], loadGeneration: 3)
    #expect(rows.ids.isEmpty)
    // A later reload with the same id (a new row) is not hidden.
    rows.reloaded(present: ["r1"], loadGeneration: 4)
    #expect(!rows.contains("r1"))
}

@Test func appLockKeptOnlyForItsOwner() {
    #expect(AppLockPolicy.keepsLock(owner: "u1", signingIn: "u1"))
    #expect(!AppLockPolicy.keepsLock(owner: "u1", signingIn: "u2"))
    // A lock with no recorded owner cannot be trusted to belong to the new account.
    #expect(!AppLockPolicy.keepsLock(owner: nil, signingIn: "u1"))
}

@Test func foregroundStaleAfterFiveMinutes() {
    let t0 = Date(timeIntervalSince1970: 1_000)
    #expect(!ForegroundRefresh.isStale(backgroundedAt: nil, now: t0))
    #expect(!ForegroundRefresh.isStale(backgroundedAt: t0, now: t0.addingTimeInterval(299)))
    #expect(ForegroundRefresh.isStale(backgroundedAt: t0, now: t0.addingTimeInterval(301)))
}
