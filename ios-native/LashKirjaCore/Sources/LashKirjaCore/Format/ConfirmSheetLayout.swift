/// The height of a confirmation bottom sheet: as tall as its text and buttons need (so a short
/// question does not open a half-screen sheet), never more than most of the screen (a long message
/// scrolls above the pinned buttons instead of pushing them away).
public enum ConfirmSheetLayout {
    /// The sheet is never shorter than this. It sits below the height of a title and both buttons,
    /// so a title-only question is not padded into a blank band above its buttons.
    public static let minimumHeight: Double = 180
    /// Share of the screen a sheet may take before its text starts to scroll.
    public static let maxScreenShare: Double = 0.75
    /// Used until the content has been measured, so the first frame is already a sensible sheet.
    public static let unmeasuredHeight: Double = 300

    /// `content` is the measured height of text plus buttons (0 while unmeasured), `screenHeight` the
    /// window's height (0 if unknown). The home-indicator area is not added: the system puts it below
    /// a height detent by itself, and adding it here left that much blank sheet above the buttons.
    public static func detentHeight(content: Double, screenHeight: Double) -> Double {
        guard content > 0 else { return unmeasuredHeight }
        let wanted = max(content, minimumHeight)
        guard screenHeight > 0 else { return wanted }
        return min(wanted, max(screenHeight * maxScreenShare, minimumHeight))
    }
}
