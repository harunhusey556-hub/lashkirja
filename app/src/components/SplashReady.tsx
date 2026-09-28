"use client";

import { useEffect } from "react";
import { hideSplashScreen } from "@/lib/splash";

/**
 * Mounted once in the root layout, so it fires exactly once per app launch
 * (the root layout does not remount on client-side navigation) - whichever
 * screen paints first, the login page or the authenticated app shell, hides
 * the native splash. Two rAFs: the first callback runs before the browser
 * has painted the DOM this render committed, the second is guaranteed to run
 * after that paint.
 */
export function SplashReady() {
  useEffect(() => {
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
