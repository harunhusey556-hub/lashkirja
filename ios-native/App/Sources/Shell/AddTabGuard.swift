import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Keeps the "+" tab from ever being selected. UIKit selects a tapped tab item before the
/// TabView's selection binding can refuse it, so the "+" tab's empty page stood behind the
/// rising Lisää sheet for a few frames before Koti came back (motion audit koti-add-sheet: the
/// selection pill moved to "+", then a blank screen, in every CI walk). The tab bar controller
/// now asks first and is told no; the tap opens the sheet instead.
///
/// Refusing is not enough on iOS 26: the tab bar's selection gesture lifts the Liquid Glass lens
/// and sends it to the touched item the moment a finger lands, before the delegate is asked, and
/// brings it back across the other tabs once the answer is no (M015). A finger that lands on "+"
/// is therefore taken by `AddTouchGate`, and the tab bar's own gestures wait for it, so the lens
/// never leaves the tab showing. The delegate stays for what is not a touch (VoiceOver, Switch
/// Control, a finger that slid onto "+").
struct AddTabGuard: UIViewRepresentable {
    let title: String
    let onAdd: () -> Void

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onAdd = onAdd
        context.coordinator.title = title
        // On the next turn: the view is in its window by then.
        DispatchQueue.main.async { context.coordinator.attach(from: view) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UITabBarControllerDelegate {
        var onAdd: () -> Void = {}
        var title = ""
        private var gate: AddTouchGate?
        private let tied = NSHashTable<UIGestureRecognizer>.weakObjects()
        /// SwiftUI's own delegate: everything but the "+" question goes on to it.
        /// Read from the Objective-C forwarding calls below, which UIKit makes on the main thread.
        nonisolated(unsafe) private weak var inner: UITabBarControllerDelegate?

        func attach(from view: UIView) {
            guard let controller = Self.tabBarController(in: view.window?.rootViewController) else { return }
            claimAddTouches(on: controller.tabBar)
            // SwiftUI may set its delegate again on an update: taken back each time.
            if controller.delegate === self { return }
            inner = controller.delegate
            controller.delegate = self
        }

        /// The tab bar's own gestures wait for the gate, which fails at once for a touch anywhere but "+".
        private func claimAddTouches(on bar: UITabBar) {
            let gate = self.gate ?? AddTouchGate()
            self.gate = gate
            gate.hitsAdd = { [weak bar, title = title] point in
                guard let bar, var hit = bar.hitTest(point, with: nil) else { return false }
                while hit !== bar {
                    if hit.accessibilityLabel == title { return true }
                    guard let up = hit.superview else { return false }
                    hit = up
                }
                return false
            }
            gate.onAdd = { [weak self] in self?.onAdd() }
            if gate.view !== bar { bar.addGestureRecognizer(gate) }
            // SwiftUI or UIKit may add a recognizer later: each is tied once.
            for other in bar.gestureRecognizers ?? [] where other !== gate && !tied.contains(other) {
                other.require(toFail: gate)
                tied.add(other)
            }
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

/// A finger that comes down on "+": claimed from the first touch, so the tab bar's own selection
/// gesture never starts and its lens never leaves the tab showing. UIKit's lens follows a finger from
/// the moment it touches an item, before the delegate is asked, which can only refuse the selection.
private final class AddTouchGate: UIGestureRecognizer {
    var hitsAdd: (CGPoint) -> Bool = { _ in false }
    var onAdd: () -> Void = {}

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        // A second finger while "+" is held changes nothing.
        guard state == .possible else { return }
        guard touches.count == 1, let touch = touches.first, hitsAdd(touch.location(in: view)) else {
            state = .failed
            return
        }
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .ended
        // Lifted off "+", as a button's touch is: nothing opens.
        if let touch = touches.first, hitsAdd(touch.location(in: view)) { onAdd() }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .cancelled
    }
}
