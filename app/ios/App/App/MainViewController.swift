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

/// Wires `CancelledNavigationIgnoringDelegate` in as the web view's
/// navigation delegate right after Capacitor creates its own. Selected in
/// `Base.lproj/Main.storyboard` as the bridge view controller's custom
/// class (in place of `Capacitor.CAPBridgeViewController`).
class MainViewController: CAPBridgeViewController {
    // WKWebView.navigationDelegate is `weak`; Capacitor keeps its own
    // handler alive via the bridge, but nothing retains ours unless we do.
    private var cancelledNavigationDelegate: CancelledNavigationIgnoringDelegate?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

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
}
