"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { sheetDragOffset } from "@/components/BottomSheet";

interface SheetDragOptions {
  /** Attach only while the surface is open. */
  active: boolean;
  /** The element that moves (carries the transform). */
  panelRef: RefObject<HTMLElement | null>;
  /** Where a drag may start, e.g. the header. Taps inside it still work. */
  handleRef: RefObject<HTMLElement | null>;
  /** Called once the drag has committed and the panel has left the screen. */
  onDismiss: () => void;
}

/** Commit thresholds shared with BottomSheet (SHELL-10). */
const COMMIT_RATIO = 0.35;
const FLICK_DISTANCE = 80;
const FLICK_VELOCITY = 0.5; // px/ms
const SPRING_BACK_MS = 280;
const DISMISS_MS = 240;

/**
 * Swipe-down-to-close for a full-height surface, the same feel as
 * BottomSheet: 1:1 tracking, an asymptotic resistance upward, a commit on
 * distance (35 % of the height) or on a flick (> 80 px at > 0.5 px/ms, from
 * the last 100 ms of movement), a 280 ms spring back otherwise.
 *
 * Returns `dragDismissed`: true once a drag closed the surface, so the
 * caller skips its CSS exit animation (the drag already moved it away).
 */
export function useSheetDrag({ active, panelRef, handleRef, onDismiss }: SheetDragOptions): {
  dragDismissed: boolean;
} {
  const [dragDismissed, setDragDismissed] = useState(false);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  // A fresh open starts undragged. Render-phase reset on the open transition.
  const [prevActive, setPrevActive] = useState(active);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) setDragDismissed(false);
  }

  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    const handle = handleRef.current;
    if (!panel || !handle) return;

    let startX = 0;
    let startY = 0;
    let dy = 0;
    let height = 1;
    let tracking = false;
    let decided = false;
    let samples: { t: number; y: number }[] = [];
    let suppressClickUntil = 0;
    let timer: number | null = null;

    const clearInline = () => {
      panel.style.transition = "";
      panel.style.transform = "";
      panel.style.willChange = "";
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      tracking = true;
      decided = false;
      dy = 0;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      height = panel.offsetHeight || 1;
      samples = [{ t: performance.now(), y: startY }];
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const x = event.touches[0].clientX;
      const y = event.touches[0].clientY;
      const moveX = x - startX;
      const moveY = y - startY;
      if (!decided) {
        if (Math.abs(moveY) < 6 && Math.abs(moveX) < 6) return;
        if (Math.abs(moveY) < Math.abs(moveX)) {
          tracking = false;
          return;
        }
        decided = true;
        if (timer !== null) window.clearTimeout(timer);
        panel.style.transition = "none";
        panel.style.willChange = "transform";
      }
      event.preventDefault();
      dy = sheetDragOffset(moveY);
      panel.style.transform = `translateY(${dy}px)`;
      const now = performance.now();
      samples.push({ t: now, y });
      samples = samples.filter((sample) => now - sample.t <= 100);
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      suppressClickUntil = performance.now() + 400;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const velocity = first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      const commit = dy > 0 && (dy > height * COMMIT_RATIO || (dy > FLICK_DISTANCE && velocity > FLICK_VELOCITY));
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!commit) {
        panel.style.transition = `transform ${SPRING_BACK_MS}ms var(--ease-drawer)`;
        panel.style.transform = "translateY(0)";
        timer = window.setTimeout(clearInline, SPRING_BACK_MS + 20);
        return;
      }
      setDragDismissed(true);
      if (reduceMotion) {
        clearInline();
        onDismissRef.current();
        return;
      }
      panel.style.transition = `transform ${DISMISS_MS}ms var(--ease-drawer)`;
      panel.style.transform = "translateY(100%)";
      timer = window.setTimeout(() => {
        onDismissRef.current();
      }, DISMISS_MS - 10);
    };

    const onClickCapture = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: false });
    handle.addEventListener("touchend", onTouchEnd);
    handle.addEventListener("touchcancel", onTouchEnd);
    handle.addEventListener("click", onClickCapture, true);
    return () => {
      handle.removeEventListener("touchstart", onTouchStart);
      handle.removeEventListener("touchmove", onTouchMove);
      handle.removeEventListener("touchend", onTouchEnd);
      handle.removeEventListener("touchcancel", onTouchEnd);
      handle.removeEventListener("click", onClickCapture, true);
      if (timer !== null) window.clearTimeout(timer);
      clearInline();
    };
  }, [active, panelRef, handleRef]);

  return { dragDismissed };
}
