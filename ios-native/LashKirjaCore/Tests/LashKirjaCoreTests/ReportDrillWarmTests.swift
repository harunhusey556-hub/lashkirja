import Testing
import Foundation
@testable import LashKirjaCore

/// The server's side of the warms: every GET that reached it, by cache key.
private actor Server {
    private(set) var asked: [String: Int] = [:]
    private var held = false
    func hit(_ id: String) { asked[id, default: 0] += 1 }
    var total: Int { asked.values.reduce(0, +) }
    func hold() { held = true }
    func release() { held = false }
    func waitWhileHeld() async {
        while held { try? await Task.sleep(nanoseconds: 5_000_000) }
    }
}

private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

private final class Version: @unchecked Sendable {
    var value = 1
}

private func key(_ request: ReportDrillWarm.Request) -> ResourceKey {
    ResourceKey(user: "u1", path: request.path, query: request.query)
}

/// What Raportit's figures open: Tulot and Menot of the year, the data-quality row, two categories,
/// Tulot again (a figure in two places) and a list that is not Kuitit.
private let drills: [ReportDrill] = [
    .invoices(period: "2026", status: .all),
    .receipts(period: "2026", tab: "tulo", category: ""),
    .receipts(period: "2026", tab: "meno", category: ""),
    .receiptsMissingVat(period: "2026"),
    .receipts(period: "2026", tab: "meno", category: "tarvikkeet"),
    .receipts(period: "2026", tab: "meno", category: "vuokra"),
    .receipts(period: "2026", tab: "tulo", category: ""),
]

/// Raportit's closures over the app's cache (`AppModel.cachedValue` / `cachedGet`).
private func warm(_ warmer: ReportDrillWarmer, _ requests: [ReportDrillWarm.Request], cache: ResourceCache,
                  version: Version, server: Server) async {
    let asked = version.value
    await warmer.warm(requests, isCached: { request in
        await cache.cached(key(request), version: asked, as: Ignored.self) != nil
    }, fetch: { request in
        let answer: Ignored? = try? await cache.load(key(request), version: asked) {
            await server.hit(key(request).id)
            await server.waitWhileHeld()
            return Data("{}".utf8)
        }
        return answer != nil
    })
}

@Test func aDrillWarmAsksEachListItOpensOnce() {
    let requests = ReportDrillWarm.requests(drills)
    // Five lists (the invoices are not Kuitit, Tulot is there twice); four counts, as the counts
    // ignore the tab (Tulot and Menot of the year share theirs).
    #expect(requests.filter { $0.kind == .list }.count == 5)
    #expect(requests.filter { $0.kind == .counts }.count == 4)
    #expect(requests.first == ReportDrillWarm.Request(kind: .list, query: ReceiptListPaging.firstQuery(.drilled(month: "2026", tab: .tulo))))
    #expect(Set(requests).count == requests.count)
}

/// Row 23: Raportit reloads (a pull-to-refresh, a write elsewhere, coming back after a minute or
/// within one) and the drills it warms were asked again each time, two GETs per receipts drill.
/// A list already answered paints with the push (fresh or not; the list refreshes it itself), so
/// N reloads ask each distinct drill query at most once.
@Test func reloadsWarmEachDrillQueryAtMostOnce() async {
    let clock = Clock()
    let version = Version()
    let cache = ResourceCache(now: { clock.now })
    let server = Server()
    let warmer = ReportDrillWarmer()
    let requests = ReportDrillWarm.requests(drills)

    await warm(warmer, requests, cache: cache, version: version, server: server)
    #expect(await server.total == requests.count)

    for reload in 0..<8 {
        switch reload % 4 {
        case 0: version.value += 1                              // pull-to-refresh
        case 1: clock.now += 61                                 // back after more than a minute
        case 2: clock.now += 10                                 // back within a minute
        default: version.value += 1; clock.now += 5             // a write elsewhere
        }
        await warm(warmer, requests, cache: cache, version: version, server: server)
    }
    let asked = await server.asked
    #expect(asked.count == requests.count)
    #expect(asked.values.allSatisfy { $0 == 1 }, "asked more than once: \(asked.filter { $0.value > 1 })")
    #expect(await server.total == requests.count)
}

/// A reload while the warm is still on its way (another year, new figures): the GETs it had not
/// started yet are not sent; another screen's warm asks only what is still missing.
@Test func aCancelledWarmStartsNothingMore() async throws {
    let cache = ResourceCache()
    let version = Version()
    let server = Server()
    let warmer = ReportDrillWarmer()
    let requests = ReportDrillWarm.requests(drills)
    await server.hold()
    let task = Task { await warm(warmer, requests, cache: cache, version: version, server: server) }
    while await server.total == 0 { try await Task.sleep(nanoseconds: 5_000_000) }
    task.cancel()
    await server.release()
    await task.value
    let started = await server.total
    #expect(started <= ReportDrillWarmer.width, "\(started) of \(requests.count) GETs sent after the cancel")

    // The next warm (same version) sends the rest once; none of the first ones again.
    await warm(warmer, requests, cache: cache, version: version, server: server)
    let asked = await server.asked
    #expect(asked.count == requests.count)
    #expect(asked.values.allSatisfy { $0 == 1 })
}
