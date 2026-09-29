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
    // 250 ms: the shell no longer fades its first page in, so this is the
    // only fade at launch (SHELL-25).
    await SplashScreen.hide({ fadeOutDuration: 250 });
  } catch {
    // Web preview, or an IPA built before the plugin was added.
  }
}

/**
 * Mobile only (Task 7): "the first real screen" is either the login form
 * or the authenticated app shell's children -- whichever mounts first --
 * and each calls this itself, after its own two-rAF paint guarantee, once
 * it actually has something to show. `SplashReady` no longer decides this
 * on its own on mobile; it only listens here and calls `hideSplashScreen`.
 * Idempotent: the second caller (there are always exactly two candidates,
 * login and the shell, and only one of them mounts on a given launch) is a
 * no-op.
 */
let firstScreenReady = false;
const firstScreenListeners = new Set<() => void>();

export function markFirstScreen(): void {
  if (firstScreenReady) return;
  firstScreenReady = true;
  for (const listener of firstScreenListeners) listener();
  firstScreenListeners.clear();
}

/** Fires once, immediately if `markFirstScreen()` already ran. Returns an
 * unsubscribe, in case the caller unmounts before that happens. */
export function onFirstScreen(listener: () => void): () => void {
  if (firstScreenReady) {
    listener();
    return () => {};
  }
  firstScreenListeners.add(listener);
  return () => firstScreenListeners.delete(listener);
}

export function resetSplashForTests(): void {
  firstScreenReady = false;
  firstScreenListeners.clear();
}
