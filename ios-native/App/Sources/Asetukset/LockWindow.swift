import SwiftUI
import UIKit

/// Puts the lock screen in its own window above every sheet and full-screen
/// cover, so nothing presented can be read or used while locked.
struct LockWindowHost: UIViewRepresentable {
    let locked: Bool
    let app: AppModel

    func makeUIView(context: Context) -> UIView { UIView(frame: .zero) }

    func updateUIView(_ view: UIView, context: Context) {
        DispatchQueue.main.async { context.coordinator.update(locked: locked, app: app, from: view) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        private var window: UIWindow?

        func update(locked: Bool, app: AppModel, from view: UIView) {
            if locked {
                guard window == nil, let scene = view.window?.windowScene else { return }
                let window = UIWindow(windowScene: scene)
                window.windowLevel = .alert + 1
                window.rootViewController = UIHostingController(rootView: LockScreen().environment(app))
                window.makeKeyAndVisible()
                self.window = window
            } else if let window {
                window.isHidden = true
                self.window = nil
                view.window?.makeKey()
            }
        }
    }
}
