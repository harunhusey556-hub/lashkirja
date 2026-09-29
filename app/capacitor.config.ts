import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "fi.tiyouba.lashkirja",
  appName: "LashKirja",
  // The mobile static export (Task 4, `npm run build:mobile`), copied into
  // the native project by `cap sync`. The UI ships inside the IPA now; there
  // is no remote `server.url` and no `errorPath` fallback page for a failed
  // remote load, because there is nothing remote to fail. The app talks to
  // the API over `fetch` using NEXT_PUBLIC_API_BASE_URL baked into the
  // export at build time (src/lib/build-target.ts), not a WebView server.
  webDir: "out",
  server: {
    // Both are already Capacitor's own defaults; set explicitly because the
    // API's CORS allowlist (env MOBILE_APP_ORIGINS, default
    // "capacitor://localhost") depends on the app origin being exactly
    // "capacitor://localhost" -- scheme "capacitor" + hostname "localhost".
    // Changing either here changes the app's Origin header and breaks CORS.
    iosScheme: "capacitor",
    hostname: "localhost",
  },
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
      // "LIGHT" = dark text for a light background (the plugin maps "DARK"
      // to .lightContent, i.e. white text, which vanished on the cream
      // canvas: SHELL-18). Not "DEFAULT": that follows the device's dark
      // mode and would put white text on this light-only app.
      style: "LIGHT",
      backgroundColor: "#f6f3ef",
    },
    // Stays disabled: enabling it would route the app's fetch calls (the
    // streamed AI chat included) through the native HTTP bridge instead of
    // WKWebView's own networking stack, breaking the stream.
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;
