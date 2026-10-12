import Testing
@testable import LashKirjaCore

@Test func aConfirmSheetIsAsTallAsItsContentPlusTheHomeIndicator() {
    #expect(ConfirmSheetLayout.detentHeight(content: 260, bottomInset: 34, screenHeight: 844) == 294)
}

@Test func aConfirmSheetBeforeMeasuringUsesTheDefault() {
    #expect(ConfirmSheetLayout.detentHeight(content: 0, bottomInset: 34, screenHeight: 844) == ConfirmSheetLayout.unmeasuredHeight)
}

@Test func aShortQuestionStillGetsRoomForBothButtons() {
    #expect(ConfirmSheetLayout.detentHeight(content: 120, bottomInset: 0, screenHeight: 844) == ConfirmSheetLayout.minimumHeight)
}

@Test func aLongMessageIsCappedSoItScrollsAboveTheButtons() {
    #expect(ConfirmSheetLayout.detentHeight(content: 2000, bottomInset: 34, screenHeight: 800) == 600)
}

@Test func aNegativeInsetOrUnknownScreenDoesNotBreakTheHeight() {
    #expect(ConfirmSheetLayout.detentHeight(content: 300, bottomInset: -5, screenHeight: 0) == 300)
    #expect(ConfirmSheetLayout.detentHeight(content: 5000, bottomInset: 0, screenHeight: 0) == 5000)
}
