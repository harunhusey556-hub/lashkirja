import Testing
import Foundation
@testable import LashKirjaCore

// N4 (owner, 2026-10-18, O1): the capture queue's row says one thing in its slot and something else,
// short, on the line under the name. Before, a file on its way said its step twice (M007), a read
// file said "Valmis" beside the "Valmis" button (U097), and a saved bill's line wrapped to two and
// moved the button under it (X051).

/// The line under the name repeats the slot's word, or starts with it.
private func repeats(_ row: UploadQueueRow?) -> Bool {
    guard let row, let detail = row.detailText else { return false }
    return detail.lowercased().hasPrefix(row.slotText.lowercased())
}

@Suite struct UploadQueueRowTextTests {
    private let billNote = "ostolasku luotu, eräpäivä 1.11.2026"

    private func one() -> ReceiptUploadQueue {
        var queue = ReceiptUploadQueue()
        queue.enqueue([.init(name: "testikuitti.jpg", size: 1000)])
        return queue
    }

    @Test func aFileOnItsWaySaysItsStepOnce() {
        var queue = one()
        let id = queue.rows[0].id
        #expect(queue.row(id)?.slotText == "Jonossa")
        #expect(queue.row(id)?.detailText == nil)
        queue.markUploading(id)
        #expect(queue.row(id)?.slotText == "Lähetetään")
        #expect(queue.row(id)?.detailText == nil)
        queue.markProcessing(id)
        #expect(queue.row(id)?.slotText == "Käsitellään")
        #expect(queue.row(id)?.detailText == nil)
        queue.markReady(id, draft: ReceiptDraft(uploadId: "u1"))
        #expect(queue.row(id)?.slotText == "Odottaa tarkistusta")
        #expect(queue.row(id)?.detailText == nil)
        // The web's word for the step stays (ReceiptsParityTests.statusLabels).
        #expect(queue.row(id)?.status.label == "Valmis")
    }

    @Test func aBillSavedByHandSaysWhatItBecame() {
        var queue = one()
        let id = queue.rows[0].id
        queue.markReady(id, draft: ReceiptDraft(uploadId: "u1"))
        queue.markSaved(id, autoApproved: true, invoiceNote: billNote, receiptId: "r1", kind: .invoice, byHand: true)
        let row = queue.row(id)
        #expect(row?.slotText == "Tallennettu")
        #expect(row?.detailText == "Ostolasku · eräpäivä 1.11.2026")
        #expect(row?.savedByHand == true)
        #expect(!repeats(row))
    }

    @Test func theKindChangeSaysTheNewKind() {
        var queue = one()
        let id = queue.rows[0].id
        queue.markSaved(id, autoApproved: true, invoiceNote: billNote, receiptId: "r1", kind: .invoice, byHand: true)
        queue.markKind(id, kind: .receipt, invoiceNote: nil)
        #expect(queue.row(id)?.detailText == "Kuitti")
        queue.markKind(id, kind: .invoice, invoiceNote: "ostolasku luotu, eräpäivä 24.10.2026")
        #expect(queue.row(id)?.detailText == "Ostolasku · eräpäivä 24.10.2026")
        queue.markKind(id, kind: .invoice, invoiceNote: "ostolasku luotu")
        #expect(queue.row(id)?.detailText == "Ostolasku")
        #expect(queue.row(id)?.slotText == "Tallennettu")
    }

    @Test func aSavedRowSaysOnlyWhatStillWaitsForTheOwner() {
        func saved(_ approved: Bool?, duplicate: Bool = false, note: String? = nil, kind: ReceiptDocumentKind? = .receipt) -> String? {
            var queue = one()
            let id = queue.rows[0].id
            queue.markSaved(id, autoApproved: approved, duplicate: duplicate, invoiceNote: note, receiptId: "r1", kind: kind)
            return queue.row(id)?.detailText
        }
        #expect(saved(true) == "Kuitti")
        #expect(saved(false) == "Kuitti · odottaa tarkistusta")
        #expect(saved(false, note: billNote, kind: .invoice) == "Ostolasku · odottaa tarkistusta")
        #expect(saved(false, duplicate: true) == "Kuitti · samanlainen on jo tallennettu")
        #expect(saved(nil) == "Kuitti")
        #expect(saved(nil, duplicate: true) == "Kuitti · samanlainen on jo tallennettu")
        #expect(saved(true, note: "ostolaskua ei luotu, sama lasku on jo ostolaskuissa") == "Kuitti · sama lasku on jo ostolaskuissa")
        // A sale has no kind to name; a credit note names itself.
        #expect(saved(true, kind: nil) == nil)
        #expect(saved(false, kind: nil) == "Odottaa tarkistusta")
        #expect(saved(true, note: "hyvityslasku luotu", kind: nil) == "Hyvityslasku luotu")
        // The approval is the summary's to say, so no row calls a save automatic.
        #expect(saved(true, note: billNote, kind: .invoice)?.contains("automaattisesti") == false)
    }

