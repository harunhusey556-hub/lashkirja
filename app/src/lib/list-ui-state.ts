"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Session-scoped list UI-state cache — filters, search text, active tab,
 * scroll position.
 *
 * Distinct from `page-cache.ts`, which only holds fetched *data*: this holds
 * the control state a list page renders with, so that navigating back to it
 * (browser back, iOS edge-swipe back) restores the exact filters/search/tab
 * the user had instead of resetting the page to its defaults.
 *
 * sessionStorage rather than the in-memory page-cache Map: the iOS Capacitor
 * shell can reload the webview after being backgrounded for a while, which
 * would otherwise silently drop filters along with everything else in JS
 * memory. sessionStorage survives that; it does not survive closing the tab
 * (or force-quitting the app), which is the right lifetime for "what was I
 * looking at" state.
 */

function storageKey(key: string): string {
  return `list-ui:${key}`;
}

function readRaw<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeRaw<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Storage full or unavailable (private browsing) — state just won't persist.
  }
}

/**
 * Drop-in replacement for `useState` whose value survives a remount driven
 * by back/forward navigation. Use for one filter/search/tab field at a time
 * so each page's existing state shape stays unchanged.
 */
export function usePersistedState<T>(
  key: string,
  initial: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readRaw<T>(key) ?? initial);
  useEffect(() => {
    writeRaw(key, state);
  }, [key, state]);
  return [state, setState];
}

/** The document is locked. Lists scroll inside the shell's content pane. */
function appScroller(): HTMLElement | null {
  const node = document.querySelector(".app-main");
  return node instanceof HTMLElement ? node : null;
}

/**
 * Restores scroll position once the list has finished its first load
 * (`ready`), and keeps saving it as the user scrolls so back-navigation
 * lands where they left off rather than at the top.
 */
export function useScrollRestoration(key: string, ready: boolean): void {
  const restored = useRef(false);

  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const saved = readRaw<number>(key);
    const scroller = appScroller();
    if (saved && saved > 0 && scroller) {
      // Wait one frame so the restored list has actually painted before we
      // scroll to a position that only exists once it has.
      requestAnimationFrame(() => {
        scroller.scrollTop = saved;
      });
    }
  }, [ready, key]);

  useEffect(() => {
    const scroller = appScroller();
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => writeRaw(key, scroller.scrollTop));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      writeRaw(key, scroller.scrollTop);
    };
  }, [key]);
}
