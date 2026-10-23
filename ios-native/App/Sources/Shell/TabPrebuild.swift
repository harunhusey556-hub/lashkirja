import SwiftUI
import UIKit
import os

/// Builds a copy of each tab not yet shown once, after launch, while the main thread is idle, so a
/// tab's first visit builds faster: the first visit to Myynti, Kirjanpito or Raportit held the main
/// thread 0.4–1.3 s more than a revisit on CI (w53 perf walk), and the motion audit read the screen
/// that came after that still pause as a late change. SwiftUI fills a tab's own controller only
/// when the tab is selected (w58 perf walk: `TabHostingController` views=1 offscreen), so the copy
/// is a throwaway hosting controller laid out at the tab's size in a window the owner never sees:
/// the view types, list and search machinery and text are made once before the owner's tap. Its
/// `.task`s may start the tab's own cached reads early; they end with the copy.
struct TabPrebuild: UIViewRepresentable {
    /// Per tab, in TabView order: whether its first frame's data is in memory yet. The copy is built
    /// from the same previews as the tab's first frame, so it waits for them (or is not built).
    let ready: [@MainActor () -> Bool]
    /// Per tab, in TabView order: its root as the tab shows it ("+": the sheet it opens).
    let roots: [@MainActor () -> AnyView]

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    func updateUIView(_ view: UIView, context: Context) {
        // On the next turn: the view is in its window by then.
        context.coordinator.ready = ready
        context.coordinator.roots = roots
        DispatchQueue.main.async { context.coordinator.start(from: view) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        private static let logger = Logger(subsystem: "fi.lashkirja.perf", category: "Waits")
        private var started = false
        var ready: [@MainActor () -> Bool] = []
        var roots: [@MainActor () -> AnyView] = []

        func start(from view: UIView) {
            guard !started, let controller = Self.tabBarController(in: view.window?.rootViewController) else { return }
            started = true
            Task { await prebuild(controller) }
        }

        private func prebuild(_ controller: UITabBarController) async {
            // Koti's launch first: its figures are what the owner waits for.
            try? await Task.sleep(for: .seconds(1))
            Self.logger.log("prebuild tabs=\(self.roots.count, privacy: .public) controllers=\(controller.viewControllers?.count ?? -1, privacy: .public)")
            for index in roots.indices {
                // The launch prefetch paints the lists within a few seconds; offline it may never.
                var waited = 0
                while index < ready.count, !ready[index](), waited < 30 {
                    try? await Task.sleep(for: .milliseconds(500))
                    waited += 1
                }
                await RunLoopIdle.next()
                // The tab on screen is built already.
                guard index != controller.selectedIndex, index >= ready.count || ready[index]() else {
                    Self.logger.log("prebuild \(index, privacy: .public) skipped selected=\(index == controller.selectedIndex, privacy: .public)")
                    MotionProbe.shared.mark("prebuild-\(index)-skipped")
                    continue
                }
                let tabs = controller.viewControllers ?? []
                let name = index < tabs.count ? tabs[index].tabBarItem.title ?? "\(index)" : "\(index)"
                // On the audit's timeline too: a copy built after the walk's tap on its tab warmed
                // nothing for it (M040).
                MotionProbe.shared.mark("prebuild-\(index)-\(name)")
                build(roots[index](), size: controller.selectedViewController?.view.bounds.size ?? controller.view.bounds.size, name: name, in: controller.view.window?.windowScene)
            }
        }

        private func build(_ root: AnyView, size: CGSize, name: String, in scene: UIWindowScene?) {
            guard let scene else { return }
            let start = ContinuousClock.now
            let copy = Self.render(root, size: size, in: scene)
            Task { [copy] in
                try? await Task.sleep(for: .seconds(2))
                MotionProbe.shared.mark("prebuild-\(name)-freed=\(copy.host == nil && copy.window == nil)")
                MotionProbe.shared.mark("prebuild-\(name)-host-freed=\(copy.host == nil)")
                MotionProbe.shared.mark("prebuild-\(name)-window-freed=\(copy.window == nil)")
                // For `leaks --traceTree` (scripts/sim/run-ui.sh, LK_RETAIN_TRACE): what holds it.
                if let host = copy.host { MotionProbe.shared.mark("prebuild-\(name)-host-address=\(Self.address(host))") }
                if let window = copy.window { MotionProbe.shared.mark("prebuild-\(name)-window-address=\(Self.address(window))") }
                // Still there at 2 s is a leak only if it stays: released by 10 s says it was late.
                try? await Task.sleep(for: .seconds(8))
                MotionProbe.shared.mark("prebuild-\(name)-late=\(copy.host == nil && copy.window == nil)")
            }
            let elapsed = ContinuousClock.now - start
            let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
            MotionProbe.shared.mark("prebuild-\(name)-built ms=\(ms)")
            Self.logger.log("prebuild \(name, privacy: .public) \(ms, privacy: .public) ms \(copy.mode, privacy: .public) views=\(copy.views, privacy: .public) lists=\(copy.lists, privacy: .public)")
        }

        private static func address(_ object: AnyObject) -> String {
            "0x" + String(UInt(bitPattern: Unmanaged.passUnretained(object).toOpaque()), radix: 16)
        }

        /// What a copy came to, and handles that tell whether it was released afterwards.
        struct Rendered {
            let views: Int
            let lists: Int
            let mode: String
            weak var host: UIViewController?
            weak var window: UIWindow?
        }

        static func render(_ root: AnyView, size: CGSize, in scene: UIWindowScene) -> Rendered {
            // UIKit and SwiftUI autorelease references to the copy's controller and window while
            // they lay it out. Left to the caller's pool, the copy lives until that pool drains
            // (TabPrebuildFreedTests: both alive 2 s on, called from a method whose pool does not);
            // drained here, it is gone when this returns. Whether that is all M086 held (the Myynti
            // copy's window alive 2 s on in every CI launch; it never was on the iMac) only a CI
            // walk shows: the probe's `-freed` and `-late` marks.
            autoreleasepool { layout(root, size: size, in: scene) }
        }

        private static func layout(_ root: AnyView, size: CGSize, in scene: UIWindowScene) -> Rendered {
            // SwiftUI renders a hosting view only in a window (w58 perf walk: windowless, the copy
            // was one empty view). Its own window, never key and closed again in this turn; hidden
            // first, and if SwiftUI builds nothing there, shown under the app's window and off its
            // edge, out of reach of touches and VoiceOver.
            let window = UIWindow(windowScene: scene)
            window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue - 1)
            window.frame = CGRect(origin: CGPoint(x: scene.screen.bounds.width, y: 0), size: size)
            window.isUserInteractionEnabled = false
            window.accessibilityElementsHidden = true
            let host = UIHostingController(rootView: root)
            window.rootViewController = host
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.layoutIfNeeded()
            var mode = "hidden"
            if count(host.view) < 10 {
                mode = "shown"
                window.isHidden = false
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
            }
            let views = count(host.view), listCount = lists(host.view)
            window.isHidden = true
            window.rootViewController = nil
            // Out of the scene too, so no part of the copy stays among the windows a later
            // presentation goes through; the probe lines tell whether the copy was freed (w65),
            // the controller and the window each, as M086 needs to know which one stays.
            window.windowScene = nil
            return Rendered(views: views, lists: listCount, mode: mode, host: host, window: window)
        }

        private static func count(_ view: UIView) -> Int { 1 + view.subviews.reduce(0) { $0 + count($1) } }

        private static func lists(_ view: UIView) -> Int {
            (view is UICollectionView ? 1 : 0) + view.subviews.reduce(0) { $0 + lists($1) }
        }

        private static func tabBarController(in controller: UIViewController?) -> UITabBarController? {
            guard let controller else { return nil }
            if let tabs = controller as? UITabBarController { return tabs }
            for child in controller.children {
                if let found = tabBarController(in: child) { return found }
            }
            return nil
        }
    }
}

/// Resumes when the main run loop has nothing left to do and is about to wait: work queued here
/// goes after the frames and answers already due, not in front of them.
@MainActor
enum RunLoopIdle {
    static func next() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 0) { observer, _ in
                CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
                done.resume()
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        }
    }

    /// Resumes once the frame being built now is committed. The first idle is still the turn the
    /// change was made in, ahead of that turn's commit; the second comes after it.
    static func afterFrame() async {
        await next()
        await next()
    }
}
