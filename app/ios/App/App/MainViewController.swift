import Capacitor
import Foundation
import WebKit

/// A cancelled top-level navigation is not a load failure.
///
/// Capacitor 8's `WebViewDelegationHandler` treats every
/// `didFailProvisionalNavigation` / `didFail` callback the same way: load
/// `errorPathURL` (`offline.html`) (`WebViewDelegationHandler.swift:139-156`
/// in `@capacitor/ios`). That includes a navigation WebKit cancelled
/// because another one superseded it -- `NSURLErrorCancelled` (-999) and
/// WebKit's "frame load interrupted" (`WebKitErrorDomain`, 102). Roadmap
/// Faz 1 requires those two to be ignored instead of shown as an outage
/// (final review I2; research `findings.md:106` item 3).
///
/// `CAPBridgeViewController.loadView()` is `final` and constructs
/// `WebViewDelegationHandler()` itself, and that instance's `bridge`
/// property is `internal(set)` -- a fresh instance built from the app
/// target can never get `bridge` wired up, and without it the *real*
/// error path (loading `offline.html` on a genuine failure) silently stops
/// working too. So instead of replacing the delegate instance, this
/// wraps it: our proxy intercepts only the two failure callbacks and
/// forwards every other `WKNavigationDelegate` message (navigation
/// policy, the JS bridge reset, the auth challenge, ...) to Capacitor's
/// own handler via Objective-C message forwarding, unchanged.
final class CancelledNavigationIgnoringDelegate: NSObject, WKNavigationDelegate {
    private let wrapped: WebViewDelegationHandler

    init(wrapping wrapped: WebViewDelegationHandler) {
        self.wrapped = wrapped
        super.init()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        if Self.isIgnorableCancellation(error) { return }
        wrapped.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if Self.isIgnorableCancellation(error) { return }
        wrapped.webView(webView, didFail: navigation, withError: error)
    }

    private static func isIgnorableCancellation(_ error: Error) -> Bool {
        let nsError = error as NSError
        // NSURLErrorCancelled: a navigation superseded by another one
        // (e.g. two overlapping top-level navigations -- see I1).
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return true
        }
        // WebKitErrorDomain "Frame load interrupted" (code 102): WebKit's
        // own policy-cancel error, raised e.g. when `decidePolicyFor`
        // returns `.cancel` for a navigation already under way.
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 {
            return true
        }
        return false
    }

    // MARK: - Objective-C message forwarding
    //
    // Everything not overridden above (didStartProvisionalNavigation,
    // decidePolicyFor, didFinish, the auth challenge, ...) must still reach
    // the real Capacitor handler unchanged. WKWebView dispatches
    // WKNavigationDelegate callbacks as Objective-C messages, so standard
    // forwarding is sufficient and does not require re-declaring every
    // method of the protocol (which would also risk drifting from
    // Capacitor's own signatures on a future SDK bump).
    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || wrapped.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        wrapped.responds(to: aSelector) ? wrapped : nil
    }
}

/// Serves the bundled Next.js static export (`app/out`, copied into
/// `ios/App/App/public` by `cap sync`) the same way Next's own file-router
/// would, instead of Capacitor's default `CapacitorRouter`
/// (`node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift:19-28`),
/// which serves `/index.html` for every extensionless path -- wrong for a
/// static export, where e.g. `/laskut/lasku` must resolve to
/// `laskut/lasku.html`.
///
/// This is a Swift port of `resolveExportPath` in
/// `src/lib/export-path.ts` (Task 4). Keep the two in sync by hand: this
/// build never runs the JS version, so a drift here is silent until a
/// route 404s on device.
struct NextExportRouter: Router {
    // Set by `WebViewAssetHandler.setAssetPath` (`CAPBridgeViewController
    // .swift:42`) to `configuration.appLocation.path`, the absolute
    // filesystem path of the bundled `public` directory. `Router.route(for:)`
    // returns `basePath`-prefixed absolute paths, matching
    // `CapacitorRouter`'s own convention, which callers turn into a
    // `URL(fileURLWithPath:)` (`WebViewAssetHandler.swift`).
    var basePath: String = ""

    func route(for path: String) -> String {
        let pathUrl = URL(fileURLWithPath: path)

        // Has an extension (e.g. "/logo.png", "/_next/static/chunks/a.js"):
        // served as is, exactly like CapacitorRouter.
        if !pathUrl.pathExtension.isEmpty {
            return basePath + path
        }

        // "/" or "": the export root.
        if path.isEmpty || path == "/" {
            return basePath + "/index.html"
        }

        // "/a/b" or "/a/b/": prefer the flat "a/b.html" static-export file,
        // then a nested "a/b/index.html", then fall back to the SPA shell.
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        let asFile = trimmed + ".html"
        if FileManager.default.fileExists(atPath: basePath + asFile) {
            return basePath + asFile
        }
        let asIndex = trimmed + "/index.html"
        if FileManager.default.fileExists(atPath: basePath + asIndex) {
            return basePath + asIndex
        }
        return basePath + "/index.html"
    }
}

/// Wires `CancelledNavigationIgnoringDelegate` in as the web view's
/// navigation delegate right after Capacitor creates its own. Created in
/// code by `SceneDelegate` as the window's root view controller (in place of
/// `Capacitor.CAPBridgeViewController`); no storyboard instantiates it.
class MainViewController: CAPBridgeViewController {
    // WKWebView.navigationDelegate is `weak`; Capacitor keeps its own
    // handler alive via the bridge, but nothing retains ours unless we do.
    private var cancelledNavigationDelegate: CancelledNavigationIgnoringDelegate?

    override func router() -> Router {
        NextExportRouter()
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // OWN-21: the app-target passkey plugin (PasskeyPlugin.swift). Local
        // plugins are not discovered from capacitor.config, so register it here.
        bridge?.registerPluginInstance(LashKirjaPasskeyPlugin())

        // First, and independent of the delegate wrap below: if Capacitor's
        // internals change shape and the guard bails out, the splash must
        // still never be able to cover the app forever.
        scheduleSplashSafetyNet()

        guard let webView = self.webView,
              let original = webView.navigationDelegate as? WebViewDelegationHandler else {
            // Conservative fallback: if Capacitor's internals ever change
            // shape, leave the default (unwrapped) delegate in place
            // rather than risk breaking navigation.
            return
        }

        let proxy = CancelledNavigationIgnoringDelegate(wrapping: original)
        cancelledNavigationDelegate = proxy
        webView.navigationDelegate = proxy
    }

    /// `capacitor.config.ts` sets `SplashScreen.launchAutoHide: false` so the
    /// splash stays up until the web app (src/lib/splash.ts) calls
    /// `SplashScreen.hide()` once the login page or app shell has actually
    /// painted -- rather than the previous fixed ~0.5s auto-hide, which
    /// exposed the bare WebView (black in dark mode) for the rest of a slow
    /// cold load over Tailscale Funnel (the owner's reported 10-12s black
    /// screen). If the JS call is ever missed -- a bundle that fails before
    /// mounting, a thrown error, a very slow first script evaluation -- this
    /// is the last resort so the splash can never hide the app forever.
    /// `evaluateJavaScript` (not a direct plugin call) because it exercises
    /// the exact same path a normal page load would use and needs no
    /// Capacitor-internal plugin lookup API.
    private func scheduleSplashSafetyNet() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen && " +
                "window.Capacitor.Plugins.SplashScreen.hide({ fadeOutDuration: 200 });",
                completionHandler: nil
            )
        }
    }
}
