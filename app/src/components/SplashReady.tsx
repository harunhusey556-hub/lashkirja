"use client";

import { useEffect } from "react";
import { hideSplashScreen, onFirstScreen } from "@/lib/splash";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

/**
 * Mounted once in the root layout, so it fires exactly once per app launch
 * (the root layout does not remount on client-side navigation).
 *
 * Web: unchanged -- hides on its own mount, two rAFs after render (the
 * first callback runs before the browser has painted the DOM this render
 * committed, the second is guaranteed to run after that paint).
 *
 * Mobile (Task 7): does not decide "first screen" on its own any more --
 * `AppShell` (children rendering) and `LoginForm` (its own mount) are the
 * two places that actually know, and each calls `markFirstScreen()` after
 * its own two-rAF guarantee. This component only listens and hides.
 */
export function SplashReady() {
  useEffect(() => {
    if (IS_MOBILE_BUILD) {
      return onFirstScreen(() => void hideSplashScreen());
    }
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void hideSplashScreen();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  return null;
}
