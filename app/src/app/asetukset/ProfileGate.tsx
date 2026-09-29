"use client";

import type { ReactNode } from "react";
import { ErrorState } from "@/components/AsyncState";
import { PageTitle, Skeleton, SkeletonCard, SkeletonGroup, useSkeletonFade } from "@/components/ds";
import { StaleBanner } from "@/components/ScreenState";
import { pageCacheFetchedAt } from "@/lib/page-cache";
import type { Profile } from "./useProfile";

/**
 * A settings form at its final shape while it loads (QUALITY-BAR L1): the
 * title, one card, `fields` label-and-input pairs and the button.
 */
export function SettingsFormSkeleton({ title, label, fields = 2 }: { title: string; label: string; fields?: number }) {
  return (
    <div className="space-y-6">
      <PageTitle title={title} />
      <SkeletonGroup label={label}>
        <SkeletonCard className="space-y-4">
          {Array.from({ length: fields }).map((_, index) => (
            <div key={index}>
              <Skeleton className="h-3 w-24" tone="soft" />
              <Skeleton className="mt-2 h-12 w-full" radius="card" />
            </div>
          ))}
          <Skeleton className="h-12 w-full" radius="card" />
        </SkeletonCard>
      </SkeletonGroup>
    </div>
  );
}

/**
 * The load states of every profile-backed settings page (AUTH-22):
 *  - no data yet: a skeleton at the final size, then a short cross-fade;
 *  - no data and the load failed: the Finnish failure card with a retry;
 *  - data from the cache and the refresh failed: the form stays, with the
 *    "Näytetään tallennettu versio" note and a retry, so an old copy is
 *    never painted as fresh.
 */
export function ProfileGate({
  profile,
  loadError,
  retry,
  title,
  skeletonLabel,
  fields,
  children,
}: {
  profile: Profile | null;
  loadError: string;
  retry: () => void;
  title: string;
  skeletonLabel: string;
  fields?: number;
  children: (profile: Profile) => ReactNode;
}) {
  const fade = useSkeletonFade(!profile && !loadError);

  if (!profile && loadError) {
    return (
      <div className="space-y-6">
        <PageTitle title={title} />
        <ErrorState message={loadError} onRetry={retry} />
      </div>
    );
  }
  if (!profile) return <SettingsFormSkeleton title={title} label={skeletonLabel} fields={fields} />;

  return (
    <div className={`space-y-6 ${fade}`.trim()}>
      {loadError && <StaleBanner fetchedAt={pageCacheFetchedAt("profile")} onRetry={retry} />}
      {children(profile)}
    </div>
  );
}
