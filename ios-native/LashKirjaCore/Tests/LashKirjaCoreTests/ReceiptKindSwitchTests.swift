import Testing
import Foundation
@testable import LashKirjaCore

// Owner, 2026-10-15: one "Lisää tiedosto" button; the AI decides kuitti or ostolasku, and the
// upload screen's row turns a wrong decision around in one tap (POST /api/receipts/[id]/kind).

private func decodeChange(_ json: String) throws -> ReceiptKindChange {
    try JSONDecoder().decode(ReceiptKindChange.self, from: Data(json.utf8))
}

private func decodeSave(_ json: String) throws -> ReceiptSaveResult {
    try JSONDecoder().decode(ReceiptSaveResult.self, from: Data(json.utf8))
}

@Suite struct ReceiptKindSwitchTests {
    @Test func theBodyCarriesOnlyTheKind() throws {
        #expect(String(decoding: try JSONEncoder().encode(ReceiptKindBody(.invoice)), as: UTF8.self) == #"{"kind":"invoice"}"#)
        #expect(String(decoding: try JSONEncoder().encode(ReceiptKindBody(.receipt)), as: UTF8.self) == #"{"kind":"receipt"}"#)
    }

    @Test func aFiledOstolaskuMakesTheRowAnOstolaskuWithItsDueDate() throws {
        let change = try decodeChange(#"{"ok":true,"kind":"invoice","purchaseInvoiceAction":"filed","purchaseInvoiceSkipped":null,"purchaseInvoice":{"id":"p1","dueDate":"2026-03-12","isCreditNote":false}}"#)
        #expect(change.kind == .invoice)
        #expect(change.invoiceNote == "ostolasku luotu, eräpäivä 12.3.2026")
        #expect(change.message(asked: .invoice) == "Muutettu ostolaskuksi")
    }

    @Test func aRemovedOstolaskuLeavesAKuitti() throws {
        let change = try decodeChange(#"{"ok":true,"kind":"receipt","purchaseInvoiceAction":"removed","purchaseInvoiceSkipped":null,"purchaseInvoice":null}"#)
        #expect(change.kind == .receipt)
        #expect(change.invoiceNote == nil)
        #expect(change.message(asked: .receipt) == "Muutettu kuitiksi, ostolasku poistettiin")
        let repeated = try decodeChange(#"{"ok":true,"kind":"receipt","purchaseInvoiceAction":"none","purchaseInvoice":null}"#)
        #expect(repeated.message(asked: .receipt) == "Muutettu kuitiksi")
    }

    @Test func aRefusedFilingSaysWhyAndStaysAKuitti() throws {
        let change = try decodeChange(#"{"ok":true,"kind":"invoice","purchaseInvoiceAction":"none","purchaseInvoiceSkipped":"no_supplier","purchaseInvoice":null}"#)
        #expect(change.kind == .receipt)
        #expect(change.message(asked: .invoice) == "Lisää myyjä ja tallenna, niin ostolasku voidaan luoda.")
        let unknown = try decodeChange(#"{"purchaseInvoiceSkipped":"something_new"}"#)
        #expect(unknown.message(asked: .invoice) == "Ostolaskua ei voitu luoda.")
    }

    @Test func theSwitchIsNamedForWhatItDoes() {
        #expect(ReceiptDocumentKind.receipt.title == "Kuitti")
        #expect(ReceiptDocumentKind.invoice.title == "Ostolasku")
        #expect(ReceiptDocumentKind.receipt.other == .invoice)
        #expect(ReceiptDocumentKind.invoice.other == .receipt)
        #expect(ReceiptDocumentKind.receipt.switchTitle == "Muuta ostolaskuksi")
        #expect(ReceiptDocumentKind.invoice.switchTitle == "Muuta kuitiksi")
    }

    @Test func theSaveTellsWhatTheAIMadeOfTheDocument() throws {
        #expect(try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":{"id":"p1","dueDate":"2026-10-14"}}"#).filedKind == .invoice)
        #expect(try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":null,"purchaseInvoiceSkipped":"not_an_invoice"}"#).filedKind == .receipt)
        // A credit note is no payable to switch.
        #expect(try decodeSave(#"{"receipt":{"id":"r1"},"purchaseInvoice":{"id":"p1","isCreditNote":true}}"#).filedKind == nil)
    }

    @Test func theSaveOutcomeCarriesTheKindButNotForASale() async throws {
        let filed = ReceiptSaveResult(receipt: .init(id: "r1"), autoApproved: true, purchaseInvoice: .init(id: "p1", dueDate: "2026-10-14"))
        var draft = ReceiptDraft(uploadId: "u1")
        draft.vendor = "Sähkö Oy"
        draft.totalAmount = 120
        let bill = try await ReceiptSaving.save(draft, support: .supported, saveDuplicateAnyway: true) { _ in filed }
        #expect(bill.kind == .invoice)
        #expect(bill.receiptId == "r1")
        draft.type = "tulo"
        let sale = try await ReceiptSaving.save(draft, support: .supported, saveDuplicateAnyway: true) { _ in
            ReceiptSaveResult(receipt: .init(id: "r2"), autoApproved: true)
        }
        #expect(sale.kind == nil)
    }

    @Test func onlyASavedRowWithAReceiptOffersTheSwitch() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "lasku.pdf", size: 1000)])[0]
        #expect(queue.row(id)?.canSwitchKind == false)
        queue.markSaved(id, autoApproved: true, invoiceNote: "ostolasku luotu", receiptId: "r1", kind: .invoice)
        #expect(queue.row(id)?.canSwitchKind == true)
        #expect(queue.row(id)?.receiptId == "r1")

        let linked = queue.enqueue([.init(name: "kuitti.jpg", size: 1000)])[0]
        queue.markSaved(linked, autoApproved: true)
        #expect(queue.row(linked)?.canSwitchKind == false)
    }

    @Test func aSwitchedRowSaysWhatItIsNow() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "lasku.pdf", size: 1000)])[0]
        queue.markSaved(id, autoApproved: true, invoiceNote: "ostolasku luotu, eräpäivä 14.10.2026", receiptId: "r1", kind: .invoice)
        queue.markKind(id, kind: .receipt, invoiceNote: nil)
        #expect(queue.row(id)?.kind == .receipt)
        #expect(queue.row(id)?.outcomeText == "Hyväksytty automaattisesti")
        queue.markKind(id, kind: .invoice, invoiceNote: "ostolasku luotu, eräpäivä 24.10.2026")
        #expect(queue.row(id)?.outcomeText == "Hyväksytty automaattisesti · ostolasku luotu, eräpäivä 24.10.2026")
    }

    @Test func aRowNotSavedHasNoKindToChange() {
        var queue = ReceiptUploadQueue()
        let id = queue.enqueue([.init(name: "lasku.pdf", size: 1000)])[0]
        queue.markKind(id, kind: .invoice, invoiceNote: "ostolasku luotu")
        #expect(queue.row(id)?.kind == nil)
        #expect(queue.row(id)?.invoiceNote == nil)
    }
}
