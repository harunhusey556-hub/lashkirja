/**
 * Dynamic Type for the bundled app (AX-01, B2-R3).
 *
 * The iOS text-size setting (Settings > Display > Text Size, and the larger
 * accessibility sizes) reaches the web layer through @capacitor/text-zoom's
 * `getPreferred()`: the body text style's point size divided by its default
 * 17 pt ("Large" = 1.0, "xxxLarge" ~1.35, "AX5" ~3.1). That value becomes
 * the CSS variable `--text-scale`, which every type token multiplies
 * (globals.css @theme: text-caption, text-body, ...). Only text scales:
 * spacing, hit areas, the header and the tab bar (text-tab stays 11 px)
 * keep their sizes, as in UIKit.
 *
 * The plugin's own `set()` (-webkit-text-size-adjust) is deliberately NOT
 * used: it scales every px size too, including the tab bar labels.
 *
 * Published from a <head> stylesheet, never the <html> style attribute
 * (hydration stays stable; same pattern as UsableArea).
 */

/** The range the layout is verified for (AX-02, R19: up to 200%). */
export const TEXT_SCALE_MIN = 0.85;
export const TEXT_SCALE_MAX = 2;

const STYLE_ID = "lashkirja-text-scale";

/** From here up, two-line clamps (`.clamp-lines`) are lifted: text is wrapped, never cut (AX-26). */
export const UNCLAMP_FROM = 1.3;

/** Clamps the plugin's preferred zoom to the verified range; bad input is 1. */
export function textScaleFromPreferred(value: unknown): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) return 1;
  const clamped = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, number));
  return Math.round(clamped * 100) / 100;
}

/** The head stylesheet for a scale: the variable, plus the lifted clamps from 130% up. */
export function textScaleCss(scale: number): string {
  return (
    `:root{--text-scale:${scale}}` +
    (scale >= UNCLAMP_FROM ? ":root .clamp-lines{display:block;-webkit-line-clamp:unset;overflow:visible}" : "")
  );
}

/** Publishes `--text-scale` (1 removes the override). */
export function applyTextScale(scale: number): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ID);
  if (scale === 1) {
    existing?.remove();
    return;
  }
  const css = textScaleCss(scale);
  const tag = existing ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: STYLE_ID }));
  if (tag.textContent !== css) tag.textContent = css;
}

let wired = false;

async function readPreferred(): Promise<number | null> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return null;
    const { TextZoom } = await import("@capacitor/text-zoom");
    const { value } = await TextZoom.getPreferred();
    return textScaleFromPreferred(value);
  } catch {
    // Web, or an IPA built before the plugin was added.
    return null;
  }
}

/**
 * Reads the iOS text size once at boot and again on every resume (the user
 * may change it in Settings while the app is in the background). No-op on
 * the web. Never throws.
 */
export async function syncTextScale(): Promise<void> {
  const scale = await readPreferred();
  if (scale === null) return;
  applyTextScale(scale);
  if (wired) return;
  wired = true;
  try {
    const { App } = await import("@capacitor/app");
    await App.addListener("resume", () => {
      void readPreferred().then((next) => {
        if (next !== null) applyTextScale(next);
      });
    });
  } catch {
    // No App plugin: the boot value stays until the next launch.
  }
}
