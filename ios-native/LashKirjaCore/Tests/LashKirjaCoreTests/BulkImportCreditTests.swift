import Testing
import Foundation
@testable import LashKirjaCore

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

// MARK: Bulk upload: bounded concurrency and the summary line

@Suite struct BulkUploadTests {
    private func makeQueue(_ count: Int) -> (ReceiptUploadQueue, [String]) {
        var queue = ReceiptUploadQueue()
        let ids = queue.enqueue((0..<count).map { ReceiptUploadQueue.Pick(name: "kuitti-\($0).jpg", size: 1) })
        return (queue, ids)
    }

    @Test func claimNextHandsOutAtMostThreeAtOnce() {
        var (queue, ids) = makeQueue(5)
        let claimed = (0..<5).compactMap { _ in queue.claimNext() }
        #expect(claimed.map(\.id) == Array(ids.prefix(3)))
        #expect(queue.uploadingCount == 3)
        #expect(queue.claimNext() == nil)
    }

    @Test func aFinishedUploadFreesASlot() {
        var (queue, ids) = makeQueue(4)
        for _ in 0..<3 { _ = queue.claimNext() }
        queue.markProcessing(ids[0])
        #expect(queue.claimNext()?.id == ids[3])
        #expect(queue.claimNext() == nil)
    }

    @Test func aRowIsNeverClaimedTwice() {
        var (queue, ids) = makeQueue(2)
        #expect(queue.claimNext()?.id == ids[0])
        #expect(queue.claimNext()?.id == ids[1])
        #expect(queue.claimNext() == nil)
    }

    @Test func cancelledAndFailedRowsAreNotClaimedUntilRetried() {
        var (queue, ids) = makeQueue(2)
        _ = queue.claimNext()
        queue.markFailed(ids[0], "Epäonnistui")
        _ = queue.claimNext()
        queue.cancelPending()
        #expect(queue.claimNext() == nil)
        queue.retryFailed()
        #expect(queue.claimNext()?.id == ids[0])
    }

    @Test func theLimitIsThreeAndThePageIsFifty() {
        #expect(ReceiptUploadQueue.uploadConcurrency == 3)
        #expect(ReceiptUploadQueue.listPage == 50)
        #expect(ReceiptUploadQueue.maxPick == 200)
        #expect(ShowMore(step: ReceiptUploadQueue.listPage).visible(120) == 50)
    }

    @Test func summaryNamesAutoApprovedAndWaitingAndFailed() {
        var (queue, ids) = makeQueue(5)
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1], autoApproved: true)
        queue.markSaved(ids[2], autoApproved: false)
        queue.markReady(ids[3], draft: ReceiptDraft(uploadId: "u"))
        queue.markFailed(ids[4], "Tiedosto on tyhjä")
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 2 · 2 odottaa tarkistusta · 1 epäonnistui")
    }

    @Test func summaryLeavesOutWhatIsZero() {
        var (queue, ids) = makeQueue(2)
        queue.markSaved(ids[0], autoApproved: true)
        queue.markSaved(ids[1], autoApproved: true)
        #expect(queue.summaryLine == "Hyväksyttiin automaattisesti 2")

        var (waiting, waitingIds) = makeQueue(1)
        waiting.markSaved(waitingIds[0])
        #expect(waiting.summaryLine == "1 odottaa tarkistusta")
    }

    @Test func summaryWaitsUntilTheUploadsAreThrough() {
        var (queue, ids) = makeQueue(2)
        queue.markSaved(ids[0], autoApproved: true)
        #expect(queue.summaryLine == nil)
        queue.markSaved(ids[1], autoApproved: true)
        #expect(queue.summaryLine != nil)
    }

    @Test func nothingSavedMeansNoSummary() {
        var (queue, ids) = makeQueue(1)
        queue.markFailed(ids[0], "Tiedosto on tyhjä")
        #expect(queue.summaryLine == nil)
    }

    @Test func markSavedKeepsOldCallersWorking() {
        var (queue, ids) = makeQueue(1)
        queue.markSaved(ids[0])
        #expect(queue.row(ids[0])?.status == .saved)
        #expect(queue.row(ids[0])?.autoApproved == false)
    }

    @Test func theSaveBodyAsksForAutoApprovalOnlyWhenTold() throws {
        var draft = ReceiptDraft(uploadId: "u1")
        #expect(try encodedObject(draft)["autoApprove"] == nil)
        draft.autoApprove = true
        #expect(try encodedObject(draft)["autoApprove"] as? Bool == true)
    }
}

