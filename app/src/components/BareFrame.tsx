"use client";

import { useEffect, useRef } from "react";

/**
 * The scroll frame for the pages outside the app shell (login, password
 * recovery, e-mail confirmation). `.bare-frame` (globals.css) is fixed to the
 * usable area, so the keyboard lifts it; this component adds the one thing CSS
 * cannot do: when a field takes focus, or the visual viewport changes because
 * the keyboard opened, the focused control is scrolled to the middle so it
 * and the button under it stay reachable (QUALITY-BAR F5).
 */
export function BareFrame({ children }: { children: React.ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let timer = 0;

    const reveal = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !frame.contains(active)) return;
      if (!active.matches("input, textarea, select")) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      active.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      // The keyboard animates for ~250 ms; measure after it settled.
      timer = window.setTimeout(reveal, 280);
    };

    frame.addEventListener("focusin", schedule);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    return () => {
      window.clearTimeout(timer);
      frame.removeEventListener("focusin", schedule);
      viewport?.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <div ref={frameRef} className="bare-frame">
      <div className="bare-fill">
        <div className="bare-content">{children}</div>
      </div>
    </div>
  );
}

/** The card every bare page shows: one place for the radius, border and padding. */
export const BARE_CARD_CLASS = "w-full space-y-5 rounded-card border border-line bg-surface p-6 sm:p-8";

/** A text link on a bare page: 44 px tall and pressable (QUALITY-BAR T1). */
export const BARE_LINK_CLASS = "active-press flex min-h-11 items-center justify-center text-sm text-accent";
