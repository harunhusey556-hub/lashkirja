"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** Chart keys that already played their grow-in during this app session. */
const played = new Set<string>();

/**
 * True for the first paint of a chart only. With an `animateKey` the chart also
 * stays still when the person comes back to the screen later in the session
 * (Koti is opened many times a day; a chart that grows every time is noise).
 * Without a key it plays once per mount. Reduced motion is handled in CSS.
 */
export function useGrowOnce(animateKey?: string): boolean {
  const [animate] = useState(() => (animateKey === undefined ? true : !played.has(animateKey)));
  useEffect(() => {
    if (animateKey !== undefined) played.add(animateKey);
  }, [animateKey]);
  return animate;
}

/** For tests: forget which charts have played. */
export function resetGrowOnce(): void {
  played.clear();
}

/**
 * Width of an element in px (0 until measured) and the computed font size of a
 * label element inside it. The observer fires before the first paint, so the
 * chart lays out once at its real size.
 */
export function useChartSize(
  boxRef: RefObject<HTMLElement | null>,
  fontRef?: RefObject<HTMLElement | null>,
): { width: number; fontPx: number } {
  const [size, setSize] = useState({ width: 0, fontPx: 11 });
  const sizeRef = useRef(size);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const width = Math.round(box.getBoundingClientRect().width);
      const target = fontRef?.current ?? box;
      const fontPx = parseFloat(getComputedStyle(target).fontSize) || 11;
      if (width !== sizeRef.current.width || fontPx !== sizeRef.current.fontPx) {
        sizeRef.current = { width, fontPx };
        setSize(sizeRef.current);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, fontRef]);
  return size;
}
