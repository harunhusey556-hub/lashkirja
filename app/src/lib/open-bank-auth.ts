"use client";

import { BANK_AUTH_PENDING_KEY, bankCallbackPath, pendingBankAuthPayload, readPendingBankAuth } from "./bank-return";

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
 * Leave for the bank's authorization page. Web and the current Capacitor
 * webview both use a top-level navigation: that is what the bank's redirect
 * requires. The pending marker lets Asetukset explain a cancel that never
 * hits the callback.
 */
export function leaveForBank(url: string): void {
  rememberBankAuth();
  window.location.assign(url);
}

/**
 * When the OS opens the app with the callback URL (a later IPA / universal
 * link), route into the callback page. A no-op in the browser.
 */
export async function watchBankDeepLink(onPath: (path: string) => void): Promise<() => void> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return () => {};
    const { App } = await import("@capacitor/app");
    const handle = await App.addListener("appUrlOpen", (event) => {
      const path = bankCallbackPath(event.url);
      if (path) onPath(path);
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      const path = bankCallbackPath(launch.url);
      if (path) onPath(path);
    }
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}
