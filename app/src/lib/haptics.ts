/**
 * Native haptics: the one API every screen uses (QUALITY-BAR T2).
 *
 *   hapticSelection()            chip, toggle, segmented control, picker row
 *   hapticImpact("light")        primary / destructive button press
 *   hapticNotify("success")      saved, approved, paid, imported, matched
 *   hapticNotify("warning")      confirm dialog for a destructive action
 *   hapticNotify("error")        a failed action
 *
 * Every function is fire-and-forget: it resolves, never rejects, and is a
 * no-op in the browser and in an IPA built without the plugin. It is NOT
 * gated on prefers-reduced-motion: iOS "Reduce Motion" is unrelated to
 * haptics, and the system "System Haptics" switch already governs them
 * natively.
 */

export type HapticImpactStyle = "light" | "medium" | "heavy";
export type HapticNotifyKind = "success" | "warning" | "error";

type HapticsModule = typeof import("@capacitor/haptics");

let modulePromise: Promise<HapticsModule | null> | null = null;

function nativeHaptics(): Promise<HapticsModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return null;
        return await import("@capacitor/haptics");
      } catch {
        return null;
      }
    })();
  }
  return modulePromise;
}

async function run(fn: (haptics: HapticsModule) => Promise<void>): Promise<void> {
  try {
    const haptics = await nativeHaptics();
    if (!haptics) return;
    await fn(haptics);
  } catch {
    // Web, or an IPA built before the plugin was added.
  }
}

/** The native "selection changed" tick (UISelectionFeedbackGenerator). */
export function hapticSelection(): Promise<void> {
  return run(async ({ Haptics }) => {
    await Haptics.selectionStart();
    await Haptics.selectionChanged();
    await Haptics.selectionEnd();
  });
}

/** A physical tap (UIImpactFeedbackGenerator). Light for primary buttons. */
export function hapticImpact(style: HapticImpactStyle = "light"): Promise<void> {
  return run(({ Haptics, ImpactStyle }) =>
    Haptics.impact({
      style: style === "heavy" ? ImpactStyle.Heavy : style === "medium" ? ImpactStyle.Medium : ImpactStyle.Light,
    })
  );
}

/** Outcome feedback (UINotificationFeedbackGenerator). */
export function hapticNotify(kind: HapticNotifyKind): Promise<void> {
  return run(({ Haptics, NotificationType }) =>
    Haptics.notification({
      type:
        kind === "success"
          ? NotificationType.Success
          : kind === "warning"
            ? NotificationType.Warning
            : NotificationType.Error,
    })
  );
}
