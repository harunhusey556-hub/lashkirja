import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import ClientErrorReporter from "@/components/ClientErrorReporter";
import ShellGate from "@/components/ShellGate";
import { UsableArea } from "@/components/UsableArea";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

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
  // Pinch zoom stays available. Inputs are 16px so iOS does not jump the
  // page on focus. Double-tap zoom is already off via touch-action.
  // See app/docs/viewport-zoom.md.
  viewportFit: "cover",
  themeColor: "#f6f3ef",
};

/**
 * Single press feedback. pointerdown sets data-pressed on the hit control
 * only (the nearest button, link, or role=button — not a wrapper). Scroll,
 * a route change, or an opening panel clears it immediately so a short hold
 * cannot stay painted on the previous control.
 *
 * To verify a tap: in the element picker, the node with data-pressed must be
 * event.target.closest('button, a, [role="button"]') and the control whose
 * click handler ran. A second control must not darken.
 */
function TouchActiveShim() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){
  var pressed = null;
  var timer = 0;
  var started = 0;
  var startX = 0;
  var startY = 0;
  var MIN = 140;
  function clearNow(){
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!pressed) return;
    pressed.removeAttribute('data-pressed');
    pressed = null;
  }
  function release(){
    if (!pressed) return;
    var wait = Math.max(0, MIN - (Date.now() - started));
    var node = pressed;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function(){
      if (pressed === node) {
        node.removeAttribute('data-pressed');
        pressed = null;
      }
      timer = 0;
    }, wait);
  }
  function arm(el){
    clearNow();
    el.setAttribute('data-pressed', 'true');
    pressed = el;
    started = Date.now();
  }
  function targetOf(event){
    var node = event.target;
    if (!node) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node || !node.closest) return null;
    return node.closest('button, a, [role="button"]');
  }
  document.addEventListener('pointerdown', function(event){
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    var el = targetOf(event);
    if (!el) return;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return;
    if (el.closest('.app-frame[data-overlay="open"] .app-header, .app-frame[data-overlay="open"] .app-tab-bar')) return;
    startX = event.clientX;
    startY = event.clientY;
    arm(el);
  }, {passive:true});
  document.addEventListener('pointerup', release, {passive:true});
  document.addEventListener('pointercancel', clearNow, {passive:true});
  document.addEventListener('pointermove', function(event){
    if (!pressed) return;
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) clearNow();
  }, {passive:true});
  document.addEventListener('contextmenu', function(event){
    var node = event.target;
    if (!node || !node.closest) return;
    if (node.closest('input, textarea, select')) return;
    if (node.closest('a, button, img, svg, .app-header, .app-tab-bar')) event.preventDefault();
  }, true);
  document.addEventListener('scroll', clearNow, true);
  document.addEventListener('lashkirja-dismiss-press', clearNow);
  window.addEventListener('popstate', clearNow);
  document.addEventListener('keydown', function(event){
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var el = event.target;
    if (!el || !el.matches || !el.matches('button, a, [role="button"]')) return;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return;
    arm(el);
  }, true);
  document.addEventListener('keyup', function(event){
    if (event.key === 'Enter' || event.key === ' ') release();
  }, true);
  window.addEventListener('blur', clearNow);
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
      <body className={`${inter.className} bg-cream`}>
        <UsableArea />
        <ClientErrorReporter />
        <TouchActiveShim />
        <ShellGate>{children}</ShellGate>
      </body>
    </html>
  );
}
