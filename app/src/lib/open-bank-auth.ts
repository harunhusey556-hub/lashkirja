"use client";

import { BANK_AUTH_PENDING_KEY, bankCallbackPath, pendingBankAuthPayload, readPendingBankAuth } from "./bank-return";
import { IS_MOBILE_BUILD } from "./build-target";

declare global {
  interface Window {
    /**
     * Test-only hook, set by `watchBankDeepLink` while the mobile bundle
     * runs outside a native shell (desktop Chrome against the static
     * export, playwright.mobile.config.ts). There is no real
     * `appUrlOpen` event to fire there, so `tests/e2e-mobile/bank-return.spec.ts`
     * calls this directly instead. Never present in the real native app
     * (Capacitor.isNativePlatform() is true there) or in the web build.
     */
    __lashkirjaDeepLink?: (url: string) => void;
  }
}

export function rememberBankAuth(): void {
  try {
    window.sessionStorage.setItem(BANK_AUTH_PENDING_KEY, pendingBankAuthPayload());
  } catch {
    // Private mode: the callback page still handles an explicit return.
  }
}

export function clearBankAuth(): void {
  try {
    window.sessionStorage.removeItem(BANK_AUTH_PENDING_KEY);
  } catch {
    // ignore
  }
}

/** True when the user left for the bank and came back without a callback. */
export function consumeInterruptedBankAuth(): boolean {
  try {
    const raw = window.sessionStorage.getItem(BANK_AUTH_PENDING_KEY);
    const pending = readPendingBankAuth(raw);
    if (!pending) {
      if (raw) window.sessionStorage.removeItem(BANK_AUTH_PENDING_KEY);
      return false;
    }
    window.sessionStorage.removeItem(BANK_AUTH_PENDING_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave for the bank's authorization page.
 *
 * Web: a top-level navigation, same origin the bank's redirect comes back
 * to. Mobile: opens an in-app Safari view (`@capacitor/browser`) instead --
 * a top-level navigation there would leave the app's own WebView, and the
 * bank's redirect target is the registered `lashkirja://` scheme (Task 11),
 * not a page inside this WebView to navigate back to. The pending marker
 * lets Asetukset explain a cancel that never hits the callback either way.
 */
export function leaveForBank(url: string): void {
  rememberBankAuth();
  if (IS_MOBILE_BUILD) {
    void openInAppBrowser(url);
    return;
  }
  window.location.assign(url);
}

async function openInAppBrowser(url: string): Promise<void> {
  try {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } catch {
    // No Browser plugin available (e.g. this module loaded outside
    // Capacitor entirely) -- fall back to a plain navigation rather than
    // stranding the user with no way to reach the bank at all.
    window.location.assign(url);
  }
}

/**
 * When the OS opens the app with the callback URL (`lashkirja://bank/callback…`),
 * route into the callback page. A no-op in the browser -- except for the
 * mobile build's own emulated environment, where it exposes a small test
 * hook instead (see `window.__lashkirjaDeepLink` above), since there is no
 * native `appUrlOpen` event to simulate there.
 */
export async function watchBankDeepLink(onPath: (path: string) => void): Promise<() => void> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) {
      if (IS_MOBILE_BUILD && typeof window !== "undefined") {
        window.__lashkirjaDeepLink = (url: string) => {
          const path = bankCallbackPath(url);
          if (path) onPath(path);
        };
        return () => {
          delete window.__lashkirjaDeepLink;
        };
      }
      return () => {};
    }
    const { App } = await import("@capacitor/app");
    const { Browser } = await import("@capacitor/browser");
    const handle = await App.addListener("appUrlOpen", (event) => {
      const path = bankCallbackPath(event.url);
      if (!path) return;
      // The bank's redirect landed while the in-app browser (leaveForBank
      // above) was still open on top of the app -- close it before routing
      // into the callback page, so the user lands back in the app itself
      // rather than staring at the now-pointless browser sheet.
      void (async () => {
        try {
          await Browser.close();
        } catch {
          // Not open, or unsupported on this platform -- route in anyway.
        }
        onPath(path);
      })();
    });
    // getLaunchUrl() keeps returning the SAME url for the rest of this
    // process's lifetime once the app was cold-launched from a
    // lashkirja:// link (research H6) -- without this guard, every later
    // ShellGate mount (e.g. after logout, landing back on /login) would
    // navigate to /bank/callback again. The module flag catches a same-
    // process remount; the sessionStorage marker also survives a JS module
    // reload within the same tab/session, should one ever happen.
    if (consumeLaunchUrlOnce()) {
      const launch = await App.getLaunchUrl();
      if (launch?.url) {
        const path = bankCallbackPath(launch.url);
        if (path) onPath(path);
      }
    }
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}

const LAUNCH_URL_CONSUMED_KEY = "lashkirja.bank-launch-url.v1";
let launchUrlConsumedThisProcess = false;

function consumeLaunchUrlOnce(): boolean {
  if (launchUrlConsumedThisProcess) return false;
  launchUrlConsumedThisProcess = true;
  try {
    if (window.sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)) return false;
    window.sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, "1");
  } catch {
    // Private mode / sessionStorage unavailable: the module flag above
    // still holds for the rest of this process.
  }
  return true;
}
