import Testing
import Foundation
@testable import LashKirjaCore

@Test func markdownSplitsParagraphsListsAndHeadings() {
    let text = "Yhteenveto\n\n## Kuitit\n- yksi **tärkeä**\n- kaksi\n\n1. ensin\n2) sitten\nLopuksi"
    #expect(ChatMarkdown.blocks(text) == [
        .paragraph("Yhteenveto"),
        .heading("Kuitit"),
        .bullets(["yksi **tärkeä**", "kaksi"]),
        .numbered(["ensin", "sitten"]),
        .paragraph("Lopuksi"),
    ])
}

@Test func boldAtLineStartIsNotABullet() {
    #expect(ChatMarkdown.blocks("**Huom** tämä") == [.paragraph("**Huom** tämä")])
    #expect(ChatMarkdown.blocks("2026 on vuosi") == [.paragraph("2026 on vuosi")])
}

@Test func markdownBlocksOfEmptyAndStreamingText() {
    #expect(ChatMarkdown.blocks("").isEmpty)
    #expect(ChatMarkdown.blocks("- ") == [.paragraph("-")])
    // A half-written marker still renders (as text) while the reply grows.
    #expect(String(ChatMarkdown.inline("**bol").characters).contains("bol"))
}

@Test func inlineLinksKeepTheirInAppPath() {
    let text = ChatMarkdown.inline("Avaa [Kuitit](/kuitit?month=2026-10) ja [Google](https://example.com)")
    let urls = text.runs.compactMap(\.link)
    #expect(urls.count == 2)
    #expect(ChatInlineLink.inAppHref(urls[0]) == "/kuitit?month=2026-10")
    #expect(ChatInlineLink.inAppHref(urls[1]) == nil)
}

@Test func turnStopIsNotAFailureAndRetryResendsTheSameText() {
    var turn = ChatTurn.idle.sent()
    #expect(turn.canStop)
    turn = turn.received("Hei")
    #expect(turn == .streaming)
    #expect(turn.stopped() == .idle)
    turn = turn.failed("Yhteys katkesi.", text: "Kysymys")
    #expect(!turn.canStop)
    #expect(turn.retryText == "Kysymys")
    #expect(turn.failureMessage == "Yhteys katkesi.")
    #expect(turn.retried() == .waiting)
    #expect(ChatTurn.idle.retried() == .idle)
    #expect(ChatTurn.idle.failed("x", text: "y") == .idle)
}

@Test func proposalReadsAsSavingNotDoneUntilTheServerAnswers() {
    let proposal = ChatMatchProposal(transactionId: "t", receiptId: "r", txSummary: "a", receiptSummary: "b")
    #expect(ChatProposalCard.statusLabel(.saving(.accepted), for: proposal) == "Tallennetaan…")
    #expect(ChatProposalCard.statusLabel(.saving(.rejected), for: proposal) == "Tallennetaan…")
    #expect(ChatProposalCard.statusLabel(.accepted, for: proposal) == "Kohdistus hyväksytty")
}
