"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { buttonClass } from "@/components/control-styles";

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

  // Same card as not-found.tsx: this renders outside the app shell, so it carries its own canvas.
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon icon={TriangleAlert} size="hero" />
        </div>
        <h1 className="text-xl font-semibold text-ink">Jokin meni pieleen</h1>
        <p className="mt-2 text-body text-ink-2">Sivua ei voitu näyttää. Yritä hetken kuluttua uudelleen.</p>
        <button type="button" onClick={unstable_retry} className={`mt-5 w-full ${buttonClass("primary")}`}>
          Yritä uudelleen
        </button>
      </div>
    </main>
  );
}
