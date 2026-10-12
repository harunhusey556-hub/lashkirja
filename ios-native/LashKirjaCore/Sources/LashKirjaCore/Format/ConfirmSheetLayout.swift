/// The height of a confirmation bottom sheet: as tall as its text and buttons need (so a short
/// question does not open a half-screen sheet), never more than most of the screen (a long message
/// scrolls above the pinned buttons instead of pushing them away).
public enum ConfirmSheetLayout {
    /// The sheet is never shorter than this: room for the grab handle, a title and both buttons.
    public static let minimumHeight: Double = 220
    /// Share of the screen a sheet may take before its text starts to scroll.
    public static let maxScreenShare: Double = 0.75
    /// Used until the content has been measured, so the first frame is already a sensible sheet.
    public static let unmeasuredHeight: Double = 300

    /// `content` is the measured height of text plus buttons (0 while unmeasured), `bottomInset` the
    /// home-indicator area the sheet extends under, `screenHeight` the window's height (0 if unknown).
    public static func detentHeight(content: Double, bottomInset: Double, screenHeight: Double) -> Double {
        guard content > 0 else { return unmeasuredHeight }
        let wanted = max(content + max(bottomInset, 0), minimumHeight)
        guard screenHeight > 0 else { return wanted }
        return min(wanted, max(screenHeight * maxScreenShare, minimumHeight))
    }
}
