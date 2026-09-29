"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const EXIT_MS = 170;

/**
 * The fixed action bar at the bottom of a detail or form screen
 * (SALES-29, BOOKS-20).
 *
 * - Opaque canvas with a top hairline: nothing ghosts through it.
 * - The in-flow spacer is exactly the bar's measured height, so the last
 *   field scrolls fully clear of the bar and no extra slack is added.
 * - Slides up on mount (220 ms, --ease-drawer). Pass `visible={false}` to
 *   slide it out (160 ms) instead of unmounting it abruptly.
 * - Publishes its height as `--app-bottom-bar` so toasts sit above it.
 */
export function BottomActions({ children, visible = true }: { children: ReactNode; visible?: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [mounted, setMounted] = useState(visible);
  const [leaving, setLeaving] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setMounted(true);
      setLeaving(false);
    } else {
      setLeaving(true);
    }
  }

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement;
    const publish = () => {
      const next = Math.ceil(bar.getBoundingClientRect().height);
      setHeight(next);
      root.style.setProperty("--app-bottom-bar", `${next}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--app-bottom-bar");
    };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <>
      <div aria-hidden style={{ height }} />
      <div
        ref={barRef}
        className="bottom-actions fixed inset-x-0 z-30 border-t border-line bg-canvas px-4 pt-3 md:left-[var(--app-sidebar-width,0px)]"
        style={{
          bottom: "var(--usable-bottom, 0px)",
          paddingBottom: "calc(12px + var(--safe-bottom, 0px))",
          transition: "transform 160ms var(--ease-drawer)",
          transform: leaving ? "translateY(100%)" : undefined,
        }}
      >
        <div className="mx-auto flex max-w-lg flex-col gap-2 md:max-w-3xl">{children}</div>
      </div>
    </>
  );
}
