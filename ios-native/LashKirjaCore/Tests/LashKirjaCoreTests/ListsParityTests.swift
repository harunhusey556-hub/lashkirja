import Testing
import Foundation
@testable import LashKirjaCore

// W15: the Kuitit/Laskut split, the ostolasku notice, the foreign-rate line, the credit fields of the
// purchase models and the Kohdista ostolaskujen maksut screen.

private func listsDecode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

private func listsPurchase(
    id: String, status: String = "open", display: String = "open", due: String = "2026-09-15", extra: String = ""
) throws -> PurchaseInvoice {
    try listsDecode(PurchaseInvoice.self, """
    {"id":"\(id)","supplierName":"Tukku \(id)","invoiceNumber":null,"issueDate":"2026-09-01","dueDate":"\(due)",
     "status":"\(status)","displayStatus":"\(display)","gross":124,"vat":0,"net":124,"paid":0,"open":124,"payments":[]\(extra)}
    """)
}

private func listsSuggestion(invoiceId: String, score: Double?, transaction: String? = "t1") throws -> PurchaseMatchResult.Suggestion {
    let scoreJSON = score.map { ",\"score\":\($0)" } ?? ""
    let transactionJSON = transaction.map { "\"\($0)\"" } ?? "null"
    return try listsDecode(PurchaseMatchResult.Suggestion.self, """
    {"invoiceId":"\(invoiceId)","supplierName":"Tukku","invoiceNumber":"A-12","open":124,"transactionId":\(transactionJSON),
     "amount":124,"paidDate":"2026-01-25","counterparty":"Tukku Oy","reasons":["summa sama","nimi vastaa"]\(scoreJSON)}
    """)
}

// MARK: Kuitit / Laskut

@Test func laskutTabListsInvoicesAndEveryOtherTabListsReceipts() {
    var q = ReceiptListQuery()
    q.tab = .laskut
    q.month = "2026-10"
    // The Laskut chip swaps the kind and carries no type or linkedStatus; the counts stay on the kuitit.
    #expect(q.listQuery() == ["kind": "invoice", "month": "2026-10", "sort": "date_desc"])
    #expect(q.countsQuery() == ["kind": "receipt", "month": "2026-10"])
    q.tab = .linked
    #expect(q.listQuery()["kind"] == "receipt")
    #expect(q.listQuery(offset: 200)["offset"] == "200")
}

@Test func reviewQueueAndHubCountAskForReceiptsOnly() {
    #expect(ReceiptListQuery.pendingQueue() == ["reviewStatus": "pending", "kind": "receipt"])
    #expect(ReceiptListQuery.pendingQueue(offset: 50) == ["reviewStatus": "pending", "kind": "receipt", "offset": "50"])
    #expect(ReceiptListQuery.pendingCountQuery == ["reviewStatus": "pending", "kind": "receipt"])
}

