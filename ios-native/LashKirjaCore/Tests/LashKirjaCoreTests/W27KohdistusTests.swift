import Testing
import Foundation
@testable import LashKirjaCore

// W27 (owner report 2026-10-12): the Kohdistus link, the "Kohdistettu" mark of a bill paid through its
// ostolasku, and the missing "no" to the look-alike question in the capture form.

@Test func kohdistusLinkOpensThePurchaseMatchScreen() {
    #expect(AppLink.parse("/kirjanpito/ostolaskut/kohdistus") == .purchaseMatch)
    // The list and one ostolasku keep their own routes.
    #expect(AppLink.parse("/kirjanpito/ostolaskut") == .purchaseInvoices)
    #expect(AppLink.parse("/kirjanpito/ostolaskut?id=p1") == .purchaseInvoice("p1"))
    #expect(ChatDestination.info(.purchaseMatch).title == "Kohdista ostolaskujen maksut")
    let card = ChatDestination.make(ChatSource(label: "", href: "/kirjanpito/ostolaskut/kohdistus", kind: nil))
    #expect(card?.link == .purchaseMatch)
}

@Test func aBillPaidThroughItsOstolaskuCountsAsMatched() throws {
    func receipt(_ extra: String) throws -> Receipt {
        try JSONDecoder().decode(Receipt.self, from: Data(#"{"id":"r1","createdAt":"a","updatedAt":"b"\#(extra)}"#.utf8))
    }
    // Linked to a bank row: as before.
    #expect(try receipt(#","linkedTransaction":{"id":"t1","amount":-195.02},"match":{"status":"linked"}"#).isBankMatched)
    // The list says "linked" for a bill whose ostolasku a bank row paid; it has no linked row of its own.
    #expect(try receipt(#","linkedTransaction":null,"match":{"status":"linked"}"#).isBankMatched)
    #expect(try !receipt(#","linkedTransaction":null,"match":{"status":"unlinked"}"#).isBankMatched)
    #expect(try !receipt(#","match":{"status":"suggested"}"#).isBankMatched)
    #expect(try !receipt("").isBankMatched)
    // A paged (narrow) row has no `match`, only the server's `matchStatus`, and its row text follows it.
    #expect(try receipt(#","matchStatus":"linked""#).isBankMatched)
    #expect(try !receipt(#","matchStatus":"suggested""#).isBankMatched)
    #expect(try ReceiptRowText(receipt(#","matchStatus":"linked""#)).linked)
}

@Test func skippingALookAlikeEndsItsRowWithoutKeepingIt() {
    var queue = ReceiptUploadQueue()
    let ids = queue.enqueue([.init(name: "lasku.pdf", size: 1000), .init(name: "toinen.pdf", size: 1000)])
    queue.markReady(ids[0], draft: ReceiptDraft(uploadId: "u1"))
    queue.markSaved(ids[1], autoApproved: true)
    #expect(queue.unfinishedCount == 1)
    #expect(queue.holdsWork)

    queue.markSkippedDuplicate(ids[0])
    let row = queue.row(ids[0])
    #expect(row?.status == .skipped)
    #expect(row?.status.label == "Ohitettu (kaksoiskappale)")
    #expect(row?.draft == nil)
    #expect(row?.canOpenForm == false)
    // No longer "Kesken", not written to the phone, and the screen may close.
    #expect(queue.unfinishedCount == 0)
    #expect(queue.unsavedReadings.isEmpty)
    #expect(!queue.holdsWork)
    #expect(queue.isFinished)
    #expect(queue.savedCount == 1)
    #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 1 · 1 ohitettu (kaksoiskappale)")
}

@Test func skipDeletesTheStagedUploadAndAFileAlreadyGoneIsTheSame() async throws {
    var asked: [String] = []
    try await ReceiptSaving.discardDuplicate(uploadId: "u-1") { path in asked.append(path) }
    #expect(asked == ["/api/receipts/staged/u-1"])
    #expect(ReceiptSaving.skipDuplicateTitle == "Älä tallenna")

    // Expired or dropped elsewhere: nothing to delete, the row is skipped all the same.
    try await ReceiptSaving.discardDuplicate(uploadId: "gone") { _ in
        throw LKError(status: 404, message: "Tiedostoa ei löytynyt")
    }
    // Anything else reaches the form, and the row keeps its reading.
    await #expect(throws: LKError.self) {
        try await ReceiptSaving.discardDuplicate(uploadId: "u-2") { _ in
            throw LKError(status: 0, code: "NETWORK", message: LKError.unreachable)
        }
    }
}
