"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hapticImpact } from "@/lib/haptics";
import { PULL_TRIGGER, rubberBand, VelocityTracker } from "@/lib/gesture";

/** Height the spinner holds while the reload runs, px. */
const HOLD = 48;
/** The spinner stays at least this long, so a cache hit still reads as a refresh. */
const MIN_SPIN_MS = 500;
/** And at most this long, whatever the page does. */
const MAX_SPIN_MS = 8000;

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function pageBusy(main: HTMLElement): boolean {
  return Boolean(main.querySelector('.app-page .skeleton, .app-page [aria-busy="true"]'));
}

/**
 * Pull to refresh on a server-fed list (C1.6, IA-24, R24). Render it once
 * anywhere in the page; it attaches to the shell's scroller (.app-main):
 *
 *   <PullToRefresh onRefresh={retry} />
 *
 * `onRefresh` is the SAME reload the page's "Yritä uudelleen" runs. It may
 * return a promise; if it does not, the spinner stays until the page has no
 * skeleton or aria-busy region left (at least 0.5 s, at most 8 s).
 *
 * The pull starts only at the top (scrollTop <= 1: the always-bounce range
 * of C1.1). It triggers at 64 px with a light impact haptic. On iOS the
 * native rubber band moves the content and reveals the spinner above it;
 * elsewhere the page is moved by the shared rubber band. While refreshing,
 * a 48 px band holds the spinner in view above the content.
 */
export function PullToRefresh({ onRefresh, disabled = false }: { onRefresh: () => unknown; disabled?: boolean }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });
  const refreshingRef = useRef(false);

  // The band lives at the very top of <main>, before the page, so it adds no
  // gap to the page's own layout and scrolls with the content.
  useEffect(() => {
    const main = markerRef.current?.closest<HTMLElement>(".app-main");
    if (!main) return;
    const band = document.createElement("div");
    band.className = "ptr-band";
    main.insertBefore(band, main.firstChild);
    setHost(band);
    return () => {
      band.remove();
      setHost(null);
    };
  }, []);

  useEffect(() => {
    const main = markerRef.current?.closest<HTMLElement>(".app-main");
    const page = markerRef.current?.closest<HTMLElement>(".app-page");
    if (!main || !page || disabled) return;
    const nativeBounce = isIOS();
    const tracker = new VelocityTracker();
    let startY = 0;
    let tracking = false;
    let armed = false;
    let pull = 0;

    const paint = (distance: number) => {
      const indicator = indicatorRef.current;
      if (!indicator) return;
      const progress = Math.min(1, distance / PULL_TRIGGER);
      indicator.style.setProperty("--ptr-progress", String(progress));
      indicator.dataset.armed = armed ? "true" : "false";
    };

    const reset = () => {
      tracking = false;
      armed = false;
      pull = 0;
      if (!nativeBounce) {
        page.style.transition = "transform 280ms var(--ease-drawer)";
        page.style.transform = "";
        window.setTimeout(() => {
          page.style.transition = "";
        }, 300);
      }
      paint(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (refreshingRef.current || event.touches.length !== 1) return;
      if (main.scrollTop > 1 || main.dataset.scrollLock === "true") return;
      if (event.touches[0].clientX <= 24) return; // the edge swipe owns the left edge
      tracking = true;
      armed = false;
      startY = event.touches[0].clientY;
      tracker.reset(startY);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      const y = event.touches[0].clientY;
      tracker.add(y);
      const dy = y - startY;
      if (dy <= 0 && pull === 0) {
        tracking = false;
        return;
      }
      // Displayed distance: the native bounce where the platform reports it,
      // otherwise our own rubber band on the page.
      pull = nativeBounce ? Math.max(-main.scrollTop, rubberBand(Math.max(0, dy), 140)) : rubberBand(Math.max(0, dy), 140);
      if (!nativeBounce) page.style.transform = `translateY(${pull}px)`;
      if (!armed && pull >= PULL_TRIGGER) {
        armed = true;
        void hapticImpact("light");
      } else if (armed && pull < PULL_TRIGGER * 0.75) {
        armed = false;
      }
      paint(pull);
    };

    const onTouchEnd = () => {
      if (!tracking) return;
      const fire = armed;
      reset();
      if (!fire) return;
      refreshingRef.current = true;
      setRefreshing(true);
      const started = performance.now();
      let result: unknown;
      try {
        result = onRefreshRef.current();
      } catch {
        result = undefined;
      }
      const finish = () => {
        refreshingRef.current = false;
        setRefreshing(false);
      };
      const waitIdle = () => {
        const elapsed = performance.now() - started;
        if (elapsed >= MAX_SPIN_MS || (elapsed >= MIN_SPIN_MS && !pageBusy(main))) finish();
        else window.setTimeout(waitIdle, 120);
      };
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>)
          .catch(() => {})
          .then(() => window.setTimeout(finish, Math.max(0, MIN_SPIN_MS - (performance.now() - started))));
      } else {
        // Give the page a frame to show its loading state first.
        window.setTimeout(waitIdle, 120);
      }
    };

    main.addEventListener("touchstart", onTouchStart, { passive: true });
    main.addEventListener("touchmove", onTouchMove, { passive: true });
    main.addEventListener("touchend", onTouchEnd);
    main.addEventListener("touchcancel", reset);
    return () => {
      main.removeEventListener("touchstart", onTouchStart);
      main.removeEventListener("touchmove", onTouchMove);
      main.removeEventListener("touchend", onTouchEnd);
      main.removeEventListener("touchcancel", reset);
      page.style.transform = "";
      page.style.transition = "";
    };
  }, [disabled]);

  // While it refreshes, the spinner and the page sit HOLD px down, by
  // transform only: the old 0 to 48 px height change re-laid out the whole
  // page on every frame, which stuttered on the iPhone.
  useEffect(() => {
    const page = markerRef.current?.closest<HTMLElement>(".app-page");
    const indicator = indicatorRef.current;
    if (!page || !indicator) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transition = reduce ? "none" : "transform 220ms var(--ease-drawer)";
    const offset = refreshing ? `translateY(${HOLD}px)` : "";
    for (const el of [page, indicator]) {
      el.style.transition = transition;
      el.style.transform = offset;
    }
    if (refreshing) return;
    const timer = window.setTimeout(() => {
      for (const el of [page, indicator]) el.style.transition = "";
    }, 240);
    return () => window.clearTimeout(timer);
  }, [refreshing, host]);

  return (
    <>
      <span ref={markerRef} hidden />
      {host
        ? createPortal(
            <div
              ref={indicatorRef}
              className="ptr-indicator"
              data-refreshing={refreshing ? "true" : "false"}
            >
              <span className="ptr-spinner" aria-hidden />
              {refreshing ? <span className="sr-only" role="status">Päivitetään…</span> : null}
            </div>,
            host
          )
        : null}
    </>
  );
}
