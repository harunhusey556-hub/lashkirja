import UIKit

/// What the simulator UI tests (LashKirjaUITests/OwnerScreensTests) need from the app, switched on
/// by the launch argument `-LKUITest`. Debug builds only: a Release build (the IPA) never reads it.
enum UITestHooks {
    #if DEBUG
    static let active = ProcessInfo.processInfo.arguments.contains("-LKUITest")
    #else
    static let active = false
    #endif

    static let fixtureName = "testikuitti.jpg"

    /// A receipt-like photo for the capture flow, because the simulator has no camera and its photo
    /// library cannot be driven. No date on it, so the reading is never complete enough to be saved
    /// without the form. A fresh code line each time: the server never sees the same file twice.
    static func fixtureReceipt() -> UIImage {
        let size = CGSize(width: 600, height: 900)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let lines = ["TESTIKAUPPA OY", "Y-tunnus 1234567-8", "", "Ripsiliima 1 kpl  12,40", "",
                     "YHTEENSÄ 12,40 EUR", "ALV 25,5 %  2,52", "", "Tosite \(UUID().uuidString.prefix(8))"]
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 30, weight: .regular),
            .foregroundColor: UIColor.black,
        ]
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            for (index, line) in lines.enumerated() {
                (line as NSString).draw(at: CGPoint(x: 40, y: 60 + CGFloat(index) * 52), withAttributes: attributes)
            }
        }
    }
}
