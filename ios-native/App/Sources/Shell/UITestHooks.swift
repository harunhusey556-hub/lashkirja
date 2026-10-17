import UIKit

/// What the simulator UI tests (LashKirjaUITests/OwnerScreensTests) need from the app, switched on
/// by the launch argument `-LKUITest`. Debug and Release-UITest builds only (LK_UITEST_HOOKS): a
/// Release build (the IPA) never reads it.
enum UITestHooks {
    #if DEBUG || LK_UITEST_HOOKS
    static let active = ProcessInfo.processInfo.arguments.contains("-LKUITest")
    #else
    static let active = false
    #endif

    /// RootView's launch-phase marker for the walks' launch helper (WalkTestCase.launchSignedIn).
    /// Its own argument too: the acceptance walks run without `-LKUITest`'s capture fixture.
    #if DEBUG || LK_UITEST_HOOKS
    static let launchPhase = active || ProcessInfo.processInfo.arguments.contains("-LKLaunchPhase")
    #else
    static let launchPhase = false
    #endif

    #if DEBUG || LK_UITEST_HOOKS
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

    /// "<moment>=<ms after launch>" for the first time each launch moment came (RootView's marker).
    /// From any thread: the launch's 401 is marked where it arrives, off the main thread.
    private static let timelineLock = NSLock()
    private static var timeline: [String] = []
    static var launchTimeline: String {
        timelineLock.withLock { timeline.isEmpty ? "launch phase" : timeline.joined(separator: " ") }
    }
    static func mark(_ moment: String) {
        guard launchPhase else { return }
        let line: String? = timelineLock.withLock {
            guard !timeline.contains(where: { $0.hasPrefix(moment + "=") }) else { return nil }
            timeline.append("\(moment)=\(processAgeMs() ?? -1)")
            return timeline.last
        }
        // For a launch outside XCTest (`simctl launch --console-pty`, ios-session-gate.yml).
        if let line { print("LKMARK \(line)") }
    }
    #else
    /// The launch timeline is the UI tests' only: a Release build marks nothing.
    static func mark(_ moment: String) {}
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
