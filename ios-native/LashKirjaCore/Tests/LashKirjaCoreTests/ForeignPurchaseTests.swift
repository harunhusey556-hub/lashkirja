import Testing
import Foundation
@testable import LashKirjaCore

@Test func receiptDecodesCurrencyAndTreatmentAndOldServersStayDomestic() throws {
    let new = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","totalAmount":9.06,"currency":"USD","originalAmount":10,"vatTreatment":"non_eu_service"}}"#
    let r = try JSONDecoder().decode(ReceiptResponse.self, from: Data(new.utf8)).receipt
    #expect(r.currency == "USD" && r.originalAmount == 10 && r.vatTreatment == .nonEuService)
    let old = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b"}}"#
    let o = try JSONDecoder().decode(ReceiptResponse.self, from: Data(old.utf8)).receipt
    #expect(o.currency == "EUR" && o.originalAmount == nil && o.vatTreatment == .domestic)
    let unknown = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","vatTreatment":"something_new"}}"#
    #expect(try JSONDecoder().decode(ReceiptResponse.self, from: Data(unknown.utf8)).receipt.vatTreatment == .domestic)
}

@Test func changingTheTreatmentOrCurrencyIsPatched() throws {
    let json = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","vendor":"OpenCode","date":"2026-09-18","totalAmount":9.06,"category":"ohjelmistot","vatDetails":[{"rate":0,"amount":0}]}}"#
    let receipt = try JSONDecoder().decode(ReceiptResponse.self, from: Data(json.utf8)).receipt
    let baseline = ReceiptForm(receipt: receipt)
    var form = baseline
    #expect(form.makePatch(baseline: baseline, expectedUpdatedAt: "b") == .unchanged)
    form.vatTreatment = .nonEuService
    form.currency = "usd"
    guard case .patch(let patch) = form.makePatch(baseline: baseline, expectedUpdatedAt: "b") else {
        Issue.record("expected a patch"); return
    }
    let body = String(decoding: try JSONEncoder().encode(patch), as: UTF8.self)
    #expect(body.contains(#""vatTreatment":"non_eu_service""#))
    #expect(body.contains(#""currency":"USD""#))
}

@Test func everyTreatmentHasFinnishWordsAndOnlyDomesticHasNoHint() {
    for treatment in PurchaseVatTreatment.allCases {
        #expect(!treatment.label.isEmpty)
        #expect(treatment.hint.isEmpty == (treatment == .domestic))
    }
}
