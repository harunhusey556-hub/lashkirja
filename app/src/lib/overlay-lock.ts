"use client";

import { useEffect } from "react";

/**
 * While a sheet, chat panel, or dialog is open, the shell chrome and the
 * page scroller ignore hits. A counter keeps a second overlay from unlocking
 * the first one when it closes.
 *
 * AX-10, R6: everything that is not an open overlay (or on the path to one)
 * is also made `inert`, so VoiceOver and the keyboard cannot reach the page
 * behind it. Overlay roots are `.overlay-root` (BottomSheet, ConfirmModal)
 * or `[data-overlay-root]` (the assistant and onboarding surfaces). Page
 * sheets render inside `.app-main`, so the page is not blanket-inerted:
 * only the siblings along each overlay's ancestor chain are. Toasts stay
 * live (an Undo must stay reachable).
 */

const OVERLAY_SELECTOR = ".overlay-root, [data-overlay-root]";
const NEVER_INERT = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE"]);

let inerted: HTMLElement[] = [];

function releaseInert(): void {
  for (const element of inerted) element.inert = false;
  inerted = [];
}

function applyInert(): void {
  releaseInert();
  const roots = Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR));
  if (roots.length === 0) return;
  const keep = new Set<Element>();
  for (const root of roots) {
    for (let node: Element | null = root; node; node = node.parentElement) keep.add(node);
  }
  for (const root of roots) {
    for (let node: Element | null = root; node && node !== document.body; node = node.parentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (keep.has(sibling) || !(sibling instanceof HTMLElement)) continue;
        if (NEVER_INERT.has(sibling.tagName) || sibling.inert) continue;
        if (sibling.matches(".toast-viewport, [aria-live]")) continue;
        sibling.inert = true;
        inerted.push(sibling);
      }
    }
  }
}

export function useOverlayLock(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const frame = document.querySelector(".app-frame");
    if (!(frame instanceof HTMLElement)) {
      applyInert();
      return () => applyInert();
    }
    const count = Number(frame.dataset.overlayCount || "0") + 1;
    frame.dataset.overlayCount = String(count);
    frame.dataset.overlay = "open";
    const main = frame.querySelector(".app-main");
    if (main instanceof HTMLElement) main.dataset.scrollLock = "true";
    document.dispatchEvent(new Event("lashkirja-dismiss-press"));
    applyInert();
    return () => {
      const next = Number(frame.dataset.overlayCount || "1") - 1;
      if (next > 0) {
        frame.dataset.overlayCount = String(next);
        // Another overlay is still open: recompute for it (this one is
        // leaving; its node may still be animating out).
        applyInert();
        return;
      }
      delete frame.dataset.overlayCount;
      delete frame.dataset.overlay;
      if (main instanceof HTMLElement) delete main.dataset.scrollLock;
      releaseInert();
    };
  }, [open]);
}
