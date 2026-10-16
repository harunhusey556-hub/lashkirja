import UIKit

/// What the simulator UI tests (LashKirjaUITests/OwnerScreensTests) need from the app, switched on
/// by the launch argument `-LKUITest`. Debug builds only: a Release build (the IPA) never reads it.
enum UITestHooks {
    #if DEBUG
    static let active = ProcessInfo.processInfo.arguments.contains("-LKUITest")
    #else
    static let active = false
    #endif

    /// RootView's launch-phase marker for the walks' launch helper (WalkTestCase.launchSignedIn).
    /// Its own argument too: the acceptance walks run without `-LKUITest`'s capture fixture.
    #if DEBUG
    static let launchPhase = active || ProcessInfo.processInfo.arguments.contains("-LKLaunchPhase")
    #else
    static let launchPhase = false
    #endif

    /// Milliseconds since this process was started (by the kernel's clock), for launch timings
    /// that include what happens before `main`.
    static func processAgeMs() -> Int? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        guard start.tv_sec > 0 else { return nil }
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return Int((Date().timeIntervalSince1970 - started) * 1000)
    }

    /// "<moment>=<ms after launch>" for the first build of each launch moment (RootView's marker).
    @MainActor private static var timeline: [String] = []
    @MainActor static var launchTimeline: String { timeline.isEmpty ? "launch phase" : timeline.joined(separator: " ") }
    @MainActor static func firstBuilt(_ moment: String) {
        guard launchPhase, !timeline.contains(where: { $0.hasPrefix(moment + "=") }) else { return }
        timeline.append("\(moment)=\(processAgeMs() ?? -1)")
    }

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
