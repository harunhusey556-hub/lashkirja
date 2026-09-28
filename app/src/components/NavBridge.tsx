"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setAppRouter } from "@/lib/app-nav";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

/**
 * Publishes the App Router's client-side router to app-nav.ts so
 * module-level code outside the component tree (clientFetch.ts,
 * auth-client.ts) can navigate without a document reload. Mounted once in
 * layout.tsx. A no-op on the web build: appNavigate() never reads the
 * published router there.
 */
export function NavBridge() {
  const router = useRouter();

  useEffect(() => {
    if (!IS_MOBILE_BUILD) return;
    setAppRouter(router);
    return () => setAppRouter(null);
  }, [router]);

  return null;
}
