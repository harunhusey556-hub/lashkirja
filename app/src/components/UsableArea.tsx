"use client";

import { useLayoutEffect } from "react";
import { usableArea } from "@/lib/usable-area";

const STYLE_ID = "lashkirja-usable";

function editableFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el.matches("input, textarea, select");
}

/**
 * Publishes frame anchors and safe-area fallbacks from a head stylesheet.
 * It does not write style attributes onto <html>, so hydration stays stable,
 * and it does not replace env(safe-area-inset-*) with a pixel guess.
 */
export function UsableArea() {
  useLayoutEffect(() => {
    const apply = () => {
      const vv = window.visualViewport;
      const area = usableArea({
        innerHeight: window.innerHeight,
        offsetTop: vv?.offsetTop ?? 0,
        viewportHeight: vv?.height ?? window.innerHeight,
        editableFocused: editableFocused(),
      });
      const css =
        `:root{--usable-top:${area.frameTop}px !important;` +
        `--usable-bottom:${area.frameBottom}px !important;` +
        `--safe-top-fallback:${area.safeTopFallback}px !important;` +
        `--safe-bottom-fallback:${area.safeBottomFallback}px !important}`;
      let tag = document.getElementById(STYLE_ID);
      if (!tag) {
        tag = document.createElement("style");
        tag.id = STYLE_ID;
        document.head.appendChild(tag);
      }
      if (tag.textContent !== css) tag.textContent = css;
      document.documentElement.dataset.keyboard = area.keyboardOpen ? "open" : "closed";
    };

    apply();
    const later = window.setTimeout(apply, 300);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", apply);
    return () => {
      window.clearTimeout(later);
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      document.getElementById(STYLE_ID)?.remove();
      delete document.documentElement.dataset.keyboard;
    };
  }, []);

  return null;
}
