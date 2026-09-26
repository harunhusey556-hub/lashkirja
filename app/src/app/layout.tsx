import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import ShellGate from "@/components/ShellGate";
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
 *
 * The measured values must NOT be written onto documentElement.style. That
 * attribute is not in the server HTML, so the first client render mismatches
 * <html> and React reports a hydration error. A stylesheet in <head> carries
 * the same variables without touching the hydrated <html> attributes.
 * !important keeps the measurement ahead of the 0px defaults in globals.css
 * even if that file is injected again after this script runs.
 */
function SafeAreaShim() {
  return (
    <script
      dangerouslySetInnerHTML={{ __html: `(()=>{
  var STYLE_ID = 'lashkirja-shell-insets';
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
  function px(side){
    var real = realInset(side);
    var value = real > 0 ? real : shimInset(side);
    return Math.max(0, Math.round(value));
  }
  function apply(){
    var css = ':root{--shell-inset-top:'+px('top')+'px !important;--shell-inset-bottom:'+px('bottom')+'px !important}';
    var tag = document.getElementById(STYLE_ID);
    if (!tag) {
      tag = document.createElement('style');
      tag.id = STYLE_ID;
      document.head.appendChild(tag);
    }
    if (tag.textContent !== css) tag.textContent = css;
  }
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
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

/**
 * WebKit only evaluates `:active` when some element has a touch listener.
 * That alone is still late: `:active` can wait until the click, which on a
 * slow network feels like the tap did nothing. pointerdown paints
 * data-pressed immediately, before the click handler or any request.
 */
function TouchActiveShim() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `document.addEventListener('touchstart', function(){}, {passive:true});
(function(){
  var pressed = null;
  function clear(){
    if (!pressed) return;
    pressed.removeAttribute('data-pressed');
    pressed = null;
  }
  function targetOf(event){
    var node = event.target;
    if (!node) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node || !node.closest) return null;
    return node.closest('button, a, [role="button"], .active-press');
  }
  document.addEventListener('pointerdown', function(event){
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clear();
    var el = targetOf(event);
    if (!el) return;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return;
    el.setAttribute('data-pressed', 'true');
    pressed = el;
  }, {passive:true});
  document.addEventListener('pointerup', clear, {passive:true});
  document.addEventListener('pointercancel', clear, {passive:true});
  document.addEventListener('pointermove', function(event){
    if (!pressed) return;
    if (targetOf(event) !== pressed) clear();
  }, {passive:true});
  window.addEventListener('blur', clear);
})();`,
      }}
    />
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fi">
      <body className={`${inter.className} bg-cream min-h-screen`}>
        <SafeAreaShim />
        <TouchActiveShim />
        <ShellGate>{children}</ShellGate>
      </body>
    </html>
  );
}
