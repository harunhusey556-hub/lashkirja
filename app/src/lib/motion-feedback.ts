export type MotionFeedback = {
  animate: boolean;
  shimmer: boolean;
  haptic: boolean;
  pressed: boolean;
  statusText: boolean;
};

/** Reduced motion drops movement. Haptics, pressed state and status text stay:
 * iOS "Reduce Motion" is unrelated to haptics (System Haptics governs them). */
export function motionFeedback(reducedMotion: boolean): MotionFeedback {
  return {
    animate: !reducedMotion,
    shimmer: !reducedMotion,
    haptic: true,
    pressed: true,
    statusText: true,
  };
}

export function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

