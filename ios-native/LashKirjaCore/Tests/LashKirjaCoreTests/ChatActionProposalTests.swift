import Testing
import Foundation
@testable import LashKirjaCore

private func message(_ json: String) throws -> ChatMessage {
    try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
}

private let draftJSON = #"""
{"id":"a2","role":"assistant","content":"Ehdotus on alla.","proposal":{"type":"invoice_draft","customerId":"c1","customerName":"Anna Laine",
 "issueDate":"2026-10-03","dueDate":"2026-10-10","paymentTermDays":7,"notes":null,
 "lines":[{"description":"Ripsienpidennys","quantity":1,"unit":"kpl","unitPrice":"80.00","vatRate":25.5,"net":"80.00"},
          {"description":"Huolto","quantity":2,"unit":"kpl","unitPrice":"25.50","vatRate":25.5,"net":"51.00"}, "rikki"],
 "totals":{"net":"131.00","vat":"33.41","gross":"164.41"},"limited":false},"sources":[],"status":"complete"}
"""#

private let receiptJSON = #"""
{"id":"a3","role":"assistant","content":"Ehdotus alla.","proposal":{"type":"receipt_update","receiptId":"r9","receiptSummary":"Lumene · 3.9.2026 · 49,90 €",
 "changes":[{"field":"category","label":"Luokka","from":"Muut","to":"Tarvikkeet & ostot"},{"field":"totalAmount","label":"Summa","from":"49,90 €","to":"59,90 €"}],
 "patch":{"category":"tarvikkeet","totalAmount":59.9},"expectedUpdatedAt":"2026-10-03T08:00:00.000Z",
 "status":"accepted","href":"/kuitit/kuitti?id=r9"}}
"""#

@Test func decodesAnInvoiceDraftProposal() throws {
    let p = try #require(try message(draftJSON).proposal)
    #expect(p.kind == .invoiceDraft)
    let draft = try #require(p.invoiceDraft)
    #expect(draft.customerName == "Anna Laine")
    // A line that is not an object is skipped, not fatal.
    #expect(draft.lines.count == 2)
    #expect(draft.lines[1].quantity == 2)
    #expect(draft.lines[1].unitPrice == Decimal(string: "25.50"))
    #expect(draft.gross == Decimal(string: "164.41"))
    #expect(ChatProposalCard.isShown(p))
    #expect(ChatProposalCard.title(p) == "Laskuluonnos")
    #expect(ChatProposalCard.canDecide(p, saving: nil))
    #expect(ChatProposalCard.lineDetail(draft.lines[1]) == "2 × 25,50\u{00A0}€")
    #expect(ChatProposalCard.draftTotals(draft)?.total == "Yhteensä 164,41\u{00A0}€")
    #expect(ChatProposalCard.draftTotals(draft)?.vat == "sis. ALV 33,41\u{00A0}€")
    #expect(ChatProposalCard.resultLink(p) == nil)
}

@Test func decodesAReceiptUpdateWithItsResultLink() throws {
    let p = try #require(try message(receiptJSON).proposal)
    #expect(p.kind == .receiptUpdate)
    #expect(p.receiptId == "r9")
    let update = try #require(p.receiptUpdate)
    #expect(update.receiptSummary == "Lumene · 3.9.2026 · 49,90 €")
    #expect(update.changes.map(\.label) == ["Luokka", "Summa"])
    #expect(update.changes[0].from == "Muut" && update.changes[0].to == "Tarvikkeet & ostot")
    #expect(ChatProposalCard.phase(p, saving: nil) == .accepted)
    #expect(!ChatProposalCard.canDecide(p, saving: nil))
    #expect(ChatProposalCard.statusLabel(.accepted, for: p) == "Kuitti korjattu")
    let link = try #require(ChatProposalCard.resultLink(p))
    #expect(link.label == "Avaa kuitti")
    #expect(link.href == "/kuitit/kuitti?id=r9")
    #expect(AppLink.parse(link.href) == .receipt("r9"))
}

@Test func acceptedDraftLinksToTheCreatedInvoice() throws {
    let accepted = draftJSON
        .replacingOccurrences(of: #""limited":false}"#, with: #""limited":false,"status":"accepted","invoiceId":"i7","invoiceNumber":1042,"href":"/laskut/lasku?id=i7"}"#)
    let p = try #require(try message(accepted).proposal)
    #expect(ChatProposalCard.statusLabel(.accepted, for: p) == "Luonnos tehty")
    let link = try #require(ChatProposalCard.resultLink(p))
    #expect(link.label == "Avaa lasku 1042")
    #expect(AppLink.parse(link.href) == .invoice("i7"))
}

@Test func unknownOrEmptyActionProposalsAreNotShown() throws {
    #expect(try message(#"{"id":"a","content":"x","proposal":{"type":"bank_transfer","amount":"10.00"}}"#).proposal == nil)
    let noLines = try message(#"{"id":"a","content":"x","proposal":{"type":"invoice_draft","customerName":"A","lines":[]}}"#)
    #expect(noLines.proposal != nil)
    #expect(!ChatProposalCard.isShown(noLines.proposal))
    let noChanges = try message(#"{"id":"a","content":"x","proposal":{"type":"receipt_update","receiptId":"r","changes":"bad"}}"#)
    #expect(!ChatProposalCard.isShown(noChanges.proposal))
}

@Test func decidingAnActionProposalUsesTheMatchFlow() throws {
    let m = try message(draftJSON)
    let decided = ChatProposalCard.decided(m, .rejected)
    #expect(decided.proposal?.status == "rejected")
    #expect(decided.proposal?.kind == .invoiceDraft)
    #expect(ChatProposalCard.statusLabel(.rejected, for: decided.proposal!) == "Ehdotus hylätty")
    #expect(ChatProposalCard.reverted(decided, to: nil).proposal?.status == nil)
    // The match card keeps its own words.
    let match = ChatMatchProposal(transactionId: "t", receiptId: "r", txSummary: "a", receiptSummary: "b")
    #expect(match.kind == .match)
    #expect(ChatProposalCard.statusLabel(.accepted, for: match) == "Kohdistus hyväksytty")
    #expect(ChatProposalCard.title(match) == "Ehdotus kohdistukseksi")
}
