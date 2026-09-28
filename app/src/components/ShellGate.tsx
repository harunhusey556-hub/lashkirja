"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import AppShell from "@/components/AppShell";
import { appNavigate } from "@/lib/app-nav";
import { clearBankAuth, watchBankDeepLink } from "@/lib/open-bank-auth";

/**
 * One app chrome for the signed-in product. Login and the bank return page
 * stay outside it. Navigating between product routes does not remount the
 * header, tab bar, or chat — only the page body swaps.
 */
export default function ShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    void watchBankDeepLink((path) => {
      clearBankAuth();
      const here = `${window.location.pathname}${window.location.search}`;
      if (here === path) return;
      appNavigate(path);
    }).then((unsub) => {
      if (cancelled) unsub();
      else stop = unsub;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const bare =
    // "/" is the boot page (BootRedirect): it decides where to go before
    // any shell chrome is relevant, and does its own auth probe. Routing it
    // through AppShell too would run a second, redundant session check and
    // -- on the mobile export, where AppShell's own check is not yet wired
    // through apiUrl() (Task 5/6) -- shows AppShell's error screen instead
    // of ever letting BootRedirect mount (Task 4).
    pathname === "/" ||
    pathname === "/login" ||
    pathname.startsWith("/bank") ||
    pathname.startsWith("/unohtunut-salasana") ||
    pathname.startsWith("/palauta-salasana") ||
    pathname.startsWith("/vahvista-sahkoposti");
  if (bare) return children;
  return <AppShell>{children}</AppShell>;
}
