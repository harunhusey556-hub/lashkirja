import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "fi.tiyouba.lashkirja",
  appName: "Tilikirja",
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
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#faf7f2",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#faf7f2",
    },
  },
};

export default config;
