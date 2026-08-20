import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

/**
 * SafeAreaShim
 *
 * The installed Capacitor shell is built with `contentInset: "automatic"`,
 * and under that setting WKWebView reports env(safe-area-inset-*) as 0 even
 * though content is shifted under the Dynamic Island / home indicator. So the
 * pure-CSS padding in globals.css (which relies on env()) collapses to 0 and
 * the header slides under the notch while the tab bar collides with the home
 * indicator (black strip at the bottom).
 *
 * This shim detects that case and exposes the REAL device insets on CSS
 * custom properties (--shell-inset-top / --shell-inset-bottom). globals.css
 * then resolves every safe-area usage through
 *   --safe-top:  max(env(safe-area-inset-top, 0px), var(--shell-inset-top))
 * so whichever source is live wins. Fixing contentInset to "never" in the
 * shell makes env() resolve natively and the shim becomes a no-op (env() > 0).
 */
function SafeAreaShim() {
  return (
    <script
      dangerouslySetInnerHTML={{ __html: `(()=>{
  var el = document.documentElement;
  function realInset(side){
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-'+side+':env(safe-area-inset-'+side+', 0px)';
    document.body.appendChild(probe);
    var v = parseFloat(getComputedStyle(probe)['padding-'+side])||0;
    probe.remove();
    return v;
  }
  function shimInset(side){
    // WKWebView with contentInset:.automatic reports env()==0 but still shifts
    // content, so the real insets are the difference between the full viewport
    // and the visualViewport (the notch / home-indicator zone).
    var vv = window.visualViewport;
    if (!vv) return 0;
    return side==='top' ? (vv.offsetTop||0)
                        : (window.innerHeight - vv.height - vv.offsetTop);
  }
  function set(side){
    var real = realInset(side);
    var value = real > 0 ? real : shimInset(side);
    el.style.setProperty('--shell-inset-'+side, Math.max(0, Math.round(value))+'px');
  }
  set('top'); set('bottom');
  window.addEventListener('resize', function(){ set('top'); set('bottom'); });
  window.addEventListener('orientationchange', function(){ set('top'); set('bottom'); });
})();` }}
    />
  );
}

export const metadata: Metadata = {
  title: "LashKirja",
  description: "Yksinkertainen kirjanpito",
  manifest: "/manifest.json",
  // iOS ignores the manifest icons and only reads apple-touch-icon, so the
  // home-screen icon has to be declared here as well or Safari falls back to a
  // screenshot of the page.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LashKirja",
  },
};

// viewportFit: "cover" is what makes env(safe-area-inset-*) resolve to real
// values. globals.css already pads .app-header / .app-tab-bar / .app-main with
// those insets, but without this they all fall back to 0px and the tab bar
// collides with the iPhone home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Stops the accidental double-tap / focus zoom that makes typing on iOS
  // miserable. Safari deliberately ignores these two for pinch gestures
  // (accessibility), so browser users can still zoom; the installed app
  // (WKWebView) honours them fully.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#f5e6e0",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fi">
      <body className={`${inter.className} bg-cream min-h-screen`}>
        <SafeAreaShim />
        {children}
      </body>
    </html>
  );
}
