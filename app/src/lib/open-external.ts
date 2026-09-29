import { IS_MOBILE_BUILD } from "@/lib/build-target";

/**
 * Opens a page outside the app. In the bundled app a plain link would take
 * over the app's own WebView and strand the user with no way back, so it goes
 * to the in-app Safari view (`@capacitor/browser`); on the web it opens a new
 * tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (IS_MOBILE_BUILD) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return;
    } catch {
      // No Browser plugin (a build without it): fall through to a new window.
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
