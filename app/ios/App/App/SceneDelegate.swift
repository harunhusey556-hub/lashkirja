import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // This is the only owner of the window. Info.plist sets neither
        // UISceneStoryboardFile nor UIMainStoryboardFile, so UIKit no longer
        // builds a second window and an unused MainViewController from
        // Base.lproj/Main.storyboard before this runs (that file is kept in the
        // bundle only to avoid a project-file edit; nothing loads it).
        window = UIWindow(windowScene: windowScene)
        // MainViewController, not a plain CAPBridgeViewController: it carries the
        // static-export router, the cancelled-navigation guard and the splash
        // safety timer. A plain bridge silently skips all three.
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
