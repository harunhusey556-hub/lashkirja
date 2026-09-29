"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { FullScreenNotice } from "@/components/ScreenState";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("Sivun odottamaton virhe", error);
  }, [error]);

  // The shared failure card (VS-31): renders outside the app shell, so it carries its own canvas.
  return (
    <FullScreenNotice
      icon={TriangleAlert}
      body="Sivua ei voitu näyttää. Yritä hetken kuluttua uudelleen."
      actionLabel="Yritä uudelleen"
      onAction={unstable_retry}
    />
  );
}
