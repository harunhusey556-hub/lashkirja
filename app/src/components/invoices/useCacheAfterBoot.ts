"use client";

import { useEffect, useState } from "react";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { bootMobile } from "@/lib/mobile/boot";
import { readPageCache } from "@/lib/page-cache";

/**
 * The page cache as it is once the app has booted.
 *
 * On a cold launch a page mounts before `bootMobile()` has hydrated the
 * persistent cache from IndexedDB, so a `useState(readPageCache(...))`
 * initializer sees nothing and the skeleton shows although a cached copy
 * exists. This re-reads the key after boot; a page paints the value while its
 * own state is still loading (the fetch then replaces it as usual).
 */
export function useCacheAfterBoot<T>(key: string | null): T | null {
  const [late, setLate] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!IS_MOBILE_BUILD || !key) return;
    let alive = true;
    void bootMobile().then(() => {
      if (!alive) return;
      const value = readPageCache<T>(key);
      if (value !== null) setLate({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return late && late.key === key ? late.value : null;
}
