"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Matches `--dur-exit`: how long `.row-leave` runs before the row is removed. */
export const ROW_EXIT_MS = 240;

/**
 * Rows on their way out of a list. `leave(id, done)` folds the row marked
 * `data-leave-key={id}` and renders it with `.row-leave` (no taps), then calls
 * `done` when the animation is over,
 * where the caller removes the row for real. `delay` lets a closing sheet get
 * out of the way first, so the owner sees the row go.
 */
export function useLeavingRows() {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  }, []);

  const leave = useCallback(
    (id: string, done: () => void, delay = 0) => {
      const start = () => {
        setLeaving((current) => new Set(current).add(id));
        // The fold runs on the row's pixel height (WAAPI): WebKit steps the
        // old grid-template-rows animation, so on the iPhone rows just vanished.
        const row =
          typeof document !== "undefined"
            ? document.querySelector<HTMLElement>(`[data-leave-key="${CSS.escape(id)}"]`)
            : null;
        const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (row && typeof row.animate === "function") {
          row.style.overflow = "hidden";
          row.animate(
            reduce
              ? [{ opacity: 1 }, { opacity: 0 }]
              : [
                  { height: `${row.offsetHeight}px`, opacity: 1 },
                  { height: "0px", opacity: 0 },
                ],
            { duration: ROW_EXIT_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" }
          );
        }
        later(() => {
          setLeaving((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          done();
        }, ROW_EXIT_MS);
      };
      if (delay > 0) later(start, delay);
      else start();
    },
    [later]
  );

  return { leaving, leave };
}
