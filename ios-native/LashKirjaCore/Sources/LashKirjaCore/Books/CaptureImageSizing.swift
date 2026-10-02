import Foundation

/// How big a captured receipt photo is sent. A 12–48 MP photo is several MB;
/// 2400 px on the longest side still reads well for the server's OCR/AI and
/// stays far below the 15 MB upload limit as a JPEG at 0.8.
public enum CaptureImageSizing {
    public static let maxSide: Double = 2400
    public static let jpegQuality: Double = 0.8

    public static func needsResize(width: Double, height: Double, maxSide: Double = maxSide) -> Bool {
        max(width, height) > maxSide
    }

    /// The pixel size to draw at, keeping the aspect ratio; never upscales.
    public static func targetSize(width: Double, height: Double, maxSide: Double = maxSide) -> (width: Double, height: Double) {
        let longest = max(width, height)
        guard longest > maxSide, longest > 0 else { return (width, height) }
        let scale = maxSide / longest
        return ((width * scale).rounded(), (height * scale).rounded())
    }
}
