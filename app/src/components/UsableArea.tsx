"use client";

import { useLayoutEffect } from "react";
import { usableArea } from "@/lib/usable-area";

const STYLE_ID = "lashkirja-usable";

function readEnv(side: "top" | "bottom"): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:env(safe-area-inset-${side}, 0px)`;
  document.body.appendChild(probe);
  const value = parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${side}`)) || 0;
  probe.remove();
  return value;
}

/**
 * Publishes the one usable-area result as a head stylesheet. It does not
 * write style attributes onto <html>, so hydration stays stable.
 */
export function UsableArea() {
  useLayoutEffect(() => {
    const apply = () => {
      const vv = window.visualViewport;
      const area = usableArea({
        innerHeight: window.innerHeight,
        offsetTop: vv?.offsetTop ?? 0,
        viewportHeight: vv?.height ?? window.innerHeight,
        envTop: readEnv("top"),
        envBottom: readEnv("bottom"),
      });
      const css =
        `:root{--usable-top:${area.frameTop}px !important;` +
        `--usable-height:${area.frameHeight}px !important;` +
        `--safe-top:${area.safeTop}px !important;` +
        `--safe-bottom:${area.safeBottom}px !important}`;
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
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      delete document.documentElement.dataset.keyboard;
    };
  }, []);

  return null;
}
