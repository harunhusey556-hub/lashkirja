import Testing
import Foundation
import Observation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func row(_ id: String, status: String = "unmatched", suggested: String? = nil, receipt: String? = nil, statement: String = "s1") -> String {
    let suggestedJSON = suggested.map { "\"\($0)\"" } ?? "null"
    let receiptJSON = receipt.map { "\"\($0)\"" } ?? "null"
    return #"{"id":"\#(id)","statementId":"\#(statement)","date":"2026-10-0\#(id.count)","type":"meno","amount":-10,"matchStatus":"\#(status)","suggestedReceiptId":\#(suggestedJSON),"receiptId":\#(receiptJSON)}"#
}

private func statement(_ id: String, rows: [String]) throws -> Statement {
    try decode(StatementResponse.self, #"{"statement":{"id":"\#(id)","fileName":"f.csv","periodMonth":"2026-10","uploadedAt":"2026-10-01T00:00:00Z","transactions":[\#(rows.joined(separator: ","))]}}"#).statement
}

private final class ObservedFlag: @unchecked Sendable { var value = false }

// MARK: Version store

@Suite struct DataVersionStateTests {
    private let base = SyncVersion(dataVersion: "7", accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T08:00:00Z", balanceCents: 10_000)],
                                   receiptsChangedAt: "r1", invoicesChangedAt: "i1")

    @Test func aBumpRaisesTheVersionAndEveryArea() {
        var state = DataVersionState()
        state.bump()
        #expect(state.version == 1)
        #expect(DataArea.allCases.allSatisfy { state.version(of: $0) == 1 })
        state.bump([.bank])
        #expect(state.version == 2)
        #expect(state.version(of: .bank) == 2)
        #expect(state.version(of: .receipts) == 1)
    }

    @Test func theFirstServerAnswerIsOnlyTheBaseline() {
        var state = DataVersionState()
        let changed1 = state.apply(base)
        #expect(changed1.isEmpty)
        #expect(state.version == 0)
        #expect(state.server == base)
        // The same answer again changes nothing.
        let changed2 = state.apply(base)
        #expect(changed2.isEmpty)
        #expect(state.version == 0)
    }

    @Test func aNewSyncTimeOrBalanceBumpsOnlyTheBank() {
        var state = DataVersionState()
        state.apply(base)
        let synced = SyncVersion(dataVersion: "8", accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T09:00:00Z", balanceCents: 12_500)],
                                 receiptsChangedAt: "r1", invoicesChangedAt: "i1")
        let changed3 = state.apply(synced)
        #expect(changed3 == Set([DataArea.bank]))
        #expect(state.version == 1)
        #expect(state.version(of: .bank) == 1)
        #expect(state.version(of: .receipts) == 0)
    }

    @Test func aNumberThatMovedWithoutAnAreaBumpsEverything() {
        var state = DataVersionState()
        state.apply(SyncVersion(dataVersion: "1"))
        let changed4 = state.apply(SyncVersion(dataVersion: "2"))
        #expect(changed4 == DataArea.all)
        #expect(state.version == 1)
    }

    @Test func aMissingFieldIsUnknownNotAChange() {
        var state = DataVersionState()
        state.apply(base)
        let changed5 = state.apply(SyncVersion())
        #expect(changed5.isEmpty)
        #expect(state.version == 0)
        // The baseline keeps what the answer left out, so the next real change is still seen.
        #expect(state.server == base)
        let synced = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T09:00:00Z", balanceCents: 10_000)])
        let changed6 = state.apply(synced)
        #expect(changed6 == Set([DataArea.bank]))
    }

    @Test func anAbsorbedAnswerMovesTheBaselineWithoutABump() {
        var state = DataVersionState()
        state.apply(base)
        let after = SyncVersion(dataVersion: "9", receiptsChangedAt: "r2")
        let changed7 = state.apply(after, absorb: true)
        #expect(changed7.isEmpty)
        #expect(state.version == 0)
        // The next poll compares with the absorbed answer: nothing new.
        let changed8 = state.apply(after)
        #expect(changed8.isEmpty)
    }

    @Test func aWriteAnswersNumberBecomesTheBaseline() {
        var state = DataVersionState()
        state.absorb(dataVersion: "41")
        #expect(state.server?.dataVersion == "41")
        let changed9 = state.apply(SyncVersion(dataVersion: "41"))
        #expect(changed9.isEmpty)
        let changed10 = state.apply(SyncVersion(dataVersion: "42"))
        #expect(changed10 == DataArea.all)
    }

    @Test func signingOutForgetsTheServerButNotTheVersion() {
        var state = DataVersionState()
        state.apply(base)
        state.bump()
        state.forgetServer()
        #expect(state.server == nil)
        #expect(state.version == 1)
    }

    @MainActor @Test func theStoreTellsObserversOnABump() {
        let store = DataVersionStore()
        let told = ObservedFlag()
        withObservationTracking { _ = store.version } onChange: { told.value = true }
        store.bump()
        #expect(told.value)
        #expect(store.version == 1)
    }

    @MainActor @Test func theStoreTellsObserversWhenTheServerMoved() {
        let store = DataVersionStore()
        store.apply(SyncVersion(dataVersion: "1"))
        let told = ObservedFlag()
        withObservationTracking { _ = store.version } onChange: { told.value = true }
        store.apply(SyncVersion(dataVersion: "2"))
        #expect(told.value)
    }

    @MainActor @Test func theStoreStaysQuietForTheSameAnswer() {
        let store = DataVersionStore()
        store.apply(SyncVersion(dataVersion: "1"))
        let told = ObservedFlag()
        withObservationTracking { _ = store.version } onChange: { told.value = true }
        store.apply(SyncVersion(dataVersion: "1"))
        #expect(!told.value)
        #expect(store.version == 0)
    }
}

@Suite struct SyncVersionDecodingTests {
    @Test func readsTheServerShape() throws {
        let v = try decode(SyncVersion.self, #"""
        {"dataVersion":12,"bank":{"accounts":[{"id":"a1","lastSyncAt":"2026-10-12T08:00:00.000Z","balanceCents":153250}]},
         "receipts":{"lastChangeAt":"2026-10-12T07:00:00Z"},"invoices":{"lastChangeAt":null}}
        """#)
        #expect(v.dataVersion == "12")
        #expect(v.accounts == [SyncVersion.Account(id: "a1", lastSyncAt: "2026-10-12T08:00:00.000Z", balanceCents: 153_250)])
        #expect(v.receiptsChangedAt == "2026-10-12T07:00:00Z")
        #expect(v.invoicesChangedAt == nil)
    }

    @Test func readsW18sAccountIdsAndTheBankChangeTime() throws {
        let v = try decode(SyncVersion.self, #"""
        {"dataVersion":3,"bank":{"lastChangeAt":"2026-10-12T08:00:00.000Z","accounts":[
          {"bankAccountId":"ba1","connectedAccountId":"ca1","name":"Käyttötili","iban":"FI00","currency":"EUR","lastSyncAt":"2026-10-12T08:00:00.000Z","balanceCents":100,"balanceAt":null},
          {"bankAccountId":null,"connectedAccountId":"ca2","name":"Säästö","iban":"FI01","currency":"EUR","lastSyncAt":null,"balanceCents":null,"balanceAt":null}]},
         "receipts":{"lastChangeAt":null},"invoices":{"lastChangeAt":null}}
        """#)
        #expect(v.accounts.map(\.id) == ["ba1", "ca2"])
        #expect(v.bankChangedAt == "2026-10-12T08:00:00.000Z")
        var state = DataVersionState()
        state.apply(v)
        // Only the bank's change time moved (a statement import without a balance): the bank reloads.
        let moved = SyncVersion(dataVersion: "3", accounts: v.accounts, bankChangedAt: "2026-10-12T09:00:00.000Z")
        let changed = state.apply(moved)
        #expect(changed == Set([DataArea.bank]))
    }

    @Test func oddOrMissingFieldsNeverFailTheDecode() throws {
        let v = try decode(SyncVersion.self, #"{"dataVersion":"x7","bank":{"accounts":[42,{"lastSyncAt":"t"},{"id":"a2","balanceCents":"900"}]},"receipts":"r9"}"#)
        #expect(v.dataVersion == "x7")
        #expect(v.accounts == [SyncVersion.Account(id: "a2", lastSyncAt: nil, balanceCents: 900)])
        #expect(v.receiptsChangedAt == "r9")
        let empty = try decode(SyncVersion.self, "{}")
        #expect(empty == SyncVersion())
    }
}

@Suite struct SyncWaitTests {
    private let started = Date(timeIntervalSince1970: 1_800_000_000)
    private let before = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T08:00:00Z")])

    @Test func freshOnceTheSyncTimeMoves() {
        let after = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T08:05:00Z")])
        #expect(SyncWait.check(before: before, now: after, started: started, at: started.addingTimeInterval(4)) == .fresh)
    }

    @Test func waitsWhileNothingMovedThenGivesUpAfterAMinute() {
        #expect(SyncWait.check(before: before, now: before, started: started, at: started.addingTimeInterval(10)) == .waiting)
        #expect(SyncWait.check(before: before, now: nil, started: started, at: started.addingTimeInterval(59)) == .waiting)
        #expect(SyncWait.check(before: before, now: before, started: started, at: started.addingTimeInterval(60)) == .timedOut)
    }

    @Test func onlyTheAccountsOfTheSyncCount() {
        let other = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T08:00:00Z"), .init(id: "b1", lastSyncAt: "2026-10-12T09:00:00Z")])
        #expect(SyncWait.check(before: before, now: other, accountIds: ["a1"], started: started, at: started) == .waiting)
        #expect(SyncWait.check(before: before, now: other, started: started, at: started) == .fresh)
    }

    @Test func withoutABaselineASyncTimeAfterTheStartCounts() {
        let start = SyncWait.date("2026-10-12T08:00:00Z")!
        let old = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T07:59:00Z")])
        let new = SyncVersion(accounts: [.init(id: "a1", lastSyncAt: "2026-10-12T08:00:01.250Z")])
        #expect(SyncWait.check(before: nil, now: old, started: start, at: start) == .waiting)
        #expect(SyncWait.check(before: nil, now: new, started: start, at: start) == .fresh)
    }
}

@Suite struct FreshBalancesTests {
    @Test func freshBalancesReplaceTheShownOnesAndTheTotal() {
        var fresh = FreshBalances()
        fresh.take(["a1": 1532.5], at: Date(timeIntervalSince1970: 100))
        #expect(fresh.balance("a1", shown: 1000) == 1532.5)
        #expect(fresh.balance("a2", shown: 40) == 40)
        let lines: [(id: String, balance: Decimal?)] = [(id: "a1", balance: 1000), (id: "a2", balance: 40)]
        let total = fresh.total(1040, lines: lines)
        #expect(total == Decimal(string: "1572.5"))
    }

    @Test func onlyALoadStartedAfterTheSyncLetsThemGo() {
        var fresh = FreshBalances()
        fresh.take(["a1": 5], at: Date(timeIntervalSince1970: 100))
        fresh.settle(loadStartedAt: Date(timeIntervalSince1970: 99))
        #expect(!fresh.isEmpty)
        fresh.settle(loadStartedAt: Date(timeIntervalSince1970: 101))
        #expect(fresh.isEmpty)
    }

    @Test func theSyncAnswerCarriesBalancesAndTheVersion() throws {
        let result = try decode(BankSyncResult.self, #"""
        {"ok":true,"imported":3,"skipped":0,"dataVersion":44,
         "accounts":[{"accountId":"c1","bankAccountId":"a1","balanceCents":153250},{"accountId":"c2","ok":false}],
         "balances":[{"id":"a2","balanceCents":-1200}],
         "bank":{"lastChangeAt":null,"accounts":[{"bankAccountId":null,"connectedAccountId":"ca9","balanceCents":5000}]}}
        """#)
        #expect(result.imported == 3)
        #expect(result.dataVersion == "44")
        #expect(result.balances == ["a1": Decimal(string: "1532.5")!, "a2": -12, "ca9": 50])
        #expect(!result.isPending)
        let queued = try decode(BankSyncResult.self, #"{"jobId":"j1","status":"queued"}"#)
        #expect(queued.isPending)
        let plain = try decode(BankSyncResult.self, #"{"imported":0,"skipped":0}"#)
        #expect(plain.balances.isEmpty && plain.dataVersion == nil && !plain.isPending)
    }
}

// MARK: Cursor paging

@Suite struct CursorPagingTests {
    @Test func theCursorLeadsPageByPageAndNeverLoops() {
        var paging = CursorPaging()
        paging.firstPage(next: "c2")
        #expect(paging.hasMore)
        #expect(paging.nextQuery(["month": "2026-10"]) == ["month": "2026-10", "cursor": "c2"])
        paging.nextPage(next: "c3")
        #expect(paging.nextQuery() == ["cursor": "c3"])
        // A server that hands an earlier cursor back ends the paging instead of looping.
        paging.nextPage(next: "c2")
        #expect(!paging.hasMore)
        #expect(paging.nextQuery() == nil)
    }

    @Test func theSameCursorTwiceEndsThePaging() {
        var paging = CursorPaging()
        paging.firstPage(next: "c2")
        paging.nextPage(next: "c2")
        #expect(!paging.hasMore)
    }

    @Test func noCursorMeansTheWholeList() {
        var paging = CursorPaging()
        paging.firstPage(next: nil)
        #expect(!paging.hasMore)
        paging.firstPage(next: "")
        #expect(!paging.hasMore)
        #expect(paging.nextQuery() == nil)
    }

    @Test func aRefreshStartsThePagingOver() {
        var paging = CursorPaging()
        paging.firstPage(next: "c2")
        paging.nextPage(next: nil)
        paging.firstPage(next: "c2")
        #expect(paging.nextQuery() == ["cursor": "c2"])
    }

    @Test func mergingPagesNeverShowsARowTwice() throws {
        let first = [try statement("s1", rows: [row("t1"), row("t2")])]
        // The next page repeats t2 (it moved between pages), adds t3 to s1 and starts s2.
        let page = [try statement("s1", rows: [row("t2"), row("t3")]), try statement("s2", rows: [row("t4", statement: "s2"), row("t1")])]
        let merged = StatementPaging.merge(first, page)
        #expect(merged.map(\.id) == ["s1", "s2"])
        #expect(merged[0].transactions.map(\.id) == ["t1", "t2", "t3"])
        #expect(merged[1].transactions.map(\.id) == ["t4"])
        let ids = merged.flatMap { $0.transactions.map(\.id) }
        #expect(ids.count == Set(ids).count)
    }

    @Test func theFirstPageAsksForPagesAndKeepsWhatWasLoaded() {
        #expect(CursorPaging.firstQuery(["month": "2026-10"]) == ["month": "2026-10", "cursor": "", "limit": "50"])
        #expect(CursorPaging.firstQuery(loadedRows: 130) == ["cursor": "", "limit": "130"])
        #expect(CursorPaging.firstQuery(loadedRows: 900) == ["cursor": "", "limit": "200"])
    }

    @Test func aPageOfFeedRowsReadsAsStatements() throws {
        let page = try decode(StatementList.self, #"""
        {"transactions":[
          {"id":"t3","statementId":"s2","date":"2026-10-03","type":"meno","amount":-1,"matchStatus":"unmatched","periodMonth":"2026-10","bankAccountId":"ba1"},
          {"id":"t2","statementId":"s1","date":"2026-09-30","type":"meno","amount":-2,"matchStatus":"unmatched","periodMonth":"2026-09","bankAccountId":null},
          {"id":"t1","statementId":"s2","date":"2026-10-01","type":"tulo","amount":5,"matchStatus":"unmatched","periodMonth":"2026-10","bankAccountId":"ba1"}],
         "nextCursor":"abc","total":120}
        """#)
        #expect(page.nextCursor == "abc")
        #expect(page.statements.map(\.id) == ["s2", "s1"])
        #expect(page.statements[0].transactions.map(\.id) == ["t3", "t1"])
        #expect(page.statements[0].periodMonth == "2026-10")
        #expect(page.statements[0].bankAccount?.id == "ba1")
        #expect(page.statements[1].bankAccount == nil)
        // The feed groups them by month like whole statements.
        #expect(BankFeed.months(page.statements).map(\.month).contains("2026-09"))
    }

    @Test func theListReadsItsCursorLeniently() throws {
        let paged = try decode(StatementList.self, #"{"statements":[],"nextCursor":"abc"}"#)
        #expect(paged.nextCursor == "abc")
        let whole = try decode(StatementList.self, #"{"statements":[]}"#)
        #expect(whole.nextCursor == nil)
        let odd = try decode(StatementList.self, #"{"statements":[],"nextCursor":12}"#)
        #expect(odd.nextCursor == nil)
    }
}

// MARK: Bulk selection and the batch bodies

@Suite struct BulkSelectionTests {
    @Test func pickingWorksOnlyInTheMode() {
        var selection = BulkSelection()
        selection.toggle("a")
        #expect(selection.isEmpty)
        selection.begin()
        selection.toggle("a")
        selection.toggle("b")
        selection.toggle("a")
        #expect(selection.ids == ["b"])
        selection.end()
        #expect(!selection.isActive && selection.isEmpty)
    }

    @Test func selectAllCoversTheRowsOnScreenAndTogglesBack() {
        var selection = BulkSelection()
        selection.begin()
        selection.toggleAll(["a", "b", "c"])
        #expect(selection.allSelected(["a", "b", "c"]))
        #expect(selection.ordered(["c", "x", "a", "b"]) == ["c", "a", "b"])
        selection.toggleAll(["a", "b", "c"])
        #expect(selection.isEmpty)
        #expect(!selection.allSelected([]))
    }

    @Test func hiddenRowsDropOutAndFailuresStayPicked() {
        var selection = BulkSelection()
        selection.begin()
        selection.toggleAll(["a", "b", "c"])
        selection.keepVisible(["a", "c"])
        #expect(selection.ids == ["a", "c"])
        selection.finish(failed: ["c"])
        #expect(selection.isActive && selection.ids == ["c"])
        selection.finish(failed: [])
        #expect(!selection.isActive)
    }

    @Test func batchesFitTheRouteLimits() {
        let ids = (0..<120).map { String($0) }
        let chunks = BulkBatch.chunks(ids, size: BulkBatch.deleteLimit)
        #expect(chunks.map(\.count) == [50, 50, 20])
        #expect(chunks.flatMap { $0 } == ids)
        #expect(BulkBatch.chunks([String](), size: 50).isEmpty)
        #expect(BulkBatch.outcome("Poistettiin", done: 3, failures: []) == "Poistettiin 3.")
        #expect(BulkBatch.outcome("Poistettiin", done: 2, failures: ["", "Kuukausi on suljettu."]) == "Poistettiin 2, epäonnistui 2: Kuukausi on suljettu.")
    }

    @Test func receiptBodiesAndCopyMirrorTheWeb() throws {
        #expect(try encodedObject(ReceiptIdsBody(receiptIds: ["r1", "r2"]))["receiptIds"] as? [String] == ["r1", "r2"])
        #expect(ReceiptBulk.approveLabel(ready: 3, notReady: 0) == "Hyväksy (3)")
        #expect(ReceiptBulk.approveLabel(ready: 3, notReady: 2) == "Hyväksy valmiit (3)")
        #expect(ReceiptBulk.deleteTitle(12) == "Poistetaanko 12 kuittia?")
        #expect(ReceiptBulk.deleteTitle(1) == "Poistetaanko kuitti?")
        let pending = try decode(Receipt.self, #"{"id":"p","createdAt":"a","updatedAt":"b","reviewStatus":"pending","vendor":"K","totalAmount":5}"#)
        let gap = try decode(Receipt.self, #"{"id":"g","createdAt":"a","updatedAt":"b","reviewStatus":"pending","vendor":"K"}"#)
        let approved = try decode(Receipt.self, #"{"id":"a","createdAt":"a","updatedAt":"b","reviewStatus":"approved","vendor":"K","totalAmount":5}"#)
        #expect(ReceiptBulk.approvable([pending, gap, approved]).map(\.id) == ["p"])
    }

    @Test func bankBulkTakesOnlyTheRowsEachActionAppliesTo() throws {
        let rows = try [row("t1", status: "suggested", suggested: "r1"), row("t2"), row("t3", status: "confirmed", receipt: "r3"), row("t4", status: "ignored")]
            .map { try decode(BankTransaction.self, $0) }
        let pairs = BankBulk.pairs(rows)
        #expect(pairs == [BulkMatchPairsBody.Pair(transactionId: "t1", receiptId: "r1")])
        let body = try encodedObject(BulkMatchPairsBody(pairs: pairs))
        let sent = try #require(body["pairs"] as? [[String: String]])
        #expect(sent == [["transactionId": "t1", "receiptId": "r1"]])
        #expect(BankBulk.rejections(rows) == [BulkRejectBody(transactionId: "t1", receiptId: "r1")])
        #expect(BankBulk.ignorable(rows).map(\.id) == ["t1", "t2"])
        let ignore = try encodedObject(BulkIgnoreBody(transactionId: "t2"))
        #expect(ignore["transactionId"] as? String == "t2" && ignore["ignored"] as? Bool == true)
        let result = try decode(BulkMatchConfirmResult.self, #"{"ok":true,"confirmed":2,"skipped":1,"alreadyConfirmed":0,"skippedPairs":[]}"#)
        #expect(result.confirmed == 2 && result.skipped == 1)
    }

    @Test func purchaseBulkCopy() {
        #expect(PurchaseBulk.markPaidTitle(3) == "Merkitäänkö 3 ostolaskua maksetuksi?")
        #expect(PurchaseBulk.deleteTitle(1) == "Poistetaanko ostolasku?")
    }
}
