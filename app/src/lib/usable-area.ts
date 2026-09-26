/**
 * One usable-area calculation for the shell.
 *
 * The frame is the visual viewport (so a keyboard shrinks the chrome instead
 * of being padded like a notch). Safe-area padding is only the part of
 * env(safe-area-inset-*) that is still inside that frame. offsetTop is never
 * added a second time as header padding.
 */
export type UsableAreaInput = {
  innerHeight: number;
  offsetTop: number;
  viewportHeight: number;
  envTop: number;
  envBottom: number;
};

export type UsableArea = {
  frameTop: number;
  frameHeight: number;
  safeTop: number;
  safeBottom: number;
  keyboardOpen: boolean;
};

/** Taller than a home indicator; shorter overlaps stay system insets. */
export const KEYBOARD_COVER_PX = 120;

export function usableArea(input: UsableAreaInput): UsableArea {
  const frameTop = Math.max(0, Math.round(input.offsetTop));
  const frameHeight = Math.max(0, Math.round(input.viewportHeight));
  const gapBelow = Math.max(0, Math.round(input.innerHeight - frameTop - frameHeight));
  const keyboardOpen = gapBelow >= KEYBOARD_COVER_PX;
  return {
    frameTop,
    frameHeight,
    safeTop: Math.max(0, Math.round(input.envTop) - frameTop),
    safeBottom: keyboardOpen ? 0 : Math.max(0, Math.round(input.envBottom) - gapBelow),
    keyboardOpen,
  };
}
