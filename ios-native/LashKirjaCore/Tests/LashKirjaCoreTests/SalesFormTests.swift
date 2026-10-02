import Testing
import Foundation
@testable import LashKirjaCore

private let d255 = Decimal(string: "25.5")!
private let d135 = Decimal(string: "13.5")!

// MARK: - VAT rates by date (web `vatRatesForDate`, `vatRateOptions`)

@Test func salesVatRatesFollowTheInvoiceDate() {
    #expect(SalesVat.rates(forDate: "2026-01-01") == [d255, d135, 10, 0])
    #expect(SalesVat.rates(forDate: "2026-09-30") == [d255, d135, 10, 0])
    #expect(SalesVat.rates(forDate: "2025-12-31") == [d255, 14, 10, 0])
    #expect(SalesVat.rates(forDate: "2024-09-01").contains(14))
}

@Test func salesVatOptionsKeepALineRateThatIsNoLongerValid() {
    #expect(SalesVat.rateOptions(current: d255, issueDate: "2026-09-30") == [d255, d135, 10, 0])
    #expect(SalesVat.rateOptions(current: 14, issueDate: "2026-09-30") == [d255, d135, 10, 0, 14])
    #expect(SalesVat.rateOptions(current: d135, issueDate: "2025-12-15") == [d255, 14, 10, 0, d135])
}

@Test func salesVatDateNoteExplainsAnInvalidRate() {
    #expect(SalesVat.dateNote(d135, issueDate: "2026-03-01") == nil)
    #expect(SalesVat.dateNote(14, issueDate: "2025-12-15") == nil)
    #expect(SalesVat.dateNote(14, issueDate: "2026-03-01") == "ALV 14 % ei ole enää käytössä 1.1.2026 alkaen. Käytä ALV 13,5 %.")
    #expect(SalesVat.dateNote(d135, issueDate: "2025-12-15") == "ALV 13,5 % ei ole käytössä laskun päivälle.")
}

@Test func salesLinesMoveTo135WhenTheDateMovesIntoTheNewRate() {
    var lines = [InvoiceDraft.Line(description: "a", vatRate: 14), InvoiceDraft.Line(description: "b", vatRate: d255)]
    lines.adjustVatRates(issueDate: "2025-12-31")
    #expect(lines.map(\.vatRate) == [14, d255])
    lines.adjustVatRates(issueDate: "2026-01-01")
    #expect(lines.map(\.vatRate) == [d135, d255])
}

@Test func salesInvoiceDraftRefusesARateNotValidOnItsDate() {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-03-01", paymentTermDays: 14)
    draft.lines = [InvoiceDraft.Line(description: "Hoito", vatRate: 14)]
    #expect(draft.validationError == "ALV 14 % ei ole enää käytössä 1.1.2026 alkaen. Käytä ALV 13,5 %.")
    draft.issueDate = "2025-12-31"
    #expect(draft.validationError == nil)
}

// MARK: - Unsaved new-invoice drafts

@MainActor
@Test func salesDraftStoreKeepsOneDraftPerOwner() {
    let store = SalesDraftStore()
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.lines = [InvoiceDraft.Line(description: "Ripset")]
    let saved = Date(timeIntervalSince1970: 1_000)
    store.keep(draft, owner: "u1", now: saved)
    #expect(store.entry(owner: "u1")?.draft == draft)
    #expect(store.entry(owner: "u1")?.savedAt == saved)
    #expect(store.entry(owner: "u2") == nil)
    store.clear(owner: "u1")
    #expect(store.entry(owner: "u1") == nil)
}

@Test func salesDraftWorthKeepingOnlyWhenChanged() {
    var blank = InvoiceDraft(customerId: "", issueDate: "2026-10-02", paymentTermDays: 14)
    blank.lines = [InvoiceDraft.Line()]
    #expect(!SalesDraftStore.worthKeeping(blank, baseline: blank))
    var typed = blank
    typed.lines[0].description = "Ripsienpidennys"
    #expect(SalesDraftStore.worthKeeping(typed, baseline: blank))
}
