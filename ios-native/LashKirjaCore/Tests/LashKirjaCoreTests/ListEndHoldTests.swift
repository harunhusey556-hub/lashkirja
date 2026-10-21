import Testing
@testable import LashKirjaCore

// Raportit's Luokittain in the --ci seed: Menot 3 rows, Tulot 2, a row 66 pt with a 42 pt label.

private func row(_ top: Double) -> ListEndHold.Frame { ListEndHold.Frame(top: top, height: 42) }
private func button(_ top: Double) -> ListEndHold.Frame { ListEndHold.Frame(top: top, height: 20) }

@Test func atTheEndOfThePageTheWholeShrinkIsHeld() {
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: 0) == 66)
}

@Test func awayFromTheEndNothingIsHeld() {
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: 120) == 0)
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: 66) == 0)
}

@Test func nearTheEndOnlyWhatTheRoomCannotTakeIsHeld() {
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: 40) == 26)
}

@Test func aLongListHoldsWithMoreThanAScreenOfRoom() {
    // Menot shown to 25 rows and its button, to Tulot's 2: the page still scrolls more than a
    // screen (874 pt) down, and the shorter list leaves 436 pt of it short.
    #expect(ListEndHold.held(before: 25 * 66 + 44, after: 132, held: 0, room: 1126) == 436)
}

@Test func aLongerBlockTakesBackWhatWasHeld() {
    // Back to Menot at the end: the page keeps its height and holds nothing.
    #expect(ListEndHold.held(before: 132, after: 198, held: 66, room: 0) == 0)
    #expect(ListEndHold.held(before: 132, after: 165, held: 66, room: 0) == 33)
    // Shorter again: the space already held stays in the sum.
    #expect(ListEndHold.held(before: 165, after: 132, held: 33, room: 0) == 66)
}

@Test func aBounceAtTheEndCountsAsNoRoom() {
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: -12) == 66)
}

@Test func anUnknownRoomHoldsNothing() {
    #expect(ListEndHold.held(before: 198, after: 132, held: 0, room: Double.infinity) == 0)
}

@Test func aRowIsAsTallAsTheStepToTheNextRow() {
    #expect(ListEndHold.rowHeight([row(400), row(466), row(532)]) == 66)
    #expect(ListEndHold.rowHeight([nil, row(466), row(532)]) == 66)
}

@Test func noTwoNeighboursOnScreenGiveNoRowHeight() {
    #expect(ListEndHold.rowHeight([row(400), nil, row(532)]) == nil)
    #expect(ListEndHold.rowHeight([row(400)]) == nil)
    #expect(ListEndHold.rowHeight([]) == nil)
}

@Test func theButtonRowIsMeasuredUnderTheLastRow() {
    // The last row's cell ends at 586. A 20 pt label 12 pt into its cell: a 44 pt row.
    #expect(ListEndHold.buttonHeight(button(598), under: row(532), rowHeight: 66) == 44)
    // Centred in a taller minimum row: 16 pt above and below.
    #expect(ListEndHold.buttonHeight(button(602), under: row(532), rowHeight: 66) == 52)
}

@Test func aButtonOffScreenCountsAsARow() {
    #expect(ListEndHold.buttonHeight(nil, under: row(532), rowHeight: 66) == 66)
    #expect(ListEndHold.buttonHeight(button(598), under: nil, rowHeight: 66) == 66)
}

@Test func aBlockIsItsRowsAndItsButton() {
    #expect(ListEndHold.blockHeight(rows: 3, button: false, rowHeight: 66, buttonHeight: 44) == 198)
    #expect(ListEndHold.blockHeight(rows: 10, button: true, rowHeight: 66, buttonHeight: 44) == 704)
}

@Test func heldSpaceGoesOnlyOffScreenWithRoomBelow() {
    #expect(ListEndHold.canRelease(held: 66, carrierShown: false, room: 300))
    // Still on screen, or off it at the end of the page (a screen pushed over it): kept.
    #expect(!ListEndHold.canRelease(held: 66, carrierShown: true, room: 300))
    #expect(!ListEndHold.canRelease(held: 66, carrierShown: false, room: 0))
    #expect(!ListEndHold.canRelease(held: 0, carrierShown: false, room: 300))
}
