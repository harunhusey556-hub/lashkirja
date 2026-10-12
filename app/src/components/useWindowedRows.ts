"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { computeWindow, WINDOW_THRESHOLD, type RowWindow } from "@/lib/window-rows";

const FALLBACK_ROW_HEIGHT = 64;

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

/**
 * Windowing for a list of more than `WINDOW_THRESHOLD` rows (no dependency):
 * attach `listRef` to the element that holds the rows, render
 * `rows.slice(start, end)` between `padTop` / `padBottom`, and the rest of a
 * thousand-row ledger is never mounted. A short list is returned whole and
 * attaches no listeners.
 */
export function useWindowedRows(count: number, threshold = WINDOW_THRESHOLD) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(FALLBACK_ROW_HEIGHT);
  const [view, setView] = useState<RowWindow>(() => computeWindow({
    count,
    rowHeight: FALLBACK_ROW_HEIGHT,
    listTop: 0,
    viewportHeight: 800,
    threshold,
  }));
  const windowed = count > threshold;

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const scroller = scrollParent(list);
    const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
    // The mean height of the rows currently mounted: rows with a wrapped second line are taller than the estimate.
    const rows = Array.from(list.children).filter((child) => (child as HTMLElement).dataset.windowPad === undefined);
    if (rows.length > 0) {
      const total = rows.reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
      if (total > 0) rowHeight.current = total / rows.length;
    }
    // The spacers live inside the list, so its own top edge is the list top.
    const listTop = list.getBoundingClientRect().top - scrollerTop;
    const next = computeWindow({ count, rowHeight: rowHeight.current, listTop, viewportHeight, threshold });
    setView((current) =>
      current.start === next.start && current.end === next.end && current.padTop === next.padTop && current.padBottom === next.padBottom
        ? current
        : next
    );
  }, [count, threshold]);

  useEffect(() => {
    const list = listRef.current;
    if (!windowed || !list) return;
    const scroller = scrollParent(list);
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [windowed, count, measure]);

  return { listRef, windowed, ...(windowed ? view : { start: 0, end: count, padTop: 0, padBottom: 0 }) };
}
