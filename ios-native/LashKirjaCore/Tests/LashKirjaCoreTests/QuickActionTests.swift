import Testing
import Foundation
@testable import LashKirjaCore

@Test func quickActionUrlsParse() {
    #expect(QuickAction(url: URL(string: "lashkirja://capture")!) == .capture)
    #expect(QuickAction(url: URL(string: "lashkirja://invoice/new")!) == .newInvoice)
    #expect(QuickAction(url: URL(string: "lashkirja://assistant")!) == .assistant)
    // A trailing slash, query or odd case does not break the link.
    #expect(QuickAction(url: URL(string: "lashkirja://capture/")!) == .capture)
    #expect(QuickAction(url: URL(string: "lashkirja://Assistant?x=1")!) == .assistant)
    #expect(QuickAction(url: URL(string: "lashkirja:///capture")!) == .capture)
}

@Test func quickActionRejectsOtherLinks() {
    #expect(QuickAction(url: URL(string: "https://capture")!) == nil)
    #expect(QuickAction(url: URL(string: "lashkirja://invoice")!) == nil)
    #expect(QuickAction(url: URL(string: "lashkirja://invoice/old")!) == nil)
    #expect(QuickAction(url: URL(string: "lashkirja://reset?token=abc")!) == nil)
    #expect(QuickAction(url: URL(string: "lashkirja://")!) == nil)
}

@Test func quickActionUrlRoundTrips() {
    for action in QuickAction.allCases {
        #expect(QuickAction(url: action.url) == action)
        #expect(QuickAction(shortcutType: action.shortcutType) == action)
    }
    #expect(QuickAction(shortcutType: "fi.tiyouba.lashkirja.other") == nil)
}
