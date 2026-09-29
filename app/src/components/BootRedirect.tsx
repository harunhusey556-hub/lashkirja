"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { bootMobile } from "@/lib/mobile/boot";

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
 * bootMobile() reads the Keychain token (if any) rather than probing the
 * API with no credential (Task 4's placeholder): a stored token means an
 * instant "/dashboard" decision with no network round trip, and the app
 * shell (AppShell's own /api/auth/me check) still revalidates it for real.
 *
 * SHELL-25 (deliberately not an inline redirect): auth-client keeps a
 * synchronous sign-in flag (signed-in-flag.ts), but this page does not act
 * on it. (1) A location.replace('/dashboard') from an inline script in the
 * static index.html would loop: Capacitor's router (CapacitorRouter) answers
 * every path without a file extension with index.html. (2) Skipping the
 * bootMobile() wait client-side would also skip the page-cache hydration it
 * contains, and the dashboard would paint a skeleton instead of the cached
 * copy (N3, P1). Revisit with a Simulator run that can measure both.
 */
export default function BootRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (!IS_MOBILE_BUILD) {
      router.replace("/dashboard");
      return;
    }

    let cancelled = false;
    void bootMobile().then((result) => {
      if (cancelled) return;
      router.replace(result.signedIn ? "/dashboard" : "/login");
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
