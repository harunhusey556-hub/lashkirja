import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

// MARK: - LoadFailure: what went wrong, in the owner's words

@Test func loadFailureIgnoresCancellation() {
    #expect(LoadFailure(CancellationError()) == nil)
    #expect(LoadFailure(URLError(.cancelled)) == nil)
}

@Test func loadFailureEndedSessionIsSessionExpired() {
    let failure = LoadFailure(LKError(status: 401, code: "UNAUTHORIZED", message: "Ei kirjautunut"))
    #expect(failure?.kind == .sessionExpired)
    #expect(failure?.canRetry == false)
}

@Test func loadFailureOtherUnauthorizedKeepsServerWords() {
    // A 401 that does not end the session (e.g. a wrong current password) is the server's sentence.
    let failure = LoadFailure(LKError(status: 401, code: "WRONG_PASSWORD", message: "Väärä salasana."))
    #expect(failure?.kind == .server)
    #expect(failure?.message == "Väärä salasana.")
}

@Test func loadFailureOfflineURLErrors() {
    for code: URLError.Code in [.notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff] {
        #expect(LoadFailure(URLError(code))?.kind == .offline)
    }
    #expect(LoadFailure(LKError.offline())?.kind == .offline)
}

@Test func loadFailureTimeoutIsNotOffline() {
    #expect(LoadFailure(URLError(.timedOut))?.kind == .timeout)
    #expect(LoadFailure(LKError(status: 0, code: "TIMEOUT", message: LKError.unreachable))?.kind == .timeout)
    #expect(LoadFailure(LKError(status: 504, message: LKError.unreachable))?.kind == .timeout)
}

@Test func loadFailureGatewayIsUnavailable() {
    #expect(LoadFailure(LKError(status: 502, message: LKError.unreachable))?.kind == .unavailable)
    #expect(LoadFailure(LKError(status: 503, message: LKError.unreachable))?.kind == .unavailable)
    #expect(LoadFailure(LKError(status: 0, code: "NETWORK", message: LKError.unreachable))?.kind == .unavailable)
    #expect(LoadFailure(URLError(.cannotConnectToHost))?.kind == .unavailable)
    #expect(LoadFailure(URLError(.networkConnectionLost))?.kind == .unavailable)
}

@Test func loadFailureAppAnswered503KeepsItsSentence() {
    let failure = LoadFailure(LKError(status: 503, message: "Pankkiyhteys ei juuri nyt vastaa."))
    #expect(failure?.kind == .unavailable)
    #expect(failure?.message == "Pankkiyhteys ei juuri nyt vastaa.")
}

@Test func loadFailureDecodeIsUnreadable() {
    let failure = LoadFailure(LKError(status: 200, code: "DECODE", message: "Palvelimen vastausta ei voitu lukea."))
    #expect(failure?.kind == .unreadable)
}

@Test func loadFailureServerErrorUsesServerSentence() {
    let failure = LoadFailure(LKError(status: 404, code: "NOT_FOUND", message: "Laskua ei löytynyt."))
    #expect(failure?.kind == .server)
    #expect(failure?.message == "Laskua ei löytynyt.")
}

@Test func loadFailureCopyIsFinnishWithoutRawCodes() {
    let errors: [Error] = [
        URLError(.notConnectedToInternet), URLError(.timedOut),
        LKError(status: 502, message: LKError.unreachable),
        LKError(status: 401, code: "UNAUTHORIZED", message: "Ei kirjautunut"),
        LKError(status: 200, code: "DECODE", message: "x"),
        NSError(domain: "x", code: 7),
    ]
    for error in errors {
        let failure = LoadFailure(error)!
        #expect(!failure.title.isEmpty)
        #expect(!failure.message.isEmpty)
        for raw in ["401", "502", "503", "504", "DECODE", "UNAUTHORIZED", "NETWORK", "URLError"] {
            #expect(!failure.title.contains(raw))
            #expect(!failure.message.contains(raw))
        }
    }
}

