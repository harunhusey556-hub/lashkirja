import SwiftUI
import UIKit
import os

/// Builds the tabs not yet shown once, after launch, while the main thread is idle, so a tab's
/// first visit paints the screen at once instead of building it then: the first visit to Myynti,
/// Kirjanpito or Raportit took 0.4–1.3 s more than a revisit on CI (w53 perf walk), and the motion
/// audit read the late screen as a change after the tap. Each tab's own controller is laid out
/// offscreen and stays in the TabView; it is not in a window, so no `onAppear`/`.task` runs and
/// nothing is asked of the server before the owner opens the tab.
struct TabPrebuild: UIViewRepresentable {
    /// Per tab, in TabView order: whether its first frame's data is in memory yet. A tab's state is
    /// made when it is built, so one built before the launch prefetch has painted its list would
    /// keep a spinner; it is built once this holds (or not at all).
    let ready: [@MainActor () -> Bool]

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    func updateUIView(_ view: UIView, context: Context) {
        // On the next turn: the view is in its window by then.
        context.coordinator.ready = ready
        DispatchQueue.main.async { context.coordinator.start(from: view) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        private static let logger = Logger(subsystem: "fi.lashkirja.perf", category: "Waits")
        private var started = false
        var ready: [@MainActor () -> Bool] = []

        func start(from view: UIView) {
            guard !started, let controller = Self.tabBarController(in: view.window?.rootViewController) else { return }
            started = true
            Task { await prebuild(controller) }
        }

        private func prebuild(_ controller: UITabBarController) async {
            // Koti's launch first: its figures are what the owner waits for.
            try? await Task.sleep(for: .seconds(1))
            let tabs = controller.tabs
            Self.logger.log("prebuild tabs=\(tabs.count, privacy: .public) controllers=\(controller.viewControllers?.count ?? -1, privacy: .public)")
            // "+" is the last tab (MainTabView) and has nothing to build.
            for (index, tab) in tabs.dropLast().enumerated() {
                // The launch prefetch paints the lists within a few seconds; offline it may never.
                var waited = 0
                while index < ready.count, !ready[index](), waited < 30 {
                    try? await Task.sleep(for: .milliseconds(500))
                    waited += 1
                }
                await RunLoopIdle.next()
                guard tab !== controller.selectedTab, index >= ready.count || ready[index](), let child = tab.viewController else {
                    Self.logger.log("prebuild \(tab.identifier, privacy: .public) skipped vc=\(tab.viewController != nil, privacy: .public)")
                    continue
                }
                build(child, in: controller, name: tab.identifier)
            }
        }

        private func build(_ child: UIViewController, in controller: UITabBarController, name: String) {
            guard child.viewIfLoaded?.window == nil else { return }
            let start = ContinuousClock.now
            child.loadViewIfNeeded()
            // The size it will have on screen: laid out at any other, it lays out again on the first visit.
            child.view.frame = controller.selectedViewController?.view.frame ?? controller.view.bounds
            child.view.setNeedsLayout()
            child.view.layoutIfNeeded()
            for nested in child.children {
                nested.loadViewIfNeeded()
                nested.view.frame = child.view.bounds
                nested.view.layoutIfNeeded()
            }
            let elapsed = ContinuousClock.now - start
            let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
            Self.logger.log("prebuild \(name, privacy: .public) \(ms, privacy: .public) ms views=\(Self.count(child.view), privacy: .public) lists=\(Self.lists(child.view), privacy: .public) children=\(child.children.count, privacy: .public)")
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
}
