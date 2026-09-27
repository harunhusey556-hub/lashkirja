export type MotionFeedback = {
  animate: boolean;
  shimmer: boolean;
  haptic: boolean;
  pressed: boolean;
  statusText: boolean;
};

/** Reduced motion drops movement and haptics. Pressed state and status text stay. */
export function motionFeedback(reducedMotion: boolean): MotionFeedback {
  return {
    animate: !reducedMotion,
    shimmer: !reducedMotion,
    haptic: !reducedMotion,
    pressed: true,
    statusText: true,
  };
}

export function readReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function motionAllowsHaptic(): boolean {
  return motionFeedback(readReducedMotion()).haptic;
}
