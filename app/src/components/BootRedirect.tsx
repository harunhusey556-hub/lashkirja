"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiUrl, IS_MOBILE_BUILD } from "@/lib/build-target";

/**
 * Renders on "/" only, on both targets.
 *
 * Web: `proxy.ts` already redirects an authenticated "/" to "/dashboard"
 * and an unauthenticated one to "/login" before this page's response ever
 * leaves the server, so this branch is a defensive fallback for the rare
 * case this component mounts anyway (e.g. a client-side navigation to "/",
 * or a cached document served without going through the proxy again).
 *
 * Mobile: there is no proxy in the bundled app -- this is the only gate.
 * Task 5 adds the real boot sequence (the Keychain token plus the cached
 * "shell-auth" payload, so a relaunch can paint instantly). Until then,
 * this probes the API with no credential; that always comes back
 * unauthorized, which is also the correct outcome for a first launch with
 * no stored session.
 */
export default function BootRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (!IS_MOBILE_BUILD) {
      router.replace("/dashboard");
      return;
    }

    let cancelled = false;
    fetch(apiUrl("/api/auth/me"), { credentials: "omit" })
      .then((response) => {
        if (cancelled) return;
        router.replace(response.ok ? "/dashboard" : "/login");
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