    @Test func everySavedLineFitsOneCaptionLine() {
        // X051: "Hyväksytty automaattisesti · ostolasku luotu, eräpäivä 1.11.2026" (64 characters)
        // wrapped to two caption lines at 402 pt; 50 fit on one with room to spare.
        let documents: [(ReceiptDocumentKind?, String?)] = [
            (.invoice, "ostolasku luotu, eräpäivä 31.12.2026"), (.invoice, "ostolasku luotu"),
            (.receipt, nil), (.receipt, "ostolaskua ei luotu, sama lasku on jo ostolaskuissa"),
            (nil, "hyvityslasku luotu"), (nil, nil),
        ]
        for (kind, note) in documents {
            for approved in [true, false, nil] as [Bool?] {
                for duplicate in [false, true] {
                    for byHand in [false, true] {
                        var queue = one()
                        let id = queue.rows[0].id
                        queue.markSaved(id, autoApproved: approved, duplicate: duplicate, invoiceNote: note, receiptId: "r1", kind: kind, byHand: byHand)
                        let row = queue.row(id)
                        let detail = row?.detailText ?? ""
                        #expect(detail.count <= 50, "\(detail)")
                        #expect(!detail.contains("automaattisesti"), "\(detail)")
                        #expect(!repeats(row), "\(detail)")
                    }
                }
            }
        }
    }

    @Test func noStepOfTheQueueRepeatsTheSlot() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue((0..<6).map { ReceiptUploadQueue.Pick(name: "kuitti-\($0).jpg", size: 1000) })
        var seen: [UploadQueueRow] = queue.rows
        for id in ids { queue.markUploading(id) }
        seen += queue.rows
        for id in ids { queue.markProcessing(id) }
        seen += queue.rows
        queue.markReady(ids[0], draft: ReceiptDraft(uploadId: "u0"))
        for id in ids.dropFirst() { queue.markSaveQueued(id, draft: ReceiptDraft(uploadId: "u-\(id)")) }
        seen += queue.rows
        while queue.claimNextSave() != nil {}
        seen += queue.rows
        queue.markSaved(ids[1], autoApproved: true, invoiceNote: billNote, receiptId: "r1", kind: .invoice)
        queue.markSaved(ids[2], autoApproved: false, duplicate: true, receiptId: "r2", kind: .receipt)
        queue.markFailed(ids[3], "Kuittia ei voitu tallentaa.")
        seen += queue.rows
        while queue.claimNextSave() != nil {}
        queue.markSaved(ids[4], autoApproved: nil, invoiceNote: "hyvityslasku luotu")
        queue.markBackground(ids[5])
        seen += queue.rows
        queue.markSaved(ids[0], autoApproved: true, invoiceNote: billNote, receiptId: "r0", kind: .invoice, byHand: true)
        queue.markKind(ids[1], kind: .receipt, invoiceNote: nil)
        queue.retryFailed()
        seen += queue.rows
        queue.cancelPending()
        queue.markOffline(ids[5])
        seen += queue.rows
        let repeating = seen.filter { repeats($0) }.map { "\($0.slotText) / \($0.detailText ?? "")" }
        #expect(repeating.isEmpty, "\(repeating)")
    }

    @Test func aHandSaveIsNotCountedAsAutomatic() {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue([.init(name: "a.jpg", size: 1), .init(name: "b.jpg", size: 1), .init(name: "c.jpg", size: 1)])
        queue.markSaved(ids[0], autoApproved: true, byHand: true)
        queue.markSaved(ids[1], autoApproved: true)
        queue.markReady(ids[2], draft: ReceiptDraft(uploadId: "u2"))
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 1 · Tallennettiin 1 · 1 odottaa tarkistusta")
        #expect(queue.reviewCount == 0)
        // Saved by hand and left for review by the server: it waits, as any other.
        queue.markSaved(ids[0], autoApproved: false, byHand: true)
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 1 · 2 odottaa tarkistusta")
        #expect(queue.reviewCount == 1)
    }
}
