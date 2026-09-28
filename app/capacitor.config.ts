import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "fi.tiyouba.lashkirja",
  appName: "LashKirja",
  webDir: "public",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
        androidScheme: "https",
        // Local page in webDir, shown when the remote URL fails before the
        // app boots. cap sync bakes this into the IPA; an already installed
        // build does not pick it up until the next IPA.
        // The lashkirja:// scheme is not a Capacitor config key. The IPA
        // script patches it into Info.plist after sync.
        errorPath: "offline.html",
      }
    : undefined,
  ios: {
    // "never" makes WKWebView fill the screen and report REAL safe-area
    // insets through env(safe-area-inset-*), so the web UI can pad the header
    // (Dynamic Island) and tab bar (home indicator) correctly. "automatic"
    // reports env() as 0 and shifts content itself, hiding the top/bottom.
    contentInset: "never",
    // WKWebView.allowsLinkPreview. cap sync writes this into
    // ios/App/App/capacitor.config.json (gitignored). The native default is
    // YES when the key is missing. This flag does not by itself remove the
    // long-press URL balloon on an <a href>; the shell also sets
    // -webkit-touch-callout: none and the tab bar is not a link.
    allowsLinkPreview: false,
    // The web document is locked. This stops WKWebView's own UIScrollView
    // from rubber-banding the header and tab. A new IPA is required before
    // an installed app picks this up.
    scrollEnabled: false,
    // WKWebView's own background before the first paint of the remote page.
    // Without this it defaults to black under dark mode, which is the black
    // screen the owner saw during the 10-12s cold load over Tailscale
    // Funnel (first-run fix). The canvas token keeps it visually continuous
    // with the splash and the app itself, which is light-only.
    backgroundColor: "#f6f3ef",
  },
  plugins: {
    SplashScreen: {
      // Kept visible until the web app calls SplashScreen.hide() once the
      // login page or app shell has actually painted (src/lib/splash.ts).
      // With this true, Capacitor auto-hid the splash after ~0.5s
      // regardless of whether the remote page had loaded, exposing the bare
      // WebView (black in dark mode) for the rest of a slow cold load.
      // MainViewController.swift has an 8s native timer as a last resort so
      // the splash can never hide the app forever if the JS call is missed.
      launchAutoHide: false,
      // The app's canvas token, so the splash (icon tile centred on canvas) hands over to the
      // first page without a colour jump.
      backgroundColor: "#f6f3ef",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#f6f3ef",
    },
  },
};

export default config;
