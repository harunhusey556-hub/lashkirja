import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import ClientErrorReporter from "@/components/ClientErrorReporter";
import { NavBridge } from "@/components/NavBridge";
import ShellGate from "@/components/ShellGate";
import { SplashReady } from "@/components/SplashReady";
import { UsableArea } from "@/components/UsableArea";
import { API_BASE_URL, IS_MOBILE_BUILD } from "@/lib/build-target";
import { CiAutopilot } from "@/components/CiAutopilot";
import { CI_STEP_ORIGIN } from "@/lib/ci-autopilot/constants";
import "./globals.css";

/**
 * The web build gets its Content-Security-Policy from next.config.ts's
 * `headers()` -- unsupported in a static export (static-exports.md,
 * "Unsupported Features"). The bundled app has no server to send response
 * headers at all, so this is the only way to ship one: a meta tag in the
 * document `<head>`. `frame-ancestors` is not allowed in a meta CSP and is
 * omitted; it protects against being framed, which does not apply to a
 * `capacitor://localhost` document. Computed once at build time (the
 * mobile build's API_BASE_URL is fixed for that build), so no nonce is
 * needed here.
 */
function mobileContentSecurityPolicy(): string {
  const apiOrigin = new URL(API_BASE_URL).origin;
  // The CI simulator autopilot's step server, in that CI-only build alone
  // (next.config.ts allows the flag only with a local http API).
  const ciStepOrigin = process.env.NEXT_PUBLIC_CI_AUTOPILOT === "1" ? ` ${CI_STEP_ORIGIN}` : "";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${ciStepOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

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
  // AX-14, R27: light only, on purpose. Native controls, the keyboard and
  // system sheets follow this, not the OS dark mode.
  colorScheme: "light",
};

/**
 * Single press feedback. pointerdown sets data-pressed on the hit control
 * only (the nearest button, link, role=button, role=option, checkbox label,
 * .active-press or .press-row — not a wrapper). Inside a scroller the paint
 * waits 80 ms (or until the finger lifts, if sooner), as UIKit does. Scroll,
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
  var DELAY = 80;
  var pending = null;
  var pendingTimer = 0;
  function dropPending(){
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
    pending = null;
  }
  function clearNow(){
    dropPending();
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!pressed) return;
    pressed.removeAttribute('data-pressed');
    pressed = null;
  }
  function release(){
    if (pending) {
      // The finger lifted before the 80 ms delay: paint the press now so a
      // quick tap still shows it (UIKit delaysContentTouches).
      var node = pending;
      dropPending();
      arm(node);
    }
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
    return node.closest('button, a, [role="button"], [role="option"], .active-press, .press-row, label:has(input[type="checkbox"], input[type="radio"])');
  }
  function inScroller(el){
    var node = el.parentElement;
    while (node && node !== document.body) {
      var oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return true;
      node = node.parentElement;
    }
    return false;
  }
  document.addEventListener('pointerdown', function(event){
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    var el = targetOf(event);
    if (!el) return;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return;
    if (el.closest('.app-frame[data-overlay="open"] .app-header, .app-frame[data-overlay="open"] .app-tab-bar')) return;
    startX = event.clientX;
    startY = event.clientY;
    // C7 (IA-16): inside a scroller the press paints after 80 ms, so the
    // rows under a finger that starts a flick never flash.
    if (event.pointerType !== 'mouse' && inScroller(el)) {
      clearNow();
      pending = el;
      pendingTimer = setTimeout(function(){
        var node = pending;
        dropPending();
        if (node) arm(node);
      }, DELAY);
      return;
    }
    arm(el);
  }, {passive:true});
  document.addEventListener('pointerup', release, {passive:true});
  document.addEventListener('pointercancel', clearNow, {passive:true});
  document.addEventListener('pointermove', function(event){
    if (!pressed && !pending) return;
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
      {/* Painted before globals.css finishes loading (a cold load over
          Tailscale Funnel can take seconds), so the document is never a dark
          frame behind the native splash. Not covered by the Metadata API,
          which only manages title/meta/icon tags. */}
      <head>
        {IS_MOBILE_BUILD && (
          <meta httpEquiv="Content-Security-Policy" content={mobileContentSecurityPolicy()} />
        )}
        <style>{"html,body{background:#f6f3ef}"}</style>
      </head>
      <body className={`${inter.className} bg-canvas`}>
        <SplashReady />
        <UsableArea />
        <ClientErrorReporter />
        <NavBridge />
        <TouchActiveShim />
        <ShellGate>{children}</ShellGate>
        {IS_MOBILE_BUILD && process.env.NEXT_PUBLIC_CI_AUTOPILOT === "1" && <CiAutopilot />}
      </body>
    </html>
  );
}
