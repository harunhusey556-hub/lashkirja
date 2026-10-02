"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const DURATION_MS = 220;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * A notice, error or note that comes and goes without shoving the page: it
 * unfolds from nothing when `show` turns on and folds away (still showing
 * its last content) when it turns off. Pixel heights through WAAPI, as in
 * Disclosure, because WebKit steps the CSS grid trick.
 */
export function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(show);
  const [last, setLast] = useState<ReactNode>(show ? children : null);
  const first = useRef(true);
  if (show && !mounted) setMounted(true);
  // Reduced motion: no fold to wait for, it simply goes.
  if (!show && mounted && reducedMotion()) setMounted(false);
  // Keep what was on screen while it folds away.
  if (show && children !== last) setLast(children);

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    const running = el.getAnimations();
    const reached = running.length > 0 ? el.getBoundingClientRect().height : null;
    running.forEach((animation) => {
      animation.onfinish = null;
      animation.cancel();
    });
    if (reducedMotion()) return;
    const full = el.scrollHeight;
    el.style.overflow = "hidden";
    const animation = el.animate(
      [
        { height: `${reached ?? (show ? 0 : full)}px`, opacity: show ? 0 : 1 },
        { height: `${show ? full : 0}px`, opacity: show ? 1 : 0 },
      ],
      { duration: DURATION_MS, easing: EASE, fill: show ? "none" : "forwards" }
    );
    animation.onfinish = () => {
      el.style.overflow = "";
      if (!show) setMounted(false);
    };
  }, [show]);

  if (!mounted) return null;
  return (
    <div ref={ref} aria-hidden={!show || undefined}>
      {show ? children : last}
    </div>
  );
}
