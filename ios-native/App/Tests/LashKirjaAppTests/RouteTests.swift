import XCTest
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
}
