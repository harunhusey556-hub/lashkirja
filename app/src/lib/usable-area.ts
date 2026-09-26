/**
 * One usable-area calculation for the shell.
 *
 * The frame fills the WKWebView (top and bottom anchored to the layout
 * viewport). Notch and home-indicator clearance is padding inside the header
 * and tab bar, from CSS env(safe-area-inset-*), not a shorter frame.
 *
 * A visual viewport that is only a system inset shorter than the WebView must
 * not move the frame. That gap is published as a fallback padding and CSS
 * keeps the larger of env() and the fallback, so the same inset is not applied
 * twice and a zero env() reading cannot erase a real one.
 *
 * The keyboard is different: while an editable control is focused and the
 * visual viewport leaves a tall gap, the frame's bottom lifts by that gap and
 * the home-indicator padding is cleared. A tall gap with nothing focused is
 * not a keyboard — the frame still fills the WebView.
 */
export type UsableAreaInput = {
  innerHeight: number;
  offsetTop: number;
  viewportHeight: number;
  /** True when an input, textarea, select, or contenteditable is focused. */
  editableFocused: boolean;
};

export type UsableArea = {
  frameTop: number;
  frameBottom: number;
  /** Used only where env() is 0. CSS does max(env, fallback). */
  safeTopFallback: number;
  safeBottomFallback: number;
  keyboardOpen: boolean;
};

/** Taller than a home indicator or Dynamic Island; shorter than a keyboard. */
export const KEYBOARD_COVER_PX = 120;

/**
 * Largest visual-viewport gap treated as a missing env() inset.
 * This is the gap between system chrome and a keyboard, not a device table.
 */
export const SYSTEM_INSET_MAX_PX = 80;

function systemInset(gap: number): number {
  if (gap <= 0 || gap > SYSTEM_INSET_MAX_PX) return 0;
  return gap;
}

export function usableArea(input: UsableAreaInput): UsableArea {
  const innerHeight = Math.max(0, Math.round(input.innerHeight));
  const offsetTop = Math.max(0, Math.round(input.offsetTop));
  const viewportHeight = Math.max(0, Math.round(input.viewportHeight));
  const gapBelow = Math.max(0, innerHeight - offsetTop - viewportHeight);
  const keyboardOpen = input.editableFocused && gapBelow >= KEYBOARD_COVER_PX;

  if (keyboardOpen) {
    return {
      frameTop: offsetTop,
      frameBottom: gapBelow,
      safeTopFallback: 0,
      safeBottomFallback: 0,
      keyboardOpen: true,
    };
  }

  return {
    frameTop: 0,
    frameBottom: 0,
    safeTopFallback: systemInset(offsetTop),
    safeBottomFallback: systemInset(gapBelow),
    keyboardOpen: false,
  };
}
