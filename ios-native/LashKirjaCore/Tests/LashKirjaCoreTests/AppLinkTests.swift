import Testing
import Foundation
@testable import LashKirjaCore

@Test func appLinksKeepTheirFilters() {
    #expect(AppLink.parse("/kuitit?month=2026-09&type=tulo") == .receipts(month: "2026-09", type: "tulo"))
    #expect(AppLink.parse("/kuitit") == .receipts(month: "", type: ""))
    #expect(AppLink.parse("/pankki/tapahtumat?month=2026-09") == .bankFeed(month: "2026-09", onlyOpen: false, transactionId: nil))
    #expect(AppLink.parse("/pankki/tapahtumat?nayta=toimet") == .bankFeed(month: nil, onlyOpen: true, transactionId: nil))
    #expect(AppLink.parse("/pankki/taydennys") == .bankFeed(month: nil, onlyOpen: true, transactionId: nil))
    #expect(AppLink.parse("/laskut/uusi") == .newInvoice)
    #expect(AppLink.parse("/raportit") == .reports)
    #expect(AppLink.parse("/kirjanpito/pankkitilit?connect=1") == .bankAccounts)
}

@Test func appLinksToDetails() {
    #expect(AppLink.parse("/kuitit/kuitti?id=r1") == .receipt("r1"))
    #expect(AppLink.parse("/laskut/lasku?id=i%201") == .invoice("i 1"))
    #expect(AppLink.parse("/pankki/tapahtumat/tiliote?id=s1") == .statement("s1"))
    #expect(AppLink.parse("/kirjanpito/alv?period=2026-Q3") == .alv("2026-Q3"))
    #expect(AppLink.parse("/kirjanpito/alv?period=2026-09#ilmoita") == .alv("2026-09"))
    #expect(AppLink.parse("/kirjanpito/ostolaskut?id=p1") == .purchaseInvoice("p1"))
    #expect(AppLink.parse("/kirjanpito/ostolaskut") == .purchaseInvoices)
    #expect(AppLink.parse("/kuitit/kuitti") == nil)
    #expect(AppLink.parse("https://example.com/x") == nil)
}
