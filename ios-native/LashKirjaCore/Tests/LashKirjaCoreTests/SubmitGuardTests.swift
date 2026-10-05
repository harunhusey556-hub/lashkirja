import Testing
import Foundation
@testable import LashKirjaCore

/// Hands out "k1", "k2", ... so the tests can tell keys apart.
private final class KeyCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> String {
        lock.lock(); defer { lock.unlock() }
        n += 1
        return "k\(n)"
    }
}

private func makeGuard() -> SubmitGuard {
    let counter = KeyCounter()
    return SubmitGuard(makeKey: { counter.next() })
}

@Test func submitGuardIgnoresASecondTapWhileInFlight() {
    var submit = makeGuard()
    #expect(!submit.inFlight)
    #expect(submit.begin() == "k1")
    #expect(submit.inFlight)
    // The second tap (or a re-entrant Task) sends nothing.
    #expect(submit.begin() == nil)
    #expect(submit.begin() == nil)
    submit.finish(succeeded: true)
    #expect(!submit.inFlight)
}

@Test func submitGuardReusesTheKeyWhenTheUserRetriesAfterAFailure() {
    var submit = makeGuard()
    #expect(submit.begin() == "k1")
    submit.finish(succeeded: false)   // network lost: did it go through? the server knows by the key
    #expect(!submit.inFlight)
    #expect(submit.begin() == "k1")
    submit.finish(succeeded: false)
    #expect(submit.begin() == "k1")
}

@Test func submitGuardUsesANewKeyAfterASuccess() {
    var submit = makeGuard()
    #expect(submit.begin() == "k1")
    submit.finish(succeeded: true)
    #expect(submit.key == "k2")
    #expect(submit.begin() == "k2")
    submit.finish(succeeded: false)
    #expect(submit.begin() == "k2")
    submit.finish(succeeded: true)
    #expect(submit.begin() == "k3")
}

@Test func submitGuardRenewsOnlyWhenIdle() {
    var submit = makeGuard()
    #expect(submit.begin() == "k1")
    submit.renew()                    // the running attempt keeps its key
    #expect(submit.key == "k1")
    submit.finish(succeeded: false)
    submit.renew()                    // a genuinely new action
    #expect(submit.begin() == "k2")
}

@Test func submitGuardDefaultKeysAreUnique() {
    var submit = SubmitGuard()
    let first = submit.begin()
    submit.finish(succeeded: true)
    let second = submit.begin()
    #expect(first != nil && second != nil && first != second)
}
