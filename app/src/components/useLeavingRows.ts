"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Matches `--dur-exit`: how long `.row-leave` runs before the row is removed. */
export const ROW_EXIT_MS = 240;

/**
 * Rows on their way out of a list. `leave(id, done)` renders the row with
 * `.row-leave` (fade and fold) and calls `done` when the animation is over,
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
