/**
 * The one gesture vocabulary (C8, IA-20). Every drag in the app (edge swipe
 * back, BottomSheet, the assistant drawer, the image viewer, pull to refresh)
 * reads its thresholds and its release velocity from here, so the same flick
 * does the same thing everywhere.
 *
 * Velocity is measured over the LAST 100 ms of movement (as UIKit does),
 * never as a whole-gesture average: a slow drag that ends in a flick commits,
 * a fast start that stops before release does not.
 */

/** Movement before a drag decides its axis (hysteresis), px. */
export const DECIDE_SLOP = 6;

/** Edge swipe back: starts within this many px of the left edge. */
export const EDGE_ZONE = 24;
/** Edge swipe commits past this fraction of the width... */
export const EDGE_COMMIT_RATIO = 0.32;
/** ...or on a flick faster than this (px/ms), after at least EDGE_FLICK_MIN px. */
export const EDGE_FLICK_VELOCITY = 0.45;
export const EDGE_FLICK_MIN = 32;
/** The committed swipe finishes in this long. */
export const EDGE_FINISH_MS = 200;

/** Sheets and full-screen modals: commit past this fraction of the height... */
export const SHEET_COMMIT_RATIO = 0.35;
/** ...or on a flick longer than this (px) and faster than this (px/ms). */
export const SHEET_FLICK_DISTANCE = 80;
export const SHEET_FLICK_VELOCITY = 0.5;
/** An uncommitted drag springs back in this long. */
export const SPRING_BACK_MS = 280;
/** Max upward lift of a sheet, px; beyond it the sheet resists asymptotically. */
export const LIFT_LIMIT = 60;

/** Pull to refresh triggers at this pull distance (px, as displayed). */
export const PULL_TRIGGER = 64;

/** How long a sample stays in the velocity window, ms. */
const VELOCITY_WINDOW_MS = 100;

type Sample = { t: number; v: number };

/** Tracks one axis and reports the velocity of the last 100 ms (px/ms). */
export class VelocityTracker {
  private samples: Sample[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(value: number): void {
    this.samples = [{ t: this.now(), v: value }];
  }

  add(value: number): void {
    const t = this.now();
    this.samples.push({ t, v: value });
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift();
  }

  /** px/ms over the window; positive = increasing value. 0 when unknown. */
  velocity(): number {
    const now = this.now();
    if (!this.samples.length || now - this.samples[this.samples.length - 1].t > VELOCITY_WINDOW_MS) return 0;
    const recent = this.samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
    const window = recent.length >= 2 ? recent : this.samples.slice(-2);
    if (window.length < 2) return 0;
    const first = window[0];
    const last = window[window.length - 1];
    const dt = last.t - first.t;
    return dt > 0 ? (last.v - first.v) / dt : 0;
  }
}

/** Asymptotic rubber band for a drag past a bound (never reaches `limit`). */
export function rubberBand(overshoot: number, limit: number = LIFT_LIMIT): number {
  const pull = Math.abs(overshoot);
  const eased = (pull * limit) / (pull + limit);
  return overshoot < 0 ? -eased : eased;
}

/** Edge swipe back: does the release commit? */
export function edgeSwipeCommits(dx: number, width: number, velocity: number): boolean {
  const projected = dx + velocity * 100;
  return projected > width * EDGE_COMMIT_RATIO || (dx > EDGE_FLICK_MIN && velocity > EDGE_FLICK_VELOCITY);
}

/** Sheet / full-screen modal drag down: does the release dismiss? */
export function sheetDragCommits(dy: number, height: number, velocity: number): boolean {
  return dy > 0 && (dy > height * SHEET_COMMIT_RATIO || (dy > SHEET_FLICK_DISTANCE && velocity > SHEET_FLICK_VELOCITY));
}

/** Release keeps the finger velocity, with a bounded deceleration to rest. */
export function edgeReleaseTiming(dx: number, width: number, velocity: number, commit: boolean): { duration: number; easing: string } {
  const distance = Math.max(1, commit ? width - dx : dx);
  const towardTarget = Math.max(0, commit ? velocity : -velocity);
  const duration = Math.round(Math.min(320, Math.max(120, distance / Math.max(0.8, towardTarget))));
  // The first Bezier slope matches release speed; a held drag begins at
  // rest. Clamp to a monotone curve so neither page overshoots its bound.
  const slope = Math.min(3, towardTarget * duration / distance);
  const firstY = Math.min(0.9, slope * 0.3);
  return { duration, easing: `cubic-bezier(0.3, ${firstY}, 0.25, 1)` };
}
