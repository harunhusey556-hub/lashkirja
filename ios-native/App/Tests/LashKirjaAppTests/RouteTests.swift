import XCTest
import LashKirjaCore
@testable import LashKirja

final class RouteTests: XCTestCase {
    func testTabTitles() {
        XCTAssertEqual(AppTab.koti.title, "Koti")
        XCTAssertEqual(AppTab.myynti.title, "Myynti")
        XCTAssertEqual(AppTab.kirjanpito.title, "Kirjanpito")
        XCTAssertEqual(AppTab.raportit.title, "Raportit")
    }

    /// Screens read `openRoute` from the environment: a tab container's body running again builds a
    /// new action for the same stack, and that must not count as a change to every screen reading it.
    @MainActor
    func testOpenRouteActionsForOneStackAreEqual() {
        var pushed: [Route] = []
        let tab = OpenRouteAction(stack: "tab.myynti") { pushed.append($0) }
        XCTAssertEqual(tab, OpenRouteAction(stack: "tab.myynti") { _ in })
        XCTAssertNotEqual(tab, OpenRouteAction(stack: "assistant") { _ in })
        tab(.customers)
        tab(.invoice("a"))
        XCTAssertEqual(pushed, [.customers, .invoice("a")])
    }

    /// N2: an assistant reply's or a server item's `/pankki` link opens the bank rows, as Pankki on
    /// Kirjanpito does; the hub it named is gone.
    func testOldPankkiLinkOpensTheBankRows() {
        XCTAssertEqual(Route.fromHref("/pankki"), .bankFeed)
        XCTAssertEqual(Route.fromHref("/pankki/tapahtumat"), .bankFeed)
        XCTAssertEqual(Route.fromHref("/pankki/tapahtumat?nayta=toimet"), .bankFeedFiltered(month: nil, onlyOpen: true, focus: nil))
    }

    /// N5 (X005): Koti's "Näytä kaikki (N)" opens the list that holds all of its kind. Bank rows
    /// without a receipt are Pankki's rows that need action (Q1), receipts waiting are Kuitit.
    func testShowAllOpensTheKindsList() {
        XCTAssertEqual(Route.forShowAll(.missingReceipt, month: "2026-10"), .bankFeedFiltered(month: "2026-10", onlyOpen: true, focus: nil))
        XCTAssertEqual(Route.forShowAll(.receiptMatch, month: "2026-10"), .bankFeedFiltered(month: "2026-10", onlyOpen: true, focus: nil))
        XCTAssertEqual(Route.forShowAll(.pendingReceipt, month: "2026-10"), .receipts)
        XCTAssertEqual(Route.forShowAll(.vatGap, month: "2026-10"), .receiptsMissingVat(period: "2026-10"))
        XCTAssertEqual(Route.forShowAll(.overdueInvoice, month: "2026-10"), .invoicesFiltered(month: "", status: "overdue", customerId: ""))
        XCTAssertEqual(Route.forShowAll(.draftInvoice, month: "2026-10"), .invoicesFiltered(month: "2026-10", status: "draft", customerId: ""))
        XCTAssertNil(Route.forShowAll(.unknown, month: "2026-10"))
    }
}