// MARK: Delete dialogs name what goes

@Suite struct DeleteDialogNameTests {
    private func statement(_ extra: String) throws -> Statement {
        try decode(StatementResponse.self, #"""
        {"statement":{"id":"s1","fileName":"a.csv",\#(extra),"uploadedAt":"2026-10-01T00:00:00Z",
         "transactions":[],"totals":{"income":10,"expenses":-4,"transfers":0,"net":6,"txCount":2}}}
        """#).statement
    }

    @Test func statementDialogNamesBankAndMonth() throws {
        let s = try statement(#""fileType":"csv","periodMonth":"2026-09","bankAccount":{"id":"b","name":"Käyttötili","bankName":"Nordea","iban":null,"currency":"EUR"}"#)
        #expect(StatementText.deleteTitle(s) == "Poistetaanko tiliote · Nordea Syyskuu 2026?")
        #expect(StatementText.deleteName(s) == "Tiliote · Nordea Syyskuu 2026")
    }

    @Test func statementDialogFallsBackToTheAccountNameAndToThePlainQuestion() throws {
        let named = try statement(#""fileType":"csv","periodMonth":"2026-09","bankAccount":{"id":"b","name":"Käyttötili","bankName":null,"iban":null,"currency":"EUR"}"#)
        #expect(StatementText.deleteTitle(named) == "Poistetaanko tiliote · Käyttötili Syyskuu 2026?")
        let bare = try statement(#""fileType":"csv","periodMonth":null,"bankAccount":null"#)
        #expect(StatementText.deleteTitle(bare) == "Poistetaanko tiliote?")
        #expect(StatementText.deleteName(bare) == "Tiliote")
    }

    @Test func aBankConnectionStatementIsCalledPankkiyhteys() throws {
        let s = try statement(#""fileType":"enablebanking","periodMonth":"2026-09","bankAccount":null"#)
        #expect(StatementText.deleteTitle(s) == "Poistetaanko pankkiyhteys · Syyskuu 2026?")
    }
}

// MARK: Partial credit note (POST /api/invoices/{id}/credit, strict `lines` body)

@Suite struct InvoiceCreditTests {
    /// Two lines; the first (2 kpl) was credited 0,5 by an earlier note.
    private func invoice(creditNotes: String = #"[{"lines":[{"sortOrder":0,"quantity":0.5}]}]"#, sortOrders: Bool = true) throws -> Invoice {
        let order0 = sortOrders ? #","sortOrder":0"# : ""
        let order1 = sortOrders ? #","sortOrder":1"# : ""
        return try decode(InvoiceResponse.self, #"""
        {"invoice":{"id":"i1","number":7,"reference":"0074","status":"sent","displayStatus":"sent","issueDate":"2026-10-02","dueDate":"2026-10-16",
         "sentAt":null,"paidAt":null,"notes":null,"currency":"EUR","net":110,"vat":26.25,"gross":136.25,"paid":0,"open":136.25,"closedReason":null,
         "updatedAt":"2026-10-02T14:37:01.649Z","documentKind":"invoice","creditsInvoice":null,"creditNotes":\#(creditNotes),
         "customer":{"id":"c1","name":"Testi Oy","email":null,"businessId":null},
         "lines":[{"id":"l1","description":"Ripsienpidennys","quantity":2,"unit":"kpl","unitPrice":50,"vatRate":25.5,"net":100\#(order0)},
                  {"id":"l2","description":"Huolto","quantity":1,"unit":"h","unitPrice":10,"vatRate":14,"net":10\#(order1)}],
         "payments":[],"sends":[],"activity":[]}}
        """#).invoice
    }

    @Test func remainingIsWhatEarlierNotesLeft() throws {
        let remaining = InvoiceCredit.remaining(try invoice())
        #expect(remaining["l1"] == Decimal(string: "1.5"))
        #expect(remaining["l2"] == 1)
    }

    @Test func aServerWithoutSortOrderIsReadInLineOrder() throws {
        let remaining = InvoiceCredit.remaining(try invoice(sortOrders: false))
        #expect(remaining["l1"] == Decimal(string: "1.5"))
        #expect(remaining["l2"] == 1)
    }

    @Test func prefilledStartsEveryLineAtWhatIsLeft() throws {
        #expect(InvoiceCredit.prefilled(try invoice()) == ["l1": "1,5", "l2": "1"])
    }

    @Test func aFullyCreditedLineStartsEmpty() throws {
        let all = try invoice(creditNotes: #"[{"lines":[{"sortOrder":0,"quantity":2},{"sortOrder":1,"quantity":1}]}]"#)
        #expect(InvoiceCredit.prefilled(all).isEmpty)
        #expect(InvoiceCredit.remaining(all).values.allSatisfy { $0 == 0 })
    }

    @Test func noCreditNotesLeavesEverything() throws {
        let fresh = try invoice(creditNotes: "[]")
        #expect(InvoiceCredit.remaining(fresh)["l1"] == 2)
    }

    @Test func aPartIsSentAsLineQuantities() throws {
        let outcome = InvoiceCredit.body(invoice: try invoice(), quantities: ["l1": "1", "l2": ""])
        guard case .body(let body) = outcome else {
            Issue.record("expected a body, got \(outcome)")
            return
        }
        #expect(body.lines.map(\.lineId) == ["l1"])
        let object = try encodedObject(body)
        let lines = try #require(object["lines"] as? [[String: Any]])
        #expect(lines.count == 1)
        #expect(lines[0]["lineId"] as? String == "l1")
        #expect((lines[0]["quantity"] as? NSNumber)?.doubleValue == 1)
        // The server's body is strict: nothing but `lines`.
        #expect(Set(object.keys) == ["lines"])
    }

    @Test func aCommaDecimalIsAccepted() throws {
        let outcome = InvoiceCredit.body(invoice: try invoice(), quantities: ["l1": "0,5"])
        guard case .body(let body) = outcome else {
            Issue.record("expected a body, got \(outcome)")
            return
        }
        #expect(body.lines.first?.quantity == Decimal(string: "0.5"))
    }

    @Test func moreThanIsLeftIsRefusedWithTheServersWords() throws {
        let outcome = InvoiceCredit.body(invoice: try invoice(), quantities: ["l1": "2"])
        #expect(outcome == .invalid("Riviltä Ripsienpidennys on hyvitettävissä enää 1,5 kpl."))
    }

    @Test func nothingFilledInIsRefused() throws {
        #expect(InvoiceCredit.body(invoice: try invoice(), quantities: [:]) == .invalid("Valitse vähintään yksi rivi hyvitettäväksi."))
        #expect(InvoiceCredit.body(invoice: try invoice(), quantities: ["l1": "  "]) == .invalid("Valitse vähintään yksi rivi hyvitettäväksi."))
    }

    @Test func zeroNegativeJunkAndFourDecimalsAreRefused() throws {
        for text in ["0", "-1", "abc", "0,1234"] {
            let outcome = InvoiceCredit.body(invoice: try invoice(), quantities: ["l1": text])
            #expect(outcome == .invalid("Rivin määrä on virheellinen (enintään kolme desimaalia): Ripsienpidennys"), "\(text)")
        }
    }

    @Test func totalRoundsLikeTheWeb() throws {
        // 1 x 50,00 at 25,5 % = 62,75; 1 x 10,00 at 14 % = 11,40.
        let both = InvoiceCredit.total(invoice: try invoice(), quantities: ["l1": "1", "l2": "1"])
        #expect(both == Decimal(string: "74.15"))
        let one = InvoiceCredit.total(invoice: try invoice(), quantities: ["l1": "1"])
        #expect(one == Decimal(string: "62.75"))
    }

    @Test func totalIsNilWhileNothingValidIsTyped() throws {
        #expect(InvoiceCredit.total(invoice: try invoice(), quantities: [:]) == nil)
        #expect(InvoiceCredit.total(invoice: try invoice(), quantities: ["l1": "x"]) == nil)
    }

    @Test func quantityTextHasAtMostThreeDecimalsAndAComma() {
        #expect(InvoiceCredit.quantityText(Decimal(string: "1.5")!) == "1,5")
        #expect(InvoiceCredit.quantityText(2) == "2")
        #expect(InvoiceCredit.quantityText(Decimal(string: "0.3333")!) == "0,333")
    }
}
