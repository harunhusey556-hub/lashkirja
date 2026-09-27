"use client";

import { useRouter } from "next/navigation";
import { armNavigation } from "@/lib/nav-direction";

export function PageHeader({
  crumbs,
  backHref,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  backHref?: string;
}) {
  const router = useRouter();

  return (
    <div className="space-y-1">
      {backHref && (
        <button
          type="button"
          onClick={() => {
            armNavigation(backHref, "back");
            router.push(backHref);
          }}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent-dark active-press"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Takaisin
        </button>
      )}
      <nav aria-label="Murupolku" className="flex flex-wrap items-center gap-1 text-xs text-warm-gray">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && <span aria-hidden>/</span>}
            {crumb.href ? (
              <button
                type="button"
                onClick={() => {
                  armNavigation(crumb.href!, "back");
                  router.push(crumb.href!);
                }}
                className="min-h-11 text-warm-gray active-press"
              >
                {crumb.label}
              </button>
            ) : (
              <span className="text-charcoal">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>
    </div>
  );
}
