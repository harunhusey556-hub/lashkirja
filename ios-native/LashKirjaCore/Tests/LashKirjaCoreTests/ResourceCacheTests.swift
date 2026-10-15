import Testing
import Foundation
@testable import LashKirjaCore

private struct Box: Decodable, Equatable { let n: Int }

private func body(_ n: Int) -> Data { Data(#"{"n":\#(n)}"#.utf8) }

private actor Calls {
    private(set) var count = 0
    func hit() { count += 1 }
}

private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

private func tempStore() -> ResourceDiskStore {
    ResourceDiskStore(directory: FileManager.default.temporaryDirectory
        .appendingPathComponent("resource-cache-tests-\(UUID().uuidString)", isDirectory: true))
}

private let key = ResourceKey(user: "u1", path: "/api/receipts", query: ["sort": "date_desc", "cursor": ""])

// MARK: Cache

@Suite struct ResourceCacheTests {
    @Test func theKeyIsTheSameForAQueryInAnyOrderAndApartPerUser() {
        let a = ResourceKey(user: "u1", path: "/api/x", query: ["a": "1", "b": "2"])
        let b = ResourceKey(user: "u1", path: "/api/x", query: ["b": "2", "a": "1"])
        let other = ResourceKey(user: "u2", path: "/api/x", query: ["a": "1", "b": "2"])
        #expect(a.id == b.id)
        #expect(a.id != other.id)
        #expect(a.id == "u1|/api/x?a=1&b=2")
    }

    @Test func twoScreensAskingAtOnceShareOneRequest() async throws {
        let cache = ResourceCache()
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = {
            await calls.hit()
            try await Task.sleep(nanoseconds: 100_000_000)
            return body(1)
        }
        async let first: Box = cache.load(key, version: 0, fetch: fetch)
        async let second: Box = cache.load(key, version: 0, fetch: fetch)
        let (a, b) = try await (first, second)
        #expect(a == Box(n: 1))
        #expect(b == Box(n: 1))
        #expect(await calls.count == 1)
    }

    @Test func aFreshAnswerIsHandedBackWithoutAskingAgain() async throws {
        let cache = ResourceCache()
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = { await calls.hit(); return body(await calls.count) }
        let first: Box = try await cache.load(key, version: 3, fetch: fetch)
        let second: Box = try await cache.load(key, version: 3, fetch: fetch)
        #expect(first == Box(n: 1))
        #expect(second == Box(n: 1))
        #expect(await calls.count == 1)
        #expect(await cache.isFresh(key, version: 3))
    }

    @Test func aChangedVersionAsksAgainButTheOldAnswerShowsMeanwhile() async throws {
        let cache = ResourceCache()
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = { await calls.hit(); return body(await calls.count) }
        let _: Box = try await cache.load(key, version: 1, fetch: fetch)
        // A write elsewhere bumped the version: the screen paints the old answer at once...
        let hit = try #require(await cache.cached(key, version: 2, as: Box.self))
        #expect(hit.value == Box(n: 1))
        #expect(hit.isFresh == false)
        // ...and the load revalidates.
        let fresh: Box = try await cache.load(key, version: 2, fetch: fetch)
        #expect(fresh == Box(n: 2))
        #expect(await calls.count == 2)
        #expect(await cache.cached(key, version: 2, as: Box.self)?.isFresh == true)
    }

    @Test func anAnswerOlderThanSixtySecondsIsAskedAgain() async throws {
        let clock = Clock()
        let cache = ResourceCache(now: { clock.now })
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = { await calls.hit(); return body(await calls.count) }
        let _: Box = try await cache.load(key, version: 0, fetch: fetch)
        clock.now += 59
        let within: Box = try await cache.load(key, version: 0, fetch: fetch)
        #expect(within == Box(n: 1))
        clock.now += 2
        #expect(await cache.isFresh(key, version: 0) == false)
        let after: Box = try await cache.load(key, version: 0, fetch: fetch)
        #expect(after == Box(n: 2))
    }

    @Test func forceAsksEvenWhileFresh() async throws {
        let cache = ResourceCache()
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = { await calls.hit(); return body(await calls.count) }
        let _: Box = try await cache.load(key, version: 0, fetch: fetch)
        let forced: Box = try await cache.load(key, version: 0, force: true, fetch: fetch)
        #expect(forced == Box(n: 2))
    }

    @Test func aFailedRefreshKeepsTheCachedAnswer() async throws {
        let cache = ResourceCache()
        let _: Box = try await cache.load(key, version: 0) { body(7) }
        await #expect(throws: LKError.self) {
            let _: Box = try await cache.load(key, version: 1) { throw LKError.offline() }
        }
        #expect(await cache.cached(key, version: 1, as: Box.self)?.value == Box(n: 7))
        // The failure is not remembered: the next load asks again.
        let next: Box = try await cache.load(key, version: 1) { body(8) }
        #expect(next == Box(n: 8))
    }

    @Test func anAnswerThatDoesNotDecodeIsADecodeFailureAndIsNotKept() async throws {
        let cache = ResourceCache()
        let _: Box = try await cache.load(key, version: 0) { body(1) }
        do {
            let _: Box = try await cache.load(key, version: 1) { Data(#"{"other":true}"#.utf8) }
            Issue.record("expected a decode failure")
        } catch let error as LKError {
            #expect(error.code == "DECODE")
        }
        #expect(await cache.cached(key, version: 1, as: Box.self)?.value == Box(n: 1))
    }

    @Test func aSlowAnswerForAnOlderVersionNeverReplacesANewerOne() async throws {
        let cache = ResourceCache()
        await cache.prime(key, data: body(5), version: 5)
        let late: Box = try await cache.load(key, version: 3, force: true) { body(3) }
        // The screen that asked gets its answer; the cache keeps the newer one.
        #expect(late == Box(n: 3))
        #expect(await cache.cached(key, version: 5, as: Box.self)?.value == Box(n: 5))
    }

    @Test func differentVersionsDoNotShareARequest() async throws {
        let cache = ResourceCache()
        let calls = Calls()
        let fetch: @Sendable () async throws -> Data = {
            await calls.hit()
            try await Task.sleep(nanoseconds: 50_000_000)
            return body(await calls.count)
        }
        async let old: Box = cache.load(key, version: 0, fetch: fetch)
        try await Task.sleep(nanoseconds: 10_000_000)
        async let new: Box = cache.load(key, version: 1, fetch: fetch)
        _ = try await (old, new)
        #expect(await calls.count == 2)
    }

    @Test func clearForgetsEverythingAndDropsAnswersOnTheirWay() async throws {
        let cache = ResourceCache()
        let _: Box = try await cache.load(key, version: 0) { body(1) }
        await cache.clear()
        #expect(await cache.cached(key, version: 0, as: Box.self) == nil)

        let slow = Task { () async throws -> Box in
            try await cache.load(key, version: 0) {
                try await Task.sleep(nanoseconds: 100_000_000)
                return body(2)
            }
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        await cache.clear()
        _ = try? await slow.value
        #expect(await cache.cached(key, version: 0, as: Box.self) == nil)
    }

    @Test func primedBytesStandForTheKey() async throws {
        let cache = ResourceCache()
        await cache.prime(key, data: body(9), version: 2)
        let calls = Calls()
        let value: Box = try await cache.load(key, version: 2) { await calls.hit(); return body(0) }
        #expect(value == Box(n: 9))
        #expect(await calls.count == 0)
    }
}

// MARK: Disk

// MARK: Last good answer (w35: screens paint the cached answer, then refresh it in place)

private struct Figures: Decodable, Equatable { let n: Int }
private struct Report: Decodable, Equatable { let n: Int; let extra: String? }

@Suite struct LastGoodAnswerTests {
    @Test func aStaleAnswerIsShownAndTheRefreshReplacesIt() async throws {
        let clock = Clock()
        let cache = ResourceCache(now: { clock.now })
        let _: Box = try await cache.load(key, version: 0) { body(1) }
        clock.now += 120
        // The screen opens: the old answer paints at once, marked stale...
        let shown = try #require(await cache.cached(key, version: 0, as: Box.self))
        #expect(shown.value == Box(n: 1))
        #expect(shown.isFresh == false)
        // ...its load asks the server, and the answer takes the old one's place.
        let fresh: Box = try await cache.load(key, version: 0) { body(2) }
        #expect(fresh == Box(n: 2))
        let after = try #require(await cache.cached(key, version: 0, as: Box.self))
        #expect(after.value == Box(n: 2))
        #expect(after.isFresh)
    }

    @Test func aPullToRefreshReplacesEvenAFreshAnswer() async throws {
        let cache = ResourceCache()
        let _: Box = try await cache.load(key, version: 0) { body(1) }
        let refreshed: Box = try await cache.load(key, version: 0, force: true) { body(2) }
        #expect(refreshed == Box(n: 2))
        #expect(await cache.cached(key, version: 0, as: Box.self)?.value == Box(n: 2))
    }

    @Test func theLastLaunchsAnswerShowsAndAFailedRefreshKeepsIt() async throws {
        let store = tempStore()
        defer { store.removeAll() }
        let first = ResourceCache(store: store)
        let _: Box = try await first.load(key, version: 0, persist: true) { body(5) }
        await first.flushWrites()
        // Next launch, offline: the figures of last time are on screen, and stay there.
        let next = ResourceCache(store: store)
        #expect(await next.cached(key, version: 0, as: Box.self)?.value == Box(n: 5))
        await #expect(throws: LKError.self) {
            let _: Box = try await next.load(key, version: 0) { throw LKError.offline() }
        }
        #expect(await next.cached(key, version: 0, as: Box.self)?.value == Box(n: 5))
        let back: Box = try await next.load(key, version: 0) { body(6) }
        #expect(back == Box(n: 6))
    }

    @Test func twoScreensReadOneAnswerAsTheirOwnTypes() async throws {
        // Koti reads /api/alv as its row's figures, the ALV screen as the whole report: one request.
        let cache = ResourceCache()
        let calls = Calls()
        let alv = ResourceKey(user: "u1", path: "/api/alv", query: ["period": "2026-Q3"])
        let _: Figures = try await cache.load(alv, version: 0) {
            await calls.hit()
            return Data(#"{"n":4,"extra":"x"}"#.utf8)
        }
        let report = try #require(await cache.cached(alv, version: 0, as: Report.self))
        #expect(report.value == Report(n: 4, extra: "x"))
        #expect(report.isFresh)
        let again: Figures = try await cache.load(alv, version: 0) { await calls.hit(); return Data() }
        #expect(again == Figures(n: 4))
        #expect(await calls.count == 1)
    }
}

@Suite struct NextPrefetchTests {
    @Test func kotiWarmsTheOtherTabsWithTheirScreensQueries() {
        let requests = NextPrefetch.afterKoti(month: "2026-10")
        // Myynti opens on every invoice, no chip, no search.
        #expect(requests.contains(PrefetchRequest(path: "/api/invoices", query: SalesListQuery.query(scope: InvoiceScope(), filter: .all, search: ""))))
        #expect(requests.contains(PrefetchRequest(path: "/api/invoices/counts", query: [:], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/receipts/counts", query: ReceiptListQuery.pendingCountQuery, persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/reports/profit-loss", query: ["from": "2026-01", "to": "2026-12"], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/ai/chat", persist: false)))
        // Only the launch lists go to disk; Myynti's list is one of the screen's own persisted keys.
        #expect(requests.filter(\.persist).map(\.path) == ["/api/invoices"])
    }

    @Test func kirjanpitoWarmsTheFeedsFirstPageTheCloseMonthAndTheReturnDue() {
        let requests = NextPrefetch.kirjanpito(month: "2026-10", alvPeriod: "2026-Q3")
        #expect(requests.contains(PrefetchRequest(path: "/api/statements", query: ["cursor": "", "limit": "50"], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/bank/connections", persist: false)))
        // "Kuukauden sulku" opens on last month.
        #expect(requests.contains(PrefetchRequest(path: "/api/dashboard/month", query: ["month": "2026-09"], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/period-lock", persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/alv", query: ["period": "2026-Q3"], persist: false)))
        #expect(NextPrefetch.kirjanpito(month: "2026-10", alvPeriod: nil).allSatisfy { $0.path != "/api/alv" })
    }

    @Test func myyntiWarmsTheNewInvoiceForm() {
        #expect(NextPrefetch.myynti().map(\.path) == ["/api/customers", "/api/catalog", "/api/recurring-invoices"])
        // Toistuvat laskut opens on its active plans: no query, so the screen finds this answer.
        #expect(NextPrefetch.myynti().last?.query == [:])
    }
}

@Suite struct ResourceDiskTests {
    @Test func aPersistedListPaintsOnTheNextLaunchButIsNeverFresh() async throws {
        let store = tempStore()
        defer { store.removeAll() }
        let first = ResourceCache(store: store)
        let other = ResourceKey(user: "u1", path: "/api/receipts/r1")
        let _: Box = try await first.load(key, version: 4, persist: true) { body(42) }
        let _: Box = try await first.load(other, version: 4) { body(1) }
        await first.flushWrites()

        let next = ResourceCache(store: store)
        let hit = try #require(await next.cached(key, version: 0, as: Box.self))
        #expect(hit.value == Box(n: 42))
        #expect(hit.isFresh == false)
        // Only the lists marked `persist` are written.
        #expect(await next.cached(other, version: 0, as: Box.self) == nil)
        // The restored answer is shown, then replaced by the server's.
        let fresh: Box = try await next.load(key, version: 0, persist: true) { body(43) }
        #expect(fresh == Box(n: 43))
    }

    @Test func anotherAccountNeverReadsTheFile() async throws {
        let store = tempStore()
        defer { store.removeAll() }
        let cache = ResourceCache(store: store)
        let _: Box = try await cache.load(key, version: 0, persist: true) { body(1) }
        await cache.flushWrites()
        #expect(store.read(user: "u2").isEmpty)
        #expect(store.read(user: "u1").count == 1)
        // A file name that differs from the account id is never written outside the folder.
        #expect(store.fileURL(user: "../../etc").deletingLastPathComponent().path == store.directory.path)
        #expect(store.fileURL(user: "../../etc").lastPathComponent == "etc.json")
    }

    @Test func signOutRemovesTheFiles() async throws {
        let store = tempStore()
        let cache = ResourceCache(store: store)
        let _: Box = try await cache.load(key, version: 0, persist: true) { body(1) }
        await cache.flushWrites()
        await cache.clear()
        await cache.flushWrites()
        #expect(FileManager.default.fileExists(atPath: store.directory.path) == false)
        let next = ResourceCache(store: store)
        #expect(await next.cached(key, version: 0, as: Box.self) == nil)
    }

    @Test func theFileKeepsTheNewestEntriesOnly() throws {
        let store = tempStore()
        defer { store.removeAll() }
        var entries: [String: ResourceEntry] = [:]
        for i in 0..<(ResourceDiskStore.maxEntries + 4) {
            entries["u1|/api/x?i=\(i)"] = ResourceEntry(data: body(i), dataVersion: 0, fetchedAt: Date(timeIntervalSince1970: Double(i)))
        }
        entries["u1|/api/big?"] = ResourceEntry(data: Data(count: ResourceDiskStore.maxEntryBytes + 1), dataVersion: 0,
                                               fetchedAt: Date(timeIntervalSince1970: 1_000))
        try store.write(user: "u1", entries: entries)
        let read = store.read(user: "u1")
        #expect(read.count == ResourceDiskStore.maxEntries)
        #expect(read["u1|/api/big?"] == nil)
        #expect(read["u1|/api/x?i=0"] == nil)
        #expect(read["u1|/api/x?i=\(ResourceDiskStore.maxEntries + 3)"]?.data == body(ResourceDiskStore.maxEntries + 3))
    }
}

// MARK: Kuitit pages

private func receiptJSON(_ id: String) -> String {
    #"{"id":"\#(id)","vendor":"K-Market","date":"2026-10-12","category":null,"type":"meno","totalAmount":12.5}"#
}

private func list(_ ids: [String], extra: String = "") -> ReceiptList {
    let rows = ids.map(receiptJSON).joined(separator: ",")
    return try! JSONDecoder().decode(ReceiptList.self, from: Data(#"{"receipts":[\#(rows)]\#(extra)}"#.utf8))
}

@Suite struct ReceiptPagingTests {
    @Test func narrowRowsWithoutTimestampsStillRead() {
        let page = list(["a", "b"], extra: #","nextCursor":"c2""#)
        #expect(page.receipts.map(\.id) == ["a", "b"])
        #expect(page.receipts[0].createdAt == "")
        #expect(page.nextCursor == "c2")
        #expect(page.count == nil)
    }

    @Test func theOldShapeAndOtherNamesRead() {
        let old = list(["a"], extra: #","count":250,"truncated":true"#)
        #expect(old.count == 250)
        #expect(old.truncated == true)
        #expect(old.nextCursor == nil)
        let named = list(["a"], extra: #","total":12,"hasMore":false,"nextCursor":"" "#)
        #expect(named.count == 12)
        #expect(named.truncated == false)
        #expect(named.nextCursor == nil)
    }

    @Test func theFirstPageAsksForFiftyByCursor() {
        let q = ReceiptListPaging.firstQuery(ReceiptListQuery())
        #expect(q["cursor"] == "")
        #expect(q["limit"] == "50")
        #expect(q["sort"] == "date_desc")
        #expect(q["kind"] == "receipt")
        #expect(ReceiptListPaging.firstQuery(ReceiptListQuery(), loadedRows: 120)["limit"] == "120")
    }

    @Test func anotherSortKeepsTheOffsetPages() {
        // A paging server answers 400 to `cursor` with any sort but date_desc.
        var byAmount = ReceiptListQuery()
        byAmount.sort = .amountDesc
        let q = ReceiptListPaging.firstQuery(byAmount)
        #expect(q["cursor"] == nil)
        #expect(q["limit"] == nil)
        #expect(q["sort"] == "amount_desc")
        var paging = ReceiptListPaging()
        paging.firstPage(list(["a"], extra: #","truncated":true"#))
        #expect(paging.nextQuery(byAmount, loaded: 200)?["offset"] == "200")
    }

    @Test func aPagingServerIsFollowedByCursor() {
        var paging = ReceiptListPaging()
        let query = ReceiptListQuery()
        paging.firstPage(list(["a"], extra: #","nextCursor":"c2","truncated":true"#))
        #expect(paging.hasMore)
        let next = paging.nextQuery(query, loaded: 1)
        #expect(next?["cursor"] == "c2")
        #expect(next?["offset"] == nil)
        paging.nextPage(list(["b"]))
        #expect(paging.hasMore == false)
        #expect(paging.nextQuery(query, loaded: 2) == nil)
    }

    @Test func anOlderServerIsFollowedByOffset() {
        var paging = ReceiptListPaging()
        let query = ReceiptListQuery()
        paging.firstPage(list(["a"], extra: #","truncated":true"#))
        #expect(paging.hasMore)
        #expect(paging.nextQuery(query, loaded: 200)?["offset"] == "200")
        #expect(paging.nextQuery(query, loaded: 200)?["cursor"] == nil)
        paging.nextPage(list(["b"], extra: #","truncated":false"#))
        #expect(paging.hasMore == false)
    }

    @Test func pagesMergeWithoutShowingARowTwice() {
        let merged = ReceiptPaging.append(list(["a", "b"]).receipts, list(["b", "c"]).receipts)
        #expect(merged.map(\.id) == ["a", "b", "c"])
    }

    @Test func theHeaderCountFallsBackToTheTabCount() throws {
        let counts = try JSONDecoder().decode(ReceiptCounts.self, from: Data(#"{"counts":{"all":9,"tulo":2,"meno":7,"linked":3,"unlinked":6}}"#.utf8)).counts
        #expect(ReceiptListPaging.total(list(["a"], extra: #","count":4"#), tab: .all, counts: counts) == 4)
        #expect(ReceiptListPaging.total(list(["a"]), tab: .meno, counts: counts) == 7)
        // No Laskut count from this server: the rows are the count.
        #expect(ReceiptListPaging.total(list(["a"]), tab: .laskut, counts: counts) == 1)
        #expect(ReceiptListPaging.total(list(["a", "b"]), tab: .all, counts: nil) == 2)
    }

    @Test func aRowsWordsAreMadeOnce() {
        let text = ReceiptRowText(list(["a"]).receipts[0])
        #expect(text.title == "K-Market")
        #expect(text.detail == "12.10.2026")
        #expect(text.amount == Decimal(string: "12.5"))
        #expect(text.isIncome == false)
        #expect(text.linked == false)
    }
}

// MARK: Launch

@Suite struct LaunchPrefetchTests {
    @Test func theLaunchAsksForWhatTheFirstScreensShowWithTheirOwnQueries() {
        let requests = LaunchPrefetch.requests(month: "2026-10", kuititFilter: "tab=meno&sort=amount_desc")
        #expect(requests.first == PrefetchRequest(path: "/api/dashboard", query: ["month": "2026-10"]))
        var kuitit = ReceiptListQuery()
        kuitit.tab = .meno
        kuitit.sort = .amountDesc
        #expect(requests.contains(PrefetchRequest(path: "/api/receipts", query: ReceiptListPaging.firstQuery(kuitit))))
        #expect(requests.contains(PrefetchRequest(path: "/api/receipts/counts", query: kuitit.countsQuery())))
        #expect(requests.contains(PrefetchRequest(path: "/api/receipts", query: ["reviewStatus": "pending", "kind": "receipt"])))
        #expect(requests.contains(PrefetchRequest(path: "/api/receipts", query: ["reviewStatus": "rejected"])))
        #expect(requests.contains(PrefetchRequest(path: "/api/invoices", query: [:])))
        #expect(requests.contains(PrefetchRequest(path: "/api/invoices/counts", query: [:], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/reports/profit-loss", query: ["from": "2026-01", "to": "2026-12"], persist: false)))
        #expect(requests.contains(PrefetchRequest(path: "/api/bank-accounts")))
        #expect(requests.last == PrefetchRequest(path: "/api/statements"))
    }

    @Test func bootstrapCountsStandOnlyForTheDefaultScope() {
        #expect(LaunchPrefetch.countsRequest(kuititFilter: "")?.query == ["kind": "receipt"])
        // A tab or a sort does not change what is counted; a month does.
        #expect(LaunchPrefetch.countsRequest(kuititFilter: "tab=meno") != nil)
        #expect(LaunchPrefetch.countsRequest(kuititFilter: "month=2026-09") == nil)
    }

    @Test func countsBytesReadBackAsTheCountsAnswer() throws {
        let counts = try JSONDecoder().decode(ReceiptCounts.self, from: Data(#"{"counts":{"all":9,"tulo":2,"meno":7,"linked":3,"unlinked":6,"laskut":1}}"#.utf8)).counts
        let back = try JSONDecoder().decode(ReceiptCounts.self, from: ReceiptCounts.answer(counts)).counts
        #expect(back.all == 9)
        #expect(back.meno == 7)
        #expect(back.laskut == 1)
    }

    @Test func bootstrapReadsEveryShapeLeniently() throws {
        let nested = try JSONDecoder().decode(AppBootstrap.self, from: Data(#"""
        {"user":{"userId":"u1","email":"a@b.fi","firstName":null},"version":{"dataVersion":12},"counts":{"receipts":{"all":3,"tulo":1,"meno":2,"linked":0,"unlinked":3}}}
        """#.utf8))
        #expect(nested.user?.userId == "u1")
        #expect(nested.version?.dataVersion == "12")
        #expect(nested.receiptCounts?.all == 3)

        let flat = try JSONDecoder().decode(AppBootstrap.self, from: Data(#"{"dataVersion":"7","receiptCounts":{"all":1,"tulo":0,"meno":1,"linked":1,"unlinked":0}}"#.utf8))
        #expect(flat.user == nil)
        #expect(flat.version?.dataVersion == "7")
        #expect(flat.receiptCounts?.linked == 1)

        let odd = try JSONDecoder().decode(AppBootstrap.self, from: Data(#"{"user":"x","counts":[1,2],"version":true}"#.utf8))
        #expect(odd.user == nil)
        #expect(odd.version == nil)
        #expect(odd.receiptCounts == nil)
    }
}
