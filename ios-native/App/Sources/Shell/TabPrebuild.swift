import SwiftUI
import UIKit
import os

/// Builds a copy of each tab not yet shown once, after launch, while the main thread is idle, so a
/// tab's first visit builds faster: the first visit to Myynti, Kirjanpito or Raportit held the main
/// thread 0.4–1.3 s more than a revisit on CI (w53 perf walk), and the motion audit read the screen
/// that came after that still pause as a late change. SwiftUI fills a tab's own controller only
/// when the tab is selected (w58 perf walk: `TabHostingController` views=1 offscreen), so the copy
/// is a throwaway hosting controller laid out offscreen at the tab's size: the view types, list and
/// search machinery and text are made once before the owner's tap. It is not in a window, so no
/// `onAppear`/`.task` runs and nothing is asked of the server before the owner opens the tab.
struct TabPrebuild: UIViewRepresentable {
    /// Per tab, in TabView order: whether its first frame's data is in memory yet. The copy is built
    /// from the same previews as the tab's first frame, so it waits for them (or is not built).
    let ready: [@MainActor () -> Bool]
    /// Per tab, in TabView order: its root as the tab shows it.
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
                    continue
                }
                let tabs = controller.viewControllers ?? []
                let name = index < tabs.count ? tabs[index].tabBarItem.title ?? "\(index)" : "\(index)"
                build(roots[index](), size: controller.selectedViewController?.view.bounds.size ?? controller.view.bounds.size, name: name)
            }
        }

        private func build(_ root: AnyView, size: CGSize, name: String) {
            let start = ContinuousClock.now
            let host = UIHostingController(rootView: root)
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            let elapsed = ContinuousClock.now - start
            let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
            Self.logger.log("prebuild \(name, privacy: .public) \(ms, privacy: .public) ms views=\(Self.count(host.view), privacy: .public) lists=\(Self.lists(host.view), privacy: .public)")
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
