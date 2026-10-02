import Testing
import Foundation
@testable import LashKirjaCore

private func message(_ json: String) throws -> ChatMessage {
    try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
}

private let proposalJSON = #"""
{"id":"a1","role":"assistant","content":"Löysin yhden ehdotuksen. Vahvista se alta.","clientId":null,
 "proposal":{"type":"match_proposal","transactionId":"t1","receiptId":"r1","txSummary":"K-Market — 12.50 € (1.10.2026)",
   "receiptSummary":"K-Market — 12.50 € (kuitti.jpg)","confidenceScore":0.92,"reasons":["Summa täsmää","Päivä täsmää"]},
 "limited":false,"sources":[{"label":"Tiliotteet","href":"/pankki/tapahtumat?month=2026-10"}],"status":"complete","createdAt":"2026-10-02T10:00:00.000Z"}
"""#

// MARK: Proposal

@Test func messageDecodesItsMatchProposal() throws {
    let m = try message(proposalJSON)
    let p = try #require(m.proposal)
    #expect(p.transactionId == "t1")
    #expect(p.receiptId == "r1")
    #expect(p.reasons == ["Summa täsmää", "Päivä täsmää"])
    #expect(p.confidenceScore == 0.92)
    #expect(p.status == nil)
    #expect(ChatProposalCard.isShown(p))
}

@Test func messageWithoutOrWithAnUnreadableProposalStillDecodes() throws {
    #expect(try message(#"{"id":"a","role":"assistant","content":"x","proposal":null}"#).proposal == nil)
    #expect(try message(#"{"id":"a","role":"assistant","content":"x"}"#).proposal == nil)
    #expect(try message(#"{"id":"a","role":"assistant","content":"x","proposal":{"type":"other"}}"#).proposal == nil)
    #expect(try message(#"{"id":"a","role":"assistant","content":"x","proposal":"bad"}"#).proposal == nil)
    let decided = try message(#"{"id":"a","content":"x","proposal":{"type":"match_proposal","transactionId":"t","receiptId":"r","txSummary":"a","receiptSummary":"b","confidenceScore":"high","reasons":null,"status":"accepted"}}"#)
    #expect(decided.proposal?.status == "accepted")
    #expect(decided.proposal?.confidenceScore == nil)
    #expect(decided.proposal?.reasons == [])
}

@Test func streamFinishCarriesTheProposal() throws {
    let event = try ChatEvent.parse(#"{"done":true,"status":"complete","id":"a1","content":"Vahvista se alta.","proposal":{"type":"match_proposal","transactionId":"t1","receiptId":"r1","txSummary":"a","receiptSummary":"b","confidenceScore":0.9,"reasons":[]},"sources":[]}"#)
    guard case .finished(let m) = event else { Issue.record("not finished"); return }
    #expect(m.proposal?.transactionId == "t1")
}

@Test func proposalWithoutABankRowIsNotShown() {
    #expect(!ChatProposalCard.isShown(nil))
    #expect(!ChatProposalCard.isShown(ChatMatchProposal(transactionId: "", receiptId: "r", txSummary: "", receiptSummary: "")))
    #expect(!ChatProposalCard.canDecide(ChatMatchProposal(transactionId: "", receiptId: "r", txSummary: "", receiptSummary: ""), saving: nil))
}

@Test func proposalPhasesAndLabels() {
    let open = ChatMatchProposal(transactionId: "t", receiptId: "r", txSummary: "a", receiptSummary: "b")
    #expect(ChatProposalCard.phase(open, saving: nil) == .open)
    #expect(ChatProposalCard.canDecide(open, saving: nil))
    #expect(!ChatProposalCard.canDecide(open, saving: .accepted))
    #expect(ChatProposalCard.phase(open, saving: .rejected) == .saving(.rejected))
    #expect(ChatProposalCard.statusLabel(.open) == nil)
    #expect(ChatProposalCard.statusLabel(.saving(.accepted)) == "Kohdistus hyväksytty")
    #expect(ChatProposalCard.statusLabel(.accepted) == "Kohdistus hyväksytty")
    #expect(ChatProposalCard.statusLabel(.rejected) == "Ehdotus hylätty")
    var accepted = open
    accepted.status = "accepted"
    #expect(ChatProposalCard.phase(accepted, saving: nil) == .accepted)
    #expect(!ChatProposalCard.canDecide(accepted, saving: nil))
}

@Test func proposalConfidenceAndSummaryText() {
    #expect(ChatProposalCard.confidenceLabel(0.92) == "Varmuus 92\u{00A0}%")
    #expect(ChatProposalCard.confidenceLabel(87) == "Varmuus 87\u{00A0}%")
    #expect(ChatProposalCard.confidenceLabel(nil) == nil)
    #expect(ChatProposalCard.confidenceLabel(0) == nil)
    #expect(ChatProposalCard.summary("Kauppa — 12.50 € (1.10.2026)") == "Kauppa — 12.50\u{00A0}€ (1.10.2026)")
}

@Test func decisionIsShownAtOnceAndRevertedOnRefusal() throws {
    let m = try message(proposalJSON)
    let decided = ChatProposalCard.decided(m, .accepted)
    #expect(decided.proposal?.status == "accepted")
    #expect(decided.id == m.id && decided.content == m.content)
    #expect(ChatProposalCard.reverted(decided, to: nil).proposal?.status == nil)
    let body = try JSONEncoder().encode(ChatDecisionRequest(id: "a1", decision: .rejected))
    let json = try JSONSerialization.jsonObject(with: body) as? [String: String]
    #expect(json == ["id": "a1", "decision": "rejected"])
}

// MARK: Destinations

@Test func newAppLinksForBankStatementsAndMail() {
    #expect(AppLink.parse("/pankki") == .bankHub)
    #expect(AppLink.parse("/tiliotteet") == .statements)
    #expect(AppLink.parse("/pankki/tiliotteet") == .statements)
    #expect(AppLink.parse("/sahkoposti") == .emailInbox)
    #expect(AppLink.parse("/alv-raportti?period=2026-09") == .alv("2026-09"))
    #expect(AppLink.parse("/alv-raportti") == .alv(nil))
}

/// Every href the server's chat emits (CHAT_DESTINATIONS, SOURCE_RULES, drill links) opens a screen.
@Test func everyServerChatHrefIsKnown() {
    let hrefs = [
        "/kirjanpito/pankkitilit?connect=1", "/laskut/uusi", "/asetukset/laskutus", "/kuitit", "/pankki/tapahtumat",
        "/kirjanpito/alv", "/raportit", "/asetukset", "/alv-raportti", "/laskut", "/tiliotteet",
        "/kirjanpito/alv?period=2026-09", "/kuitit?month=2026-09&type=meno", "/pankki/tapahtumat?month=2026-09",
        "/kuitit/kuitti?id=r1", "/laskut/lasku?id=i1", "/laskut?month=2026-09&status=open",
        "/pankki/tapahtumat?month=2026-10&rivi=t1",
    ]
    for href in hrefs { #expect(ChatDestination.make(ChatSource(label: "", href: href, kind: nil)) != nil, "\(href)") }
}

@Test func destinationCardsFoldBankLinksAndDropUnknownOnes() {
    let sources = [
        ChatSource(label: "Tiliotteet", href: "/pankki/tapahtumat?month=2026-09", kind: nil),
        ChatSource(label: "Kuitit", href: "/kuitit?month=2026-09&type=meno", kind: nil),
        ChatSource(label: "Tiliotteet", href: "/tiliotteet", kind: nil),
        ChatSource(label: "Tuntematon", href: "/ei-ole", kind: nil),
        ChatSource(label: "Kuitit", href: "/kuitit?month=2026-09&type=meno", kind: nil),
        ChatSource(label: "Uusi lasku", href: "/laskut/uusi", kind: "action"),
    ]
    let cards = ChatDestination.cards(sources)
    #expect(cards.map(\.title) == ["Pankki", "Kuitit", "Uusi lasku"])
    #expect(cards[0].isBank)
    #expect(cards[1].detail == "Syyskuu 2026 · menot")
    #expect(cards[1].symbol == "receipt")
    #expect(!cards[1].isAction)
    #expect(cards[2].isAction)
    #expect(cards[2].href == "/laskut/uusi")
}

@Test func bankRowAndConnectLinksKeepTheirOwnCards() {
    let row = ChatDestination.make(ChatSource(label: "Pankkitapahtuma", href: "/pankki/tapahtumat?month=2026-10&rivi=t1", kind: nil))
    #expect(row?.isBank == false)
    #expect(row?.link == .bankFeed(month: "2026-10", onlyOpen: false, transactionId: "t1"))
    let connect = ChatDestination.make(ChatSource(label: "Yhdistä pankki", href: "/kirjanpito/pankkitilit?connect=1", kind: "action"))
    #expect(connect?.isBank == false)
    #expect(connect?.isAction == true)
    #expect(connect?.title == "Yhdistä pankki")
    #expect(ChatDestination.make(ChatSource(label: "Pankki", href: "/pankki", kind: nil))?.isBank == true)
    #expect(ChatDestination.make(ChatSource(label: "Pankkitilit", href: "/kirjanpito/pankkitilit", kind: nil))?.isBank == true)
}

@Test func destinationTitleFallsBackWhenTheLabelIsEmpty() {
    let alv = ChatDestination.make(ChatSource(label: " ", href: "/kirjanpito/alv?period=2026-09", kind: nil))
    #expect(alv?.title == "ALV-ilmoitus")
    #expect(alv?.detail == "Kausi Syyskuu 2026")
    let receipt = ChatDestination.make(ChatSource(label: "Avaa kuitti", href: "/kuitit/kuitti?id=r1", kind: nil))
    #expect(receipt?.title == "Avaa kuitti")
    #expect(receipt?.link == .receipt("r1"))
}

@Test func bankSummaryCountsAccountsLikeTheHub() throws {
    let position = try JSONDecoder().decode(BankHubPosition.self, from: Data(#"""
    {"accounts":[
      {"id":"a1","name":"Käyttötili","currentBalance":1200.5,"archivedAt":null},
      {"id":"a2","name":"Vanha","currentBalance":3,"archivedAt":"2026-01-01T00:00:00.000Z"}],
     "totalBalance":1200.5,"needsAttention":0,
     "connected":{"accounts":[{"id":"c1","iban":"FI2112345600000785","balance":99.9}]},
     "combined":{"state":"connected","accountCount":2,"totalBalance":1300.4,"excludedCurrencies":[]}}
    """#.utf8))
    let summary = ChatBankSummary(position)
    #expect(summary.total == Decimal(string: "1300.4"))
    #expect(summary.accountCount == 2)
    #expect(summary.accountsLabel == "2 tiliä")
    #expect(summary.notice == nil)
    #expect(ChatBankSummary(total: 0, accountCount: 1).accountsLabel == "1 tili")
    #expect(ChatBankSummary(total: 0, accountCount: 0).accountsLabel == "Ei pankkitilejä vielä")
}

@Test func inlineLinksSplitInAppFromWeb() throws {
    #expect(ChatInlineLink.inAppHref(try #require(URL(string: "/kuitit?month=2026-09"))) == "/kuitit?month=2026-09")
    #expect(ChatInlineLink.inAppHref(try #require(URL(string: "https://vero.fi/omavero"))) == nil)
    #expect(ChatInlineLink.inAppHref(try #require(URL(string: "mailto:a@b.fi"))) == nil)
    #expect(ChatInlineLink.inAppHref(try #require(URL(string: "//evil.example/x"))) == nil)
    #if canImport(Darwin)
    // The markdown parser hands relative links over as such (Linux Foundation has no markdown options).
    let text = try AttributedString(markdown: "Katso [Kuitit](/kuitit?month=2026-09).", options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
    let url = try #require(text.runs.compactMap(\.link).first)
    #expect(ChatInlineLink.inAppHref(url) == "/kuitit?month=2026-09")
    #endif
}

// MARK: Receipt in chat

@Test func receiptFileRules() {
    #expect(ChatReceiptFile.mimeType(forFileName: "lasku.PDF") == "application/pdf")
    #expect(ChatReceiptFile.mimeType(forFileName: "a.jpeg") == "image/jpeg")
    #expect(ChatReceiptFile.mimeType(forFileName: "a.heic") == "image/heic")
    #expect(ChatReceiptFile.mimeType(forFileName: "a.docx") == nil)
    #expect(ChatReceiptFile.problem(name: "a.docx", bytes: 10) == ChatReceiptFile.unsupportedMessage)
    #expect(ChatReceiptFile.problem(name: "a.pdf", bytes: 15 * 1024 * 1024 + 1) == ChatReceiptFile.tooLargeMessage)
    #expect(ChatReceiptFile.problem(name: "a.pdf", bytes: 0) == ChatReceiptFile.unreadableMessage)
    #expect(ChatReceiptFile.problem(name: "a.pdf", bytes: 15 * 1024 * 1024) == nil)
    #expect(ChatReceiptFile.tooLargeMessage == "Tiedosto on liian suuri (enintään 15 Mt).")
    #expect(ChatReceiptFile.safeName("a\"b/c\nd.pdf") == "ab-c d.pdf")
    #expect(ChatReceiptFile.safeName("  ") == "kuitti")
    #expect(ChatReceiptFile.jpegName("IMG_1234.HEIC") == "IMG_1234.jpg")
    #expect(ChatReceiptFile.content("kuitti.pdf") == "Kuitti: kuitti.pdf")
    let date = Date(timeIntervalSince1970: 1_790_949_912) // 2026-10-02 14:05:12 UTC
    #expect(ChatReceiptFile.generatedName(date, timeZone: TimeZone(identifier: "UTC")!) == "kuitti-20261002-140512.jpg")
}

@Test func receiptUploadFailures() {
    #expect(ChatReceiptFile.failure(status: 413, data: Data("<html>".utf8)).message == ChatReceiptFile.tooLargeMessage)
    #expect(ChatReceiptFile.failure(status: 409, data: Data(#"{"error":"Kuittia käsitellään jo."}"#.utf8)).message == "Kuittia käsitellään jo.")
    #expect(ChatReceiptFile.failure(status: 404, data: Data(#"{"error":"Keskustelua ei löydy"}"#.utf8)).status == 404)
}

@Test func receiptPhases() {
    #expect(ChatReceiptPhase.progress(0.456) == .sending(0.456))
    #expect(ChatReceiptPhase.progress(1) == .reading)
    #expect(ChatReceiptPhase.sending(0.456).label == "Lähetetään… 46\u{00A0}%")
    #expect(ChatReceiptPhase.reading.label == "Luetaan kuittia…")
    #expect(ChatReceiptPhase.sent.label == nil)
    #expect(ChatReceiptPhase.failed("Ei yhteyttä").label == "Ei yhteyttä")
    #expect(ChatReceiptPhase.reading.isBusy)
    #expect(!ChatReceiptPhase.failed("x").isBusy)
    #expect(ChatReceiptPhase.failed("x").canRetry)
    #expect(!ChatReceiptPhase.reading.canRetry)
}

@Test func receiptResponseDecodes() throws {
    let json = #"""
    {"conversationId":"c1","receiptId":"r1",
     "userMessage":{"id":"u1","role":"user","content":"Kuitti: kuitti.jpg","clientId":"x","proposal":null,"limited":false,"sources":[],"status":"complete","createdAt":"2026-10-02T10:00:00.000Z"},
     "assistantMessage":{"id":"a1","role":"assistant","content":"Luin kuitin: **K-Market**, 12,50 €, 1.10.2026.","proposal":{"type":"match_proposal","transactionId":"t1","receiptId":"r1","txSummary":"a","receiptSummary":"b","confidenceScore":0.9,"reasons":[]},
       "sources":[{"label":"Avaa kuitti","href":"/kuitit/kuitti?id=r1"},{"label":"Pankkitapahtuma","href":"/pankki/tapahtumat?month=2026-10&rivi=t1"}],"status":"complete","createdAt":"2026-10-02T10:00:01.000Z"}}
    """#
    let response = try JSONDecoder().decode(ChatReceiptResponse.self, from: Data(json.utf8))
    #expect(response.conversationId == "c1")
    #expect(response.userMessage.content == "Kuitti: kuitti.jpg")
    #expect(response.assistantMessage.proposal?.receiptId == "r1")
    #expect(ChatDestination.cards(response.assistantMessage.sources).map(\.link) == [.receipt("r1"), .bankFeed(month: "2026-10", onlyOpen: false, transactionId: "t1")])
}
