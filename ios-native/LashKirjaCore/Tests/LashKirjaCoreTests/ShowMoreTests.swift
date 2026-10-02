import Testing
@testable import LashKirjaCore

@Test func aLongListShowsTenAtATime() {
    var limit = ShowMore()
    #expect(limit.visible(25) == 10)
    #expect(limit.buttonTitle(total: 25) == "Näytä enemmän (15)")
    limit.more(total: 25)
    #expect(limit.visible(25) == 20)
    #expect(limit.buttonTitle(total: 25) == "Näytä enemmän (5)")
    limit.more(total: 25)
    #expect(limit.visible(25) == 25)
    // Everything open: the button folds the list back.
    #expect(limit.buttonTitle(total: 25) == "Näytä vähemmän")
    limit.more(total: 25)
    #expect(limit.visible(25) == 10)
}

@Test func aShortListHasNoButton() {
    let limit = ShowMore()
    #expect(limit.visible(7) == 7)
    #expect(limit.buttonTitle(total: 7) == nil)
    #expect(limit.buttonTitle(total: 10) == nil)
}

@Test func aCustomStepIsKept() {
    var limit = ShowMore(step: 5)
    #expect(limit.visible(12) == 5)
    limit.more(total: 12)
    #expect(limit.visible(12) == 10)
}
