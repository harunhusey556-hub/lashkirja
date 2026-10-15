import Testing
import Foundation
@testable import LashKirjaCore

/// A credit note (hyvityslasku): the server's reading says so with `isCreditNote`, and a saved
/// one has a negative total. The app names it "Hyvityslasku" and never approves it blind.
@Suite struct CreditNoteTests {
    private func reading(_ json: String) throws -> Extracted {
        try JSONDecoder().decode(Extracted.self, from: Data(json.utf8))
    }

    private func receipt(_ json: String) throws -> Receipt {
        try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
    }

    private let completeFields = #""vendor":"Tukku Oy","date":"2026-08-15","totalAmount":125.5,"type":"meno","confidence":0.9,"documentType":"invoice""#

    @Test func aCreditNoteReadingDecodesAndIsNamed() throws {
        let r = try reading("{\(completeFields),\"isCreditNote\":true,\"creditsInvoiceNumber\":\"1234\"}")
        #expect(r.isCreditNote == true)
        #expect(r.creditsInvoiceNumber == "1234")
        #expect(r.creditNoteLabel == "Hyvityslasku")
        // The reading keeps the positive size the form shows; the server books it negative.
        #expect(r.totalAmount == Decimal(string: "125.5"))
    }

    @Test func aCreditNoteReadingWaitsForTheOwner() throws {
        let ordinary = try reading("{\(completeFields)}")
        let credit = try reading("{\(completeFields),\"isCreditNote\":true}")
        #expect(AutoAccept.block(ordinary) == nil)
        #expect(AutoAccept.block(credit) == .creditNote)
        #expect(!AutoAccept.takesAutoSavePath(several: false, reading: credit))
    }

    @Test func anOlderReadingWithoutTheFlagIsNoCreditNote() throws {
        let r = try reading("{\(completeFields)}")
        #expect(r.isCreditNote == nil)
        #expect(r.creditNoteLabel == nil)
    }

    @Test func aSavedReceiptWithANegativeTotalIsACreditNote() throws {
        let credit = try receipt(#"{"id":"r1","vendor":"Tukku Oy","totalAmount":-125.5,"vatDetails":"[{\"rate\":25.5,\"amount\":-25.5}]"}"#)
        #expect(credit.isCreditNote)
        #expect(credit.creditNoteLabel == "Hyvityslasku")
        #expect(credit.totalAmount == Decimal(string: "-125.5"))
        #expect(credit.vatDetails?.first?.amount == Decimal(string: "-25.5"))

        let ordinary = try receipt(#"{"id":"r2","vendor":"K-Market","totalAmount":12.4}"#)
        #expect(!ordinary.isCreditNote)
        #expect(ordinary.creditNoteLabel == nil)
        #expect(try receipt(#"{"id":"r3"}"#).creditNoteLabel == nil)
    }
}
