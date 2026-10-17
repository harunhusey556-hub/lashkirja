import Testing
import Foundation
@testable import LashKirjaCore

// Owner 2026-10-15: one tap links every sure kohdistus in "Ei kohdistettu", one "Kumoa" takes it back.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct SureMatchTests {
    @Test func theListAndTheBatchDecodeTheServerShape() throws {
        let list = try decode(SureMatchList.self, #"{"count":2,"pairs":[{"transactionId":"t1","receiptId":"r1","vendor":"Tukku Oy","amount":124,"score":0.99,"reasons":["viite täsmää"]},{"transactionId":"t2","receiptId":"r2","vendor":null,"amount":null,"score":0.9,"reasons":[]}]}"#)
        #expect(list.count == 2)
        #expect(list.pairs.map(\.id) == ["t1", "t2"])
        #expect(list.pairs[0].amount == 124)
        let batch = try decode(SureMatchBatch.self, #"{"batchId":"b1","linked":[{"transactionId":"t1","receiptId":"r1","vendor":"Tukku Oy","amount":124}]}"#)
        #expect(batch.batchId == "b1")
        #expect(batch.linked.count == 1)
        let none = try decode(SureMatchBatch.self, #"{"batchId":null,"linked":[]}"#)
        #expect(none.batchId == nil)
        #expect(try decode(SureMatchUndone.self, #"{"restored":1}"#).restored == 1)
        #expect(batch.stoppedEarly == false)
    }

    // Ultrareview PR #31: a run that stops early (time up or a failed chunk) still answers with its batch.
    @Test func aRunThatStoppedEarlyKeepsItsBatchAndSaysSo() throws {
        let batch = try decode(SureMatchBatch.self, #"{"batchId":"b1","linked":[{"transactionId":"t1","receiptId":"r1"}],"partial":true,"remaining":70,"failed":true,"error":"SURE_MATCH_CHUNK_FAILED"}"#)
        #expect(batch.batchId == "b1")
        #expect(batch.stoppedEarly)
        #expect(batch.remaining == 70)
        #expect(SureMatchText.linkedPartly(50) == "50 kohdistettu, loput seuraavalla kerralla.")
    }

    @Test func aListWithoutACountCountsItsPairs() throws {
        let list = try decode(SureMatchList.self, #"{"pairs":[{"transactionId":"t1","receiptId":"r1"}]}"#)
        #expect(list.count == 1)
    }

    @Test func theWordsAreFinnish() {
        #expect(SureMatchText.buttonTitle(3) == "Kohdista varmat (3)")
        #expect(SureMatchText.linked(1) == "1 kuitti kohdistettu.")
        #expect(SureMatchText.linked(4) == "4 kuittia kohdistettu.")
        #expect(SureMatchText.restored(2) == "2 kohdistusta kumottu.")
    }

    @Test func theSettingIsSentOnlyWhenItChanged() throws {
        let old = try decode(Profile.self, #"{"email":"a@b.fi","entityType":"oy","vatRegistered":true,"autoLinkSureMatches":false}"#)
        var new = old
        new.autoLinkSureMatches = true
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProfilePatch(from: old, to: new))) as? [String: Any]
        #expect(body?["autoLinkSureMatches"] as? Bool == true)
        #expect(ProfilePatch(from: old, to: old).isEmpty)
        // An older server sends no setting: it reads as nil and nothing is sent for it.
        let older = try decode(Profile.self, #"{"email":"a@b.fi","entityType":"oy","vatRegistered":true}"#)
        #expect(older.autoLinkSureMatches == nil)
    }
}
