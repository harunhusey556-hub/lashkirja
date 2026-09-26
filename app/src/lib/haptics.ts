/** Light native haptics. No-op in the browser and when the plugin is absent. */

async function nativeHaptics() {
  const { Capacitor } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform()) return null;
  return import("@capacitor/haptics");
}

export async function hapticSelection(): Promise<void> {
  try {
    const haptics = await nativeHaptics();
    if (!haptics) return;
    await haptics.Haptics.impact({ style: haptics.ImpactStyle.Light });
  } catch {
    // Web or an IPA built before the plugin was added.
  }
}

export async function hapticNotify(kind: "success" | "error"): Promise<void> {
  try {
    const haptics = await nativeHaptics();
    if (!haptics) return;
    await haptics.Haptics.notification({
      type: kind === "success" ? haptics.NotificationType.Success : haptics.NotificationType.Error,
    });
  } catch {
    // Web or an IPA built before the plugin was added.
  }
}
