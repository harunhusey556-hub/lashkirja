import Testing
@testable import LashKirjaCore

@Test func pushingAScreenAlreadyInTheStackGoesBackToIt() {
    // Pankkiyhteys → Tiliotteet → Pankkiyhteys: back to the first, not a third screen.
    #expect(NavigationStackRule.collapse(["hub", "accounts", "statements", "accounts"]) == ["hub", "accounts"])
    #expect(NavigationStackRule.collapse(["accounts", "statements", "accounts", "statements"]) == ["accounts", "statements"])
}

@Test func aNewScreenOrAPopIsKept() {
    #expect(NavigationStackRule.collapse(["hub", "accounts", "statements"]) == ["hub", "accounts", "statements"])
    #expect(NavigationStackRule.collapse(["hub"]) == ["hub"])
    #expect(NavigationStackRule.collapse([String]()) == [])
}
