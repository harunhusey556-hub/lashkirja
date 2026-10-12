import Testing
import Foundation
@testable import LashKirjaCore

private func message(_ json: String) throws -> ChatMessage {
    try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
}

// The shape app/src/lib/chat-match-batch.ts stores (ChatMatchBatch): two confident cards, one ambiguous row.
private let batchJSON = #"""
{"id":"b1","role":"assistant","content":"Löysin 3 ehdotusta, 2 niistä varmoja.","status":"complete","sources":[],
 "proposal":{"type":"match_batch","confident":2,"ambiguous":1,"truncated":false,
  "pairs":[{"transactionId":"t1","receiptId":"r1"},{"transactionId":"t2","receiptId":"r2"}],
  "cards":[
   {"transactionId":"t1","receiptId":"r1",
    "bankRow":{"date":"2026-10-01","amountCents":-1250,"counterparty":"K-Market","href":"/pankki/tapahtumat?month=2026-10&rivi=t1"},
    "receipt":{"label":"K-Market","date":"2026-10-01","amountCents":1250,"href":"/kuitit/kuitti?id=r1"},
    "reasons":["Summa täsmää","Päivä täsmää"],"confidence":0.924,"status":"auto","ambiguous":false},
   {"transactionId":"t2","receiptId":"r2",
    "bankRow":{"date":null,"amountCents":4990,"counterparty":null,"href":"/pankki/tapahtumat?rivi=t2"},
    "receipt":{"label":"Lumene","date":null,"amountCents":null,"href":"/kuitit/kuitti?id=r2"},
    "reasons":[],"confidence":null,"status":"auto","ambiguous":false},
   {"transactionId":"t3","receiptId":null,
    "bankRow":{"date":"2026-10-03","amountCents":-900,"counterparty":"Posti","href":"/x"},
    "receipt":null,"reasons":[],"confidence":null,"status":"ambiguous","ambiguous":true,
    "options":[{"receiptId":"r3","label":"Posti 3.10.","reasons":["Summa täsmää"]},{"receiptId":"r4","label":"Posti 4.10.","reasons":[]},"rikki"]},
   "ei objekti"
  ]}}
