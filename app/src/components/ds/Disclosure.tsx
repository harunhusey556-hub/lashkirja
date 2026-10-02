"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

const DURATION_MS = 220;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * An inline disclosure (search, filters, secondary details) that opens and
 * closes with height and opacity (C2, IA-23) instead of popping. The content
 * stays mounted; while closed it is inert (not focusable, not read by
 * VoiceOver). Pair the trigger's chevron with the same `open`.
 *
 * The height is animated in pixels with WAAPI: WebKit steps a
 * grid-template-rows transition (0fr to 1fr) instead of interpolating it, so
 * on the iPhone the panel jumped open and shut.
 */
export function Disclosure({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const openHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A reversal mid-way starts from the height it has reached; otherwise from
    // the other resting state (the new data-open already applies by now).
    const running = el.getAnimations();
    const reached = running.length > 0 ? el.getBoundingClientRect().height : null;
    running.forEach((animation) => animation.cancel());
    // The open height is what the panel rests at (the box itself, not its
    // scrollHeight, which counts the focus-ring room as overflow).
    if (open) openHeight.current = el.getBoundingClientRect().height;
    const full = openHeight.current ?? el.scrollHeight;
    const from = reached ?? (open ? 0 : full);
    const to = open ? full : 0;
    if (reduce || from === to) return;
    // Clipped while it moves, so the content never spills past the edge.
    el.style.overflow = "hidden";
    const animation = el.animate(
      [
        { height: `${from}px`, opacity: open ? 0 : 1 },
        { height: `${to}px`, opacity: open ? 1 : 0 },
      ],
      { duration: DURATION_MS, easing: EASE }
    );
    const settle = () => {
      el.style.overflow = "";
    };
    animation.onfinish = settle;
    animation.oncancel = settle;
  }, [open]);

  return (
    <div ref={ref} className={`disclosure ${className}`} data-open={open ? "true" : "false"} inert={!open}>
      <div className="disclosure-inner">{children}</div>
    </div>
  );
}
