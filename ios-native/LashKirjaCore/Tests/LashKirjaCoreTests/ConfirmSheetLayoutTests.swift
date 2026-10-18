import Testing
@testable import LashKirjaCore

@Test func aConfirmSheetIsExactlyAsTallAsItsContent() {
    #expect(ConfirmSheetLayout.detentHeight(content: 260, screenHeight: 844) == 260)
}

@Test func aTitleOnlyQuestionIsNotPaddedToTheMinimum() {
    #expect(ConfirmSheetLayout.detentHeight(content: 191, screenHeight: 844) == 191)
}

@Test func aConfirmSheetBeforeMeasuringUsesTheDefault() {
    #expect(ConfirmSheetLayout.detentHeight(content: 0, screenHeight: 844) == ConfirmSheetLayout.unmeasuredHeight)
}

@Test func aShortQuestionStillGetsRoomForBothButtons() {
    #expect(ConfirmSheetLayout.detentHeight(content: 120, screenHeight: 844) == ConfirmSheetLayout.minimumHeight)
}

@Test func aLongMessageIsCappedSoItScrollsAboveTheButtons() {
    #expect(ConfirmSheetLayout.detentHeight(content: 2000, screenHeight: 800) == 600)
}

@Test func anUnknownScreenDoesNotBreakTheHeight() {
    #expect(ConfirmSheetLayout.detentHeight(content: 300, screenHeight: 0) == 300)
    #expect(ConfirmSheetLayout.detentHeight(content: 5000, screenHeight: 0) == 5000)
}
