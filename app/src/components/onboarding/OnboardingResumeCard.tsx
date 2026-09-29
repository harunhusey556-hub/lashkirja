"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import { Icon } from "@/components/ds/Icon";

/**
 * Shown on Koti while the onboarding is snoozed ("Ohita nyt"): one tap
 * reopens the conversation where it was left (the draft is kept).
 */
export function OnboardingResumeCard({ onResume }: { onResume: () => void }) {
  return (
    <button
      type="button"
      onClick={onResume}
      className="active-press animate-in mb-4 flex min-h-14 w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
      >
        <Icon icon={Sparkles} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-ink">Viimeistele yritysprofiili</span>
        <span className="block text-caption text-ink-2">Noin minuutti. ALV lasketaan profiilin mukaan.</span>
      </span>
      <Icon icon={ChevronRight} className="text-ink-2" />
    </button>
  );
}
