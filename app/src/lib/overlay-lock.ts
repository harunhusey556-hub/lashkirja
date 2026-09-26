"use client";

import { useEffect } from "react";

/**
 * While a sheet, chat panel, or dialog is open, the shell chrome and the
 * page scroller ignore hits. A counter keeps a second overlay from unlocking
 * the first one when it closes.
 */
export function useOverlayLock(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const frame = document.querySelector(".app-frame");
    if (!(frame instanceof HTMLElement)) return;
    const count = Number(frame.dataset.overlayCount || "0") + 1;
    frame.dataset.overlayCount = String(count);
    frame.dataset.overlay = "open";
    const main = frame.querySelector(".app-main");
    if (main instanceof HTMLElement) main.dataset.scrollLock = "true";
    document.dispatchEvent(new Event("lashkirja-dismiss-press"));
    return () => {
      const next = Number(frame.dataset.overlayCount || "1") - 1;
      if (next > 0) {
        frame.dataset.overlayCount = String(next);
        return;
      }
      delete frame.dataset.overlayCount;
      delete frame.dataset.overlay;
      if (main instanceof HTMLElement) delete main.dataset.scrollLock;
    };
  }, [open]);
}