@Test func laskutChipShowsItsCountAndOwnWords() throws {
    let counts = try listsDecode(ReceiptCounts.self, #"{"counts":{"all":5,"tulo":2,"meno":3,"linked":1,"unlinked":4,"laskut":7}}"#).counts
    #expect(ReceiptTab.laskut.count(in: counts) == 7)
    #expect(ReceiptTab.allCases.last == .laskut)
    #expect(ReceiptTab.laskut.title == "Laskut")
    var q = ReceiptListQuery()
    #expect(q.emptyText == "Ei kuitteja.")
    #expect(q.countHeader(12) == "12 kuittia")
    q.tab = .laskut
    #expect(q.emptyText == "Ei laskuja.")
    #expect(q.countHeader(1) == "1 lasku")
    #expect(q.countHeader(3) == "3 laskua")
    q.search = "kesko"
    #expect(q.emptyText == "Ei hakua vastaavia laskuja.")
    q.tab = .meno
    #expect(q.emptyText == "Ei hakua vastaavia kuitteja.")
}

@Test func laskutTabIsRememberedBetweenVisits() {
    var q = ReceiptListQuery()
    q.tab = .laskut
    #expect(ReceiptListQuery(remembered: q.remembered).tab == .laskut)
}

// MARK: Foreign rate line

@Test func receiptDecodesTheRateAndOldServersHaveNone() throws {
    let fx = #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","currency":"USD","originalAmount":10,"totalAmount":8.75,"fxRate":0.8749,"fxRateDate":"2026-07-10","fxSource":"ECB"}}"#
    let r = try listsDecode(ReceiptResponse.self, fx).receipt
    #expect(r.fxRate == 0.8749 && r.fxRateDate == "2026-07-10" && r.fxSource == "ECB")
    #expect(r.fxRateLine == "Kurssi 1 USD = 0,8749 EUR (EKP 10.7.2026)")
    let old = try listsDecode(ReceiptResponse.self, #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b"}}"#).receipt
    #expect(old.fxRate == nil && old.fxRateLine == nil)
    let odd = try listsDecode(ReceiptResponse.self, #"{"receipt":{"id":"r","createdAt":"a","updatedAt":"b","currency":"USD","fxRate":"x"}}"#).receipt
    #expect(odd.fxRate == nil && odd.fxRateLine == nil)
}

@Test func rateLineNamesTheSourceAndKeepsSmallRatesReadable() {
    #expect(ReceiptFx.line(currency: "USD", rate: 0.9123, date: "2026-07-12", source: "document") == "Kurssi 1 USD = 0,9123 EUR (laskulla 12.7.2026)")
    // Anything but the document's own rate is the ECB's.
    #expect(ReceiptFx.line(currency: "USD", rate: 0.9123, date: "2026-07-12", source: nil) == "Kurssi 1 USD = 0,9123 EUR (EKP 12.7.2026)")
    #expect(ReceiptFx.line(currency: "JPY", rate: 0.0062, date: "2026-07-10", source: "ECB") == "Kurssi 1 JPY = 0,0062 EUR (EKP 10.7.2026)")
    #expect(ReceiptFx.line(currency: "KRW", rate: 0.00063456, date: nil, source: "ECB") == "Kurssi 1 KRW = 0,000635 EUR (EKP)")
    #expect(ReceiptFx.line(currency: "GBP", rate: 1.15, date: "not a date", source: "ECB") == "Kurssi 1 GBP = 1,1500 EUR (EKP)")
}

@Test func noRateLineForEurosOrAnUnusableRate() {
    #expect(ReceiptFx.line(currency: "EUR", rate: 1, date: nil, source: "ECB") == nil)
    #expect(ReceiptFx.line(currency: nil, rate: 0.9, date: nil, source: nil) == nil)
    #expect(ReceiptFx.line(currency: "USD", rate: nil, date: nil, source: nil) == nil)
    #expect(ReceiptFx.line(currency: "USD", rate: 0, date: nil, source: nil) == nil)
    #expect(ReceiptFx.line(currency: "USD", rate: -1, date: nil, source: nil) == nil)
    #expect(ReceiptFx.line(currency: "USD", rate: 1e9, date: nil, source: nil) == nil)
    #expect(ReceiptFx.line(currency: "USD", rate: .infinity, date: nil, source: nil) == nil)
}

// MARK: Ostolasku notice

private func listsView(_ json: String) throws -> ReceiptPurchaseInvoiceView {
    try listsDecode(ReceiptPurchaseInvoiceView.self, json)
}

@Test func noticeSaysThisIsAnOstolaskuWithItsDueDate() throws {
    let open = try listsView(#"{"documentType":"invoice","purchaseInvoice":{"id":"pi1","status":"open","displayStatus":"open","dueDate":"2026-10-24","dueDateAssumed":true}}"#)
    #expect(ReceiptOstolaskuNotice.make(view: open, receiptType: "meno")
        == .filed(invoiceId: "pi1", headline: "Tämä on ostolasku · Eräpäivä 24.10.2026 (oletus)", canMarkAsReceipt: true))
    let printed = try listsView(#"{"documentType":"invoice","purchaseInvoice":{"id":"pi1","status":"open","displayStatus":"overdue","dueDate":"2026-10-24","dueDateAssumed":false}}"#)
    #expect(ReceiptOstolaskuNotice.make(view: printed, receiptType: "meno")
        == .filed(invoiceId: "pi1", headline: "Tämä on ostolasku · Eräpäivä 24.10.2026 · Myöhässä", canMarkAsReceipt: true))
    // Paid: nothing to take back (the server refuses once there are payments).
    let paid = try listsView(#"{"documentType":"invoice","purchaseInvoice":{"id":"pi1","status":"paid","displayStatus":"paid","dueDate":"2026-10-24","dueDateAssumed":false}}"#)
    #expect(ReceiptOstolaskuNotice.make(view: paid, receiptType: "meno")
        == .filed(invoiceId: "pi1", headline: "Tämä on ostolasku · Eräpäivä 24.10.2026 · Maksettu", canMarkAsReceipt: false))
}

@Test func noticeOffersToFileAnUnfiledReceiptAndExplainsACancelledOne() throws {
    let none = try listsView(#"{"documentType":null,"purchaseInvoice":null}"#)
    #expect(ReceiptOstolaskuNotice.make(view: none, receiptType: "meno") == .offer(text: "Onko tämä lasku, joka maksetaan myöhemmin?"))
    let cancelled = try listsView(#"{"documentType":"invoice","purchaseInvoice":{"id":"pi1","status":"cancelled","displayStatus":"cancelled","dueDate":"2026-10-24","dueDateAssumed":false}}"#)
    #expect(ReceiptOstolaskuNotice.make(view: cancelled, receiptType: "meno") == .offer(text: "Ostolasku on peruttu, tämä on kuitti."))
}

// X072: a credit note is not asked whether it is a bill to be paid later.
@Test func noticeOffersACreditNoteAsAnOstolaskusCredit() throws {
    let none = try listsView(#"{"documentType":null,"purchaseInvoice":null}"#)
    #expect(ReceiptOstolaskuNotice.make(view: none, receiptType: "meno", total: -50)
        == .offer(text: "Onko tämä ostolaskun hyvitys?", action: "Merkitse ostolaskun hyvitykseksi"))
    #expect(ReceiptOstolaskuNotice.make(view: none, receiptType: "meno", total: 50) == .offer(text: "Onko tämä lasku, joka maksetaan myöhemmin?"))
    #expect(ReceiptOstolaskuNotice.make(view: none, receiptType: "meno", total: 50) == .offer(text: "Onko tämä lasku, joka maksetaan myöhemmin?", action: "Merkitse ostolaskuksi"))
    let cancelled = try listsView(#"{"documentType":"invoice","purchaseInvoice":{"id":"pi1","status":"cancelled","displayStatus":"cancelled","dueDate":"2026-10-24","dueDateAssumed":false}}"#)
    #expect(ReceiptOstolaskuNotice.make(view: cancelled, receiptType: "meno", total: -50)
        == .offer(text: "Ostolasku on peruttu, tämä on kuitti.", action: "Merkitse ostolaskun hyvitykseksi"))
    let filed = try listsDecode(ReceiptDocumentKindResult.self, #"{"purchaseInvoiceAction":"filed","purchaseInvoiceSkipped":null}"#)
    #expect(filed.message(for: .invoice, credit: true) == "Tallennettu ostolaskun hyvitykseksi")
    #expect(filed.message(for: .receipt, credit: true) == "Merkitty kuitiksi, ostolasku peruttiin")
}

@Test func noticeStaysSilentUntilKnownAndForSales() throws {
    #expect(ReceiptOstolaskuNotice.make(view: nil, receiptType: "meno") == nil)
    let none = try listsView(#"{"documentType":null,"purchaseInvoice":null}"#)
    // A sales document is never an ostolasku.
    #expect(ReceiptOstolaskuNotice.make(view: none, receiptType: "tulo") == nil)
}

@Test func changingTheKindSendsOnlyTheDocumentType() throws {
    #expect(String(decoding: try JSONEncoder().encode(ReceiptDocumentKindBody(.receipt)), as: UTF8.self) == #"{"documentType":"receipt"}"#)
    #expect(String(decoding: try JSONEncoder().encode(ReceiptDocumentKindBody(.invoice)), as: UTF8.self) == #"{"documentType":"invoice"}"#)
}

@Test func kindChangeSaysWhatHappenedOrWhyNothingDid() throws {
    let filed = try listsDecode(ReceiptDocumentKindResult.self, #"{"ok":true,"receipt":{},"purchaseInvoiceAction":"filed","purchaseInvoiceSkipped":null}"#)
    #expect(filed.message(for: .invoice) == "Tallennettu ostolaskuksi")
    let cancelled = try listsDecode(ReceiptDocumentKindResult.self, #"{"purchaseInvoiceAction":"cancelled"}"#)
    #expect(cancelled.message(for: .receipt) == "Merkitty kuitiksi, ostolasku peruttiin")
    let skipped = try listsDecode(ReceiptDocumentKindResult.self, #"{"purchaseInvoiceAction":"none","purchaseInvoiceSkipped":"no_supplier"}"#)
    #expect(skipped.message(for: .invoice) == "Lisää myyjä ja tallenna, niin ostolasku voidaan luoda.")
    // A reason the app does not know falls back to the plain outcome rather than showing a code.
    let unknown = try listsDecode(ReceiptDocumentKindResult.self, #"{"purchaseInvoiceAction":"none","purchaseInvoiceSkipped":"something_new"}"#)
    #expect(unknown.message(for: .invoice) == "Tallennettu ostolaskuksi")
}

// MARK: Credit fields of the purchase models

@Test func purchaseDecodesTheCreditFieldsAndOldServersHaveNone() throws {
    let credited = try listsPurchase(
        id: "a", status: "credited", display: "credited",
        extra: #","credited":124,"isCreditNote":false,"creditsInvoiceId":null"#
    )
    #expect(credited.status == .credited && credited.displayStatus == .credited)
    #expect(credited.credited == 124 && !credited.isCreditNote && credited.creditsInvoiceId == nil)
    #expect(!credited.canReopen)

    let note = try listsPurchase(id: "b", status: "paid", display: "credited", extra: #","credited":0,"isCreditNote":true,"creditsInvoiceId":"a""#)
    #expect(note.isCreditNote && note.creditsInvoiceId == "a")
    #expect(!note.canReopen && !note.canLinkReceipt)

    let old = try listsPurchase(id: "c")
    #expect(old.credited == 0 && !old.isCreditNote && old.creditsInvoiceId == nil)
    #expect(PurchaseDisplayStatus.credited.label == "Hyvitetty")
    // A status the app does not know still reads as open.
    #expect(try listsPurchase(id: "d", status: "weird", display: "weird").displayStatus == .open)
}

@Test func creditedChipAppearsOnlyOnceSomethingIsCredited() throws {
    let counts = try listsDecode(PurchaseInvoiceCountsResponse.self, #"{"counts":{"open":2,"overdue":1,"paid":3,"credited":2,"cancelled":0}}"#).counts
    #expect(counts.credited == 2 && counts.total == 8)
    let chips = PurchaseFilter.chips(counts)
    #expect(chips.map(\.filter) == [.all, .overdue, .open, .paid, .credited])
    #expect(chips.last?.label == "Hyvitetyt" && chips.last?.count == 2)
    #expect(PurchaseFilter.credited.queryValue == "credited")
    // An older server sends no "credited": no chip, and the total is what it was.
    let older = try listsDecode(PurchaseInvoiceCountsResponse.self, #"{"counts":{"open":2,"overdue":1,"paid":3,"cancelled":0}}"#).counts
    #expect(older.credited == 0 && older.total == 6)
    #expect(PurchaseFilter.chips(older).map(\.filter) == [.all, .overdue, .open, .paid])
}

@Test func creditedInvoicesGroupAfterThePaidOnes() throws {
    let rows = [try listsPurchase(id: "a", status: "credited", display: "credited"), try listsPurchase(id: "b", status: "paid", display: "paid")]
    let all = PurchaseFilter.groups(rows, filter: .all)
    #expect(all.map(\.status) == [.paid, .credited])
    #expect(all.map(\.label) == ["Maksetut", "Hyvitetyt"])
    #expect(PurchaseFilter.groups(rows, filter: .credited).first?.items.map(\.id) == ["a"])
}

@Test func receiptLinkIsOfferedOnlyWhereItCanHelp() throws {
    #expect(try listsPurchase(id: "a").canLinkReceipt)
    #expect(try listsPurchase(id: "b", extra: #","receiptId":"r1""#).canLinkReceipt == false)
    #expect(try listsPurchase(id: "c", status: "cancelled", display: "cancelled").canLinkReceipt == false)
    let invoice = try listsPurchase(id: "d")
    #expect(PurchaseReceiptLinkText.title(invoice) == "Liitä kuitti · Tukku d")
    #expect(PurchaseReceiptLinkText.intro(invoice) == "124,00\u{00A0}€ · eräpäivä 15.9.2026. Liitä saman oston kuitti, niin ALV ei lasketa kahdesti.")
}

// MARK: Kohdista ostolaskujen maksut

@Test func matchRowsPutProposalsFirstThenByDueDate() throws {
    let invoices = [
        try listsPurchase(id: "late", display: "overdue", due: "2026-08-01"),
        try listsPurchase(id: "soon", due: "2026-09-10"),
        try listsPurchase(id: "later", due: "2026-09-30"),
        try listsPurchase(id: "paid", status: "paid", display: "paid"),
        try listsPurchase(id: "gone", status: "cancelled", display: "cancelled"),
        try listsPurchase(id: "note", status: "paid", display: "credited", extra: #","isCreditNote":true"#),
    ]
    let suggestions = [try listsSuggestion(invoiceId: "later", score: 0.9), try listsSuggestion(invoiceId: "soon", score: 0.7)]
    let rows = PurchaseMatch.rows(invoices: invoices, suggestions: suggestions)
    // Only open and overdue ostolaskut wait for a payment; the proposals lead.
    #expect(rows.map(\.id) == ["soon", "later", "late"])
    #expect(rows.map { $0.suggestion != nil } == [true, true, false])
    let data = PurchaseMatchData(invoices: invoices, suggestions: suggestions)
    #expect(data.proposed.map(\.id) == ["soon", "later"])
    #expect(data.waiting.map(\.id) == ["late"])
    #expect(PurchaseMatchData(invoices: [], suggestions: []).rows.isEmpty)
}

@Test func sureProposalsNeedTheScoreAndWhatAPaymentNeeds() throws {
    let strong = try listsSuggestion(invoiceId: "a", score: 0.9)
    let edge = try listsSuggestion(invoiceId: "b", score: 0.8)
    let weak = try listsSuggestion(invoiceId: "c", score: 0.7)
    let unscored = try listsSuggestion(invoiceId: "d", score: nil)
    let noRow = try listsSuggestion(invoiceId: "e", score: 0.9, transaction: nil)
    #expect(PurchaseMatch.isSure(strong) && PurchaseMatch.isSure(edge))
    #expect(!PurchaseMatch.isSure(weak) && !PurchaseMatch.isSure(unscored))
    #expect(PurchaseMatch.sureSuggestions([strong, edge, weak, unscored, noRow]).map(\.invoiceId) == ["a", "b"])
    let data = PurchaseMatchData(invoices: [try listsPurchase(id: "a")], suggestions: [strong, weak])
    #expect(data.sureCount == 1)
}

@Test func matchTextsFollowTheWeb() throws {
    #expect(PurchaseMatch.bulkTitle(sureCount: 3) == "Hyväksy kaikki varmat (3)")
    #expect(PurchaseMatch.bulkTitle(sureCount: 0) == "Hyväksy kaikki varmat")
    #expect(PurchaseMatch.bulkSummary(accepted: 0, failed: 0) == "Ei varmoja maksuja kohdistettavaksi.")
    #expect(PurchaseMatch.bulkSummary(accepted: 3, failed: 0) == "Kohdistettiin 3 maksua.")
    #expect(PurchaseMatch.bulkSummary(accepted: 2, failed: 1) == "Kohdistettiin 2 maksua. 1 ei onnistunut, tarkista ne.")
    let sure = try listsSuggestion(invoiceId: "a", score: 0.9)
    let weak = try listsSuggestion(invoiceId: "b", score: 0.7)
    #expect(PurchaseMatch.paymentLine(sure) == "Pankki · Tukku Oy · 25.1.2026 · 124,00\u{00A0}€")
    #expect(PurchaseMatch.reasonLine(sure) == "summa sama, nimi vastaa · varma")
    #expect(PurchaseMatch.reasonLine(weak) == "summa sama, nimi vastaa")
    #expect(PurchaseMatch.emptyTitle == "Ei avoimia ostolaskuja")
}

@Test func suggestionDecodesItsScoreAndAcceptsAsTheSheetDoes() throws {
    let s = try listsSuggestion(invoiceId: "a", score: 0.85)
    #expect(s.score == 0.85 && s.canAccept)
    #expect(s.acceptBody?.transactionId == "t1")
    // An older server sends no score: the proposal is shown but never counted as sure.
    #expect(try listsSuggestion(invoiceId: "a", score: nil).score == nil)
}
