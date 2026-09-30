"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SkeletonList } from "@/components/AsyncState";

/**
 * Täsmäytys became the Pankki screen's "Vaatii toimia" view (owner report
 * 2026-09-30: every bank thing in one place). Receipts without a bank row are
 * the Kuitit list's own filter. Old links land here and move on.
 */
export default function TaydennysRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/pankki/tapahtumat?nayta=toimet");
  }, [router]);
  return <SkeletonList rows={6} />;
}