@Test func transportErrorsKeepOfflineAndTimeoutApart() {
    #expect((APIClient.transportError(URLError(.notConnectedToInternet)) as? LKError)?.code == "OFFLINE")
    #expect((APIClient.transportError(URLError(.timedOut)) as? LKError)?.code == "TIMEOUT")
    #expect((APIClient.transportError(URLError(.cannotFindHost)) as? LKError)?.code == "NETWORK")
    #expect(APIClient.transportError(URLError(.cancelled)) is CancellationError)
    // Every transport failure stays status 0, which the upload queue and POS read as "network".
    #expect((APIClient.transportError(URLError(.timedOut)) as? LKError)?.status == 0)
}

// MARK: - ScreenLoad: one state for every network-backed screen

@Test func screenLoadFirstLoadShowsSpinnerThenContent() {
    var load = ScreenLoad<[Int]>()
    #expect(load.display == .loading)
    load.begin()
    #expect(load.phase == .loading)
    #expect(load.display == .loading)
    load.succeed([1, 2])
    #expect(load.display == .content([1, 2]))
    #expect(load.banner == nil)
    #expect(load.phase == .settled)
}

@Test func screenLoadRefreshKeepsOldData() {
    var load = ScreenLoad<[Int]>()
    load.succeed([1])
    load.begin()
    #expect(load.phase == .refreshing)
    #expect(load.isRefreshing)
    // Never a full-screen spinner over data already shown.
    #expect(load.display == .content([1]))
    load.succeed([1, 2])
    #expect(load.display == .content([1, 2]))
}

@Test func screenLoadFirstLoadFailureReplacesSpinner() {
    var load = ScreenLoad<[Int]>()
    load.begin()
    load.fail(URLError(.notConnectedToInternet))
    guard case .failed(let failure) = load.display else { Issue.record("expected failure"); return }
    #expect(failure.kind == .offline)
    #expect(load.banner == nil)
    // Retry: back to the spinner, the old failure gone.
    load.begin()
    #expect(load.display == .loading)
    load.succeed([3])
    #expect(load.display == .content([3]))
}

@Test func screenLoadRefreshFailureKeepsDataAndShowsBanner() {
    var load = ScreenLoad<[Int]>()
    load.succeed([1])
    load.begin()
    load.fail(LKError(status: 503, message: LKError.unreachable))
    #expect(load.display == .content([1]))
    #expect(load.banner?.kind == .unavailable)
    #expect(load.phase == .settled)
    // The banner stays while the retry runs and goes once it succeeds.
    load.begin()
    #expect(load.banner?.kind == .unavailable)
    load.succeed([1])
    #expect(load.banner == nil)
}

@Test func screenLoadCancellationChangesNothingShown() {
    var load = ScreenLoad<[Int]>()
    load.begin()
    load.fail(CancellationError())
    // A cancelled first load leaves the spinner (the next appearance loads again).
    #expect(load.display == .loading)
    #expect(load.phase == .idle)
    load.succeed([1])
    load.begin()
    load.fail(CancellationError())
    #expect(load.display == .content([1]))
    #expect(load.banner == nil)
    #expect(load.phase == .settled)
}

@Test func screenLoadSessionExpiredOnRefresh() {
    var load = ScreenLoad<[Int]>()
    load.succeed([1])
    load.fail(LKError(status: 401, code: "UNAUTHORIZED", message: "Ei kirjautunut"))
    #expect(load.banner?.kind == .sessionExpired)
    #expect(load.banner?.canRetry == false)
}

@Test func screenLoadRestartDropsAnotherSubjectsData() {
    var load = ScreenLoad<[Int]>()
    load.succeed([2025])
    // Another year: its figures must not sit under the new heading.
    load.restart()
    #expect(load.display == .loading)
    #expect(load.value == nil)
}

@Test func screenLoadUpdateEditsShownValueOnly() {
    var load = ScreenLoad<[Int]>()
    load.update { $0.append(1) }
    #expect(load.value == nil)
    load.succeed([1])
    load.update { $0.append(2) }
    #expect(load.value == [1, 2])
}
