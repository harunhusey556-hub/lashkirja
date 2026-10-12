import Testing
import Foundation
@testable import LashKirjaCore

private func reading(_ json: String) throws -> Extracted {
    try JSONDecoder().decode(Extracted.self, from: Data(json.utf8))
}

/// A complete reading; each test spoils one thing.
private let completeFields = #""vendor":"K-Market","date":"2026-10-03","totalAmount":12.9,"type":"meno","confidence":0.9"#

// MARK: The rule (web lib/auto-accept.ts autoAcceptBlock)

@Suite struct AutoAcceptRuleTests {
    @Test func aCompleteConfidentReadingIsAccepted() throws {
        let r = try reading("{\(completeFields)}")
        #expect(AutoAccept.block(r) == nil)
        #expect(AutoAccept.isComplete(r))
    }

    @Test func noReadingIsNeverComplete() {
        #expect(!AutoAccept.isComplete(nil))
    }

    @Test func aMissingOrZeroAmountWaits() throws {
        #expect(AutoAccept.block(try reading(#"{"vendor":"K-Market","date":"2026-10-03","confidence":0.9}"#)) == .amount)
        #expect(AutoAccept.block(try reading(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":0,"confidence":0.9}"#)) == .amount)
        #expect(AutoAccept.block(try reading(#"{"vendor":"K-Market","date":"2026-10-03","totalAmount":-5,"confidence":0.9}"#)) == .amount)
    }

    @Test func aSumUnderHalfACentIsZeroAndAHalfCentIsOne() throws {
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":0.004,"confidence":0.9}"#)) == .amount)
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":0.01,"confidence":0.9}"#)) == nil)
    }

    @Test func aMissingOrBlankVendorWaits() throws {
        #expect(AutoAccept.block(try reading(#"{"date":"2026-10-03","totalAmount":12.9,"confidence":0.9}"#)) == .vendor)
        #expect(AutoAccept.block(try reading(#"{"vendor":"   ","date":"2026-10-03","totalAmount":12.9,"confidence":0.9}"#)) == .vendor)
    }

    @Test func aMissingDateWaits() throws {
        #expect(AutoAccept.block(try reading(#"{"vendor":"K-Market","totalAmount":12.9,"confidence":0.9}"#)) == .date)
        #expect(AutoAccept.block(try reading(#"{"vendor":"K-Market","date":"","totalAmount":12.9,"confidence":0.9}"#)) == .date)
    }

    @Test func aFlyerOrOtherDocumentWaitsButAReceiptAndABillDoNot() throws {
        #expect(AutoAccept.block(try reading("{\(completeFields),\"documentType\":\"marketing\"}")) == .notAReceipt)
        #expect(AutoAccept.block(try reading("{\(completeFields),\"documentType\":\"other\"}")) == .notAReceipt)
        #expect(AutoAccept.block(try reading("{\(completeFields),\"documentType\":\"receipt\"}")) == nil)
        #expect(AutoAccept.block(try reading("{\(completeFields),\"documentType\":\"invoice\"}")) == nil)
    }

    @Test func overallConfidenceBelowTheFloorWaits() throws {
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":9,"confidence":0.54}"#)) == .lowConfidence)
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":9,"confidence":0.55}"#)) == nil)
        #expect(AutoAccept.confidenceFloor == 0.55)
    }

    @Test func noScoreAtAllIsNotConfident() throws {
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":9}"#)) == .lowConfidence)
        #expect(AutoAccept.block(try reading(#"{"vendor":"A","date":"2026-10-03","totalAmount":9,"confidence":null}"#)) == .lowConfidence)
    }

    @Test func anyUncertainFieldWaitsEvenWhenTheOverallScoreIsHigh() throws {
        let weak = try reading("{\(completeFields),\"fieldConfidence\":{\"vendor\":0.9,\"date\":0.4,\"totalAmount\":0.95}}")
        #expect(AutoAccept.block(weak) == .lowConfidence)
        let fine = try reading("{\(completeFields),\"fieldConfidence\":{\"vendor\":0.9,\"date\":null,\"totalAmount\":0.95}}")
        #expect(AutoAccept.block(fine) == nil)
    }

    @Test func anUnreadableOrManualReadingWaitsFirst() throws {
        #expect(AutoAccept.block(try reading("{\(completeFields),\"unreadable\":true}")) == .unreadable)
        #expect(AutoAccept.block(try reading("{\(completeFields),\"source\":\"manual\"}")) == .unreadable)
        #expect(AutoAccept.block(try reading("{\(completeFields),\"source\":\"ai\"}")) == nil)
    }

    @Test func aKnownDuplicateWaits() throws {
        #expect(AutoAccept.block(try reading("{\(completeFields)}"), duplicate: true) == .duplicate)
    }
}

// MARK: Which way a finished upload goes (web takesAutoSavePath)

@Suite struct AutoSavePathTests {
    @Test func aPickOfSeveralSavesEveryReadingEvenAnIncompleteOne() throws {
        let incomplete = try reading(#"{"vendor":"K-Market"}"#)
        #expect(AutoAccept.takesAutoSavePath(several: true, reading: incomplete))
        #expect(AutoAccept.takesAutoSavePath(several: true, reading: nil))
    }

    @Test func aSingleFileSavesOnlyWhenComplete() throws {
        #expect(AutoAccept.takesAutoSavePath(several: false, reading: try reading("{\(completeFields)}")))
        #expect(!AutoAccept.takesAutoSavePath(several: false, reading: try reading(#"{"vendor":"K-Market"}"#)))
        #expect(!AutoAccept.takesAutoSavePath(several: false, reading: nil))
    }
}

// MARK: Decoding what the rule reads, and the save answer

@Suite struct AutoAcceptDecodingTests {
    @Test func theRuleFieldsAreReadFromTheServersReading() throws {
        let r = try reading(#"{"vendor":"A","confidence":0.8,"source":"ai","documentType":"receipt","fieldConfidence":{"vendor":0.9,"date":0.7,"totalAmount":0.6}}"#)
        #expect(r.confidence == 0.8)
        #expect(r.source == "ai")
        #expect(r.documentType == "receipt")
        #expect(r.fieldConfidence?.vendor == 0.9)
        #expect(r.fieldConfidence?.date == 0.7)
        #expect(r.fieldConfidence?.totalAmount == 0.6)
    }

    @Test func aReadingWithoutThemStillDecodes() throws {
        let r = try reading(#"{"vendor":"K-Market","totalAmount":12.9}"#)
        #expect(r.confidence == nil)
        #expect(r.fieldConfidence == nil)
        #expect(r.documentType == nil)
    }

    @Test func theSaveAnswerCarriesTheApproval() throws {
        let approved = try JSONDecoder().decode(ReceiptSaveResult.self, from: Data(#"{"ok":true,"receipt":{"id":"r1","vendor":"A"},"autoApproved":true,"fx":null}"#.utf8))
        #expect(approved.receipt.id == "r1")
        #expect(approved.approved)
        let pending = try JSONDecoder().decode(ReceiptSaveResult.self, from: Data(#"{"ok":true,"receipt":{"id":"r2"},"autoApproved":false}"#.utf8))
        #expect(!pending.approved)
        let old = try JSONDecoder().decode(ReceiptSaveResult.self, from: Data(#"{"ok":true,"receipt":{"id":"r3"}}"#.utf8))
        #expect(!old.approved)
    }
}