"""#

private func batch() throws -> ChatMatchBatch {
    try #require(try message(batchJSON).proposal?.matchBatch)
}

@Test func decodesAMatchBatchProposal() throws {
    let proposal = try #require(try message(batchJSON).proposal)
    #expect(proposal.kind == .matchBatch)
    #expect(ChatProposalCard.isShown(proposal))
    #expect(ChatProposalCard.title(proposal) == "Kohdistusehdotukset")
    // Deciding goes through the rows, never PATCH /api/ai/chat (the server answers 400 for a batch).
    #expect(!ChatProposalCard.canDecide(proposal, saving: nil))
    let b = try batch()
    #expect(b.confident == 2 && b.ambiguous == 1 && !b.truncated)
    #expect(b.pairs == [.init(transactionId: "t1", receiptId: "r1"), .init(transactionId: "t2", receiptId: "r2")])
    // A card that is not an object is skipped, not fatal.
    #expect(b.cards.count == 3)
    let first = b.cards[0]
    #expect(first.receiptId == "r1" && first.receiptLabel == "K-Market" && first.counterparty == "K-Market")
    #expect(first.amountCents == -1250 && first.date == "2026-10-01")
    #expect(first.reasons == ["Summa täsmää", "Päivä täsmää"])
    #expect(first.confidence == 0.924 && !first.ambiguous)
    let ambiguous = b.cards[2]
    #expect(ambiguous.ambiguous && ambiguous.receiptId == nil)
    // An option that is not an object is skipped.
    #expect(ambiguous.options.map(\.receiptId) == ["r3", "r4"])
    #expect(ambiguous.options[0].label == "Posti 3.10.")
}

@Test func anEmptyOrUnreadableBatchIsNotShown() throws {
    let empty = try #require(try message(#"{"id":"b","role":"assistant","content":"","proposal":{"type":"match_batch","cards":[],"pairs":[]}}"#).proposal)
    #expect(empty.kind == .matchBatch)
    #expect(!ChatProposalCard.isShown(empty))
    // Counts are derived when the server leaves them out.
    #expect(empty.matchBatch?.confident == 0)
    // Other kinds stay as they were, and an unknown type still leaves the message without a card.
    #expect(try message(batchJSON).proposal?.invoiceDraft == nil)
    #expect(try message(#"{"id":"u","role":"assistant","content":"x","proposal":{"type":"future_thing"}}"#).proposal == nil)
}

@Test func headerAndButtonCopyMatchTheWeb() throws {
    let b = try batch()
    #expect(ChatMatchBatchText.header(b) == "3 kohdistusehdotusta · 2 varmaa · 1 epäselvä")
    #expect(ChatMatchBatchText.header(confident: 1, ambiguous: 0) == "1 kohdistusehdotus · 1 varma · 0 epäselvää")
    #expect(ChatMatchBatchText.header(confident: 3, ambiguous: 2) == "5 kohdistusehdotusta · 3 varmaa · 2 epäselvää")
    #expect(ChatMatchBatchText.buttonLabel(pending: 4) == "Hyväksy kaikki varmat (4)")
    #expect(ChatMatchBatchText.truncatedNote(confident: 80).contains("kaikki 80 varmaa"))
}

@Test func rowsReadReceiptThenCounterpartyWithAmountDateAndConfidence() throws {
    let b = try batch()
    #expect(ChatMatchBatchText.rowTitle(b.cards[0]) == "K-Market → K-Market")
    // The amount has no sign (a bank row is shown as the web does).
    #expect(ChatMatchBatchText.rowDetail(b.cards[0]) == "12,50\u{00A0}€ · 1.10.2026 · 92\u{00A0}%")
    #expect(ChatMatchBatchText.reasonsLine(b.cards[0]) == "Summa täsmää · Päivä täsmää")
    // No counterparty, date or confidence: the unknown-transfer wording and no empty parts.
    #expect(ChatMatchBatchText.rowTitle(b.cards[1]) == "Lumene → Tuntematon siirto")
    #expect(ChatMatchBatchText.rowDetail(b.cards[1]) == "49,90\u{00A0}€")
    #expect(ChatMatchBatchText.reasonsLine(b.cards[1]) == nil)
    // An ambiguous row names only the bank row and never shows a confidence.
    #expect(ChatMatchBatchText.rowTitle(b.cards[2]) == "Posti")
    #expect(ChatMatchBatchText.rowDetail(b.cards[2]) == "9,00\u{00A0}€ · 3.10.2026")
}

@Test func pendingPairsExcludeDecidedRowsAndAmbiguousOnes() throws {
    let b = try batch()
    var state = ChatMatchBatchState()
    #expect(state.pending(b).map(\.transactionId) == ["t1", "t2"])
    // Rejecting a row takes it out of the next "Hyväksy kaikki varmat".
    state.mark("t1", .rejected)
    #expect(state.pending(b).map(\.transactionId) == ["t2"])
    // Choosing a receipt on the ambiguous row does not touch the pending pairs.
    state.mark("t3", .confirmed)
    #expect(state.pending(b).map(\.transactionId) == ["t2"])
    #expect(state.resultText == nil)
}

@Test func acceptAllMarksSkippedPairsFailedAndSumsTheResult() throws {
    let b = try batch()
    var state = ChatMatchBatchState()
    let sent = state.pending(b)
    let answer = #"{"ok":true,"confirmed":1,"skipped":1,"alreadyConfirmed":2,"skippedPairs":[{"transactionId":"t2","receiptId":"r2"}]}"#
    let result = try JSONDecoder().decode(ChatMatchConfirmResult.self, from: Data(answer.utf8))
    #expect(result == ChatMatchConfirmResult(confirmed: 1, skipped: 1, alreadyConfirmed: 2, skippedTransactionIds: ["t2"]))
    state.applyBulk(sent: sent, result: result)
    #expect(state.rows["t1"] == .confirmed)
    #expect(state.rows["t2"] == .failed)
    #expect(state.pending(b).isEmpty)
    #expect(state.resultText == "Hyväksytty 1 · epäonnistui 1 · aiemmin hyväksytty 2")
    // The "aiemmin hyväksytty" part is left out when nothing was accepted before.
    var fresh = ChatMatchBatchState()
    fresh.applyBulk(sent: sent, result: ChatMatchConfirmResult(confirmed: 2))
    #expect(fresh.resultText == "Hyväksytty 2 · epäonnistui 0")
    // Totals add up over repeated taps.
    fresh.applyBulk(sent: [], result: ChatMatchConfirmResult(confirmed: 1, skipped: 1))
    #expect(fresh.resultText == "Hyväksytty 3 · epäonnistui 1")
}

@Test func aSingleRowAcceptFailsWhenTheServerSkippedIt() throws {
    var state = ChatMatchBatchState()
    state.applyAccept(transactionId: "t1", result: ChatMatchConfirmResult(confirmed: 1))
    state.applyAccept(transactionId: "t2", result: ChatMatchConfirmResult(skipped: 1, skippedTransactionIds: ["t2"]))
    #expect(state.rows["t1"] == .confirmed && state.rows["t2"] == .failed)
    #expect(ChatMatchBatchText.rowStatusLabel(.failed) == "Ei onnistunut: ehdotus ei ole enää voimassa")
    #expect(ChatMatchBatchText.rowStatusLabel(.rejected) == "Hylätty")
    // A row accept does not start the accept-all summary line.
    #expect(state.resultText == nil)
}

@Test func confirmAllBodyCarriesOnlyThePairs() throws {
    let body = ChatMatchPairsRequest(pairs: [.init(transactionId: "t1", receiptId: "r1")])
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
    // The route's schema is strict: nothing but `pairs`.
    #expect(Set(object.keys) == ["pairs"])
    let pairs = try #require(object["pairs"] as? [[String: String]])
    #expect(pairs == [["transactionId": "t1", "receiptId": "r1"]])
}
