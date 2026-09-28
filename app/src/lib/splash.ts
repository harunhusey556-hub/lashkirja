/**
 * Hides the native launch splash once the first real screen has painted.
 * No-op in a normal browser (`Capacitor.isNativePlatform()` false) and in an
 * IPA built before `@capacitor/splash-screen` was added. Safe to call more
 * than once: the native side already ignores a hide() once it is hidden.
 *
 * `capacitor.config.ts` sets `SplashScreen.launchAutoHide: false`, so
 * without this call the splash would stay up until
 * `MainViewController.swift`'s 8s safety-net timer fires.
 */
export async function hideSplashScreen(): Promise<void> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return;
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 200 });
  } catch {
    // Web preview, or an IPA built before the plugin was added.
  }
}
