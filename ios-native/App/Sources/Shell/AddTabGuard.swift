import SwiftUI
import UIKit

/// Keeps the "+" tab from ever being selected. UIKit selects a tapped tab item before the
/// TabView's selection binding can refuse it, so the "+" tab's empty page stood behind the
/// rising Lisää sheet for a few frames before Koti came back (motion audit koti-add-sheet: the
/// selection pill moved to "+", then a blank screen, in every CI walk). The tab bar controller
/// now asks first and is told no; the tap opens the sheet instead.
struct AddTabGuard: UIViewRepresentable {
    let onAdd: () -> Void

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onAdd = onAdd
        // On the next turn: the view is in its window by then.
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UITabBarControllerDelegate {
        var onAdd: () -> Void = {}
        /// SwiftUI's own delegate: everything but the "+" question goes on to it.
        /// Read from the Objective-C forwarding calls below, which UIKit makes on the main thread.
        nonisolated(unsafe) private weak var inner: UITabBarControllerDelegate?

        func attach(from view: UIView) {
            guard let controller = Self.tabBarController(in: view.window?.rootViewController) else { return }
            // SwiftUI may set its delegate again on an update: taken back each time.
            if controller.delegate === self { return }
            inner = controller.delegate
            controller.delegate = self
        }

        func tabBarController(_ controller: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
            // "+" is the last tab (MainTabView).
            if controller.tabs.last === tab {
                onAdd()
                return false
            }
            return inner?.tabBarController?(controller, shouldSelectTab: tab) ?? true
        }

        func tabBarController(_ controller: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
            if let last = controller.viewControllers?.last, last === viewController, controller.tabs.isEmpty {
                onAdd()
                return false
            }
            return inner?.tabBarController?(controller, shouldSelect: viewController) ?? true
        }

        nonisolated override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || (inner?.responds(to: selector) ?? false)
        }

        nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
            inner?.responds(to: selector) == true ? inner : nil
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
