"use client";

import { usePathname } from "next/navigation";
import AppShell from "@/components/AppShell";

/**
 * One app chrome for the signed-in product. Login and the bank return page
 * stay outside it. Navigating between product routes does not remount the
 * header, tab bar, or chat — only the page body swaps.
 */
export default function ShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === "/login" || pathname.startsWith("/bank");
  if (bare) return children;
  return <AppShell>{children}</AppShell>;
}
