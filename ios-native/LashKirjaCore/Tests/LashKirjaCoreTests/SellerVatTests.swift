import Testing
import Foundation
@testable import LashKirjaCore

@Test func unregisteredSellerLinesCarryNoVat() {
    var draft = InvoiceDraft(customerId: "c", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.lines = [.init(description: "Työ", quantity: 1, unitPrice: 100)]
    draft.followSellerVat(registered: false)
    #expect(draft.lines[0].vatRate == 0)
    #expect(draft.totals.vat == 0)
    #expect(draft.totals.gross == 100)
    #expect(InvoiceDraft.Line.new(sellerRegistered: false).vatRate == 0)
}

@Test func registeredSellerLinesAreLeftAlone() {
    var draft = InvoiceDraft(customerId: "c", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.lines = [.init(description: "Kirja", unitPrice: 10, vatRate: 0), .init(description: "Työ", unitPrice: 100)]
    draft.followSellerVat(registered: true)
    #expect(draft.lines.map(\.vatRate) == [0, Decimal(string: "25.5")!])
    #expect(InvoiceDraft.Line.new(sellerRegistered: true).vatRate == Decimal(string: "25.5")!)
}

@Test func windows1252TableCoversTheTypographicMarks() {
    // € ‚ „ … ” – — ™ plus Ä ö: what a Finnish Excel CSV holds.
    let bytes = Data([0x80, 0x82, 0x84, 0x85, 0x94, 0x96, 0x97, 0x99, 0xC4, 0xF6])
    #expect(CustomerImportRequest.windows1252(bytes) == "€‚„…”–—™Äö")
}
