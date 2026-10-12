import Testing
import Foundation
@testable import LashKirjaCore

@Test func openTargetParsesCustomerAndInvoiceLinks() {
    #expect(OpenTarget(url: URL(string: "lashkirja://customer/abc123")!) == .customer("abc123"))
    #expect(OpenTarget(url: URL(string: "lashkirja://invoice/Inv9")!) == .invoice("Inv9"))
    #expect(OpenTarget(url: URL(string: "lashkirja://Customer/abc/")!) == .customer("abc"))
}

@Test func openTargetLeavesOtherLinksAlone() {
    #expect(OpenTarget(url: URL(string: "lashkirja://invoice/new")!) == nil)
    #expect(OpenTarget(url: URL(string: "lashkirja://invoice")!) == nil)
    #expect(OpenTarget(url: URL(string: "lashkirja://customer/a/b")!) == nil)
    #expect(OpenTarget(url: URL(string: "lashkirja://capture")!) == nil)
    #expect(OpenTarget(url: URL(string: "https://customer/abc")!) == nil)
    #expect(OpenTarget(url: URL(string: "lashkirja://")!) == nil)
    // A quick action is still only a quick action.
    #expect(QuickAction(url: OpenTarget.invoice("x1").url) == nil)
}

@Test func openTargetRoundTrips() {
    for target in [OpenTarget.customer("c_1"), .invoice("cm0abc"), .customer("a b")] {
        #expect(OpenTarget(url: target.url) == target)
    }
}

@Test func customerEntryShowsNameAndBusinessId() {
    let e = SpotlightEntry.customer(id: "c1", name: " Kauneus Oy ", businessId: "1234567-8")
    #expect(e?.title == "Kauneus Oy")
    #expect(e?.detail == "Asiakas · Y-tunnus 1234567-8")
    #expect(e?.keywords == ["Kauneus Oy", "1234567-8"])
    #expect(e?.identifier == "lashkirja://customer/c1")
    #expect(SpotlightEntry.customer(id: "c2", name: "Anna Asiakas", businessId: nil)?.detail == "Asiakas")
    #expect(SpotlightEntry.customer(id: "c3", name: "  ", businessId: nil) == nil)
    #expect(SpotlightEntry.customer(id: "", name: "X", businessId: nil) == nil)
}

@Test func invoiceEntryShowsNumberCustomerAmountStatus() {
    let e = SpotlightEntry.invoice(id: "i1", number: 3, customerName: "Anna Asiakas", gross: 124, statusLabel: "Maksettu")
    #expect(e?.title == "Lasku 3 · Anna Asiakas")
    #expect(e?.detail == "124,00\u{00A0}€ · Maksettu")
    #expect(e?.identifier == "lashkirja://invoice/i1")
    #expect(e?.keywords.contains("3") == true)
    #expect(SpotlightEntry.invoice(id: "i2", number: 4, customerName: "", gross: 1, statusLabel: "Luonnos")?.title == "Lasku 4")
    #expect(SpotlightEntry.invoice(id: "", number: 4, customerName: "", gross: 1, statusLabel: "Luonnos") == nil)
}

@Test func invoiceSequenceDecodesAndLabels() throws {
    let s = try JSONDecoder().decode(InvoiceSequence.self, from: Data(#"{"nextNumber":5}"#.utf8))
    #expect(s.nextNumber == 5)
    #expect(InvoiceSequence.label(5) == "Seuraava laskunumero: 5")
    #expect(InvoiceSequence.label(nil) == nil)
    #expect(InvoiceSequence.label(0) == nil)
}
