"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { ConnectionNotice, EmptyNote, EmptySection, StaleBanner } from "@/components/ScreenState";
import { SectionSkeleton } from "@/components/books/Skeletons";
import { ActionPill, FilterChips, ListRow, PageTitle, Section, SkeletonGroup, StatusTag, useSkeletonFade } from "@/components/ds";
import { jobKindLabel, jobStatusLabel, workKindLabel } from "@/lib/job-labels";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";
import { normalizeLegacyDetailPath } from "@/lib/routes";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";

interface JobRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string | null;
  error: string | null;
  progressLabel: string | null;
  createdAt: string;
}

interface WorkRow {
  id: string;
  kind: string;
  title: string;
  detail: string;
  href: string | null;
  retryJobId?: string;
  /** All the identical failures this row stands for; one retry starts them all (F29). */
  retryJobIds?: string[];
}

interface TyotData {
  jobs: JobRow[];
  items: WorkRow[];
}

const WORK_FILTERS = [
  "all",
  "pending_review",
  "missing_document",
  "amount_mismatch",
  "corrupt_file",
  "link_error",
  "ambiguous_match",
  "payment_duplicate",
] as const;

type WorkFilter = (typeof WORK_FILTERS)[number];

// Must match TAKE in lib/work-queue.ts: each kind's query there is capped at
// this many rows, so a chip count sitting exactly on it may be an
// undercount, not the true total.
const WORK_QUEUE_TAKE = 40;

/** Finished jobs kept in view under the running ones (BOOKS-11). */
const RECENT_FINISHED = 3;

const JOB_STATUS_TONE: Record<string, "neutral" | "accent" | "danger" | "success" | "warning"> = {
  pending: "neutral",
  running: "accent",
  failed: "danger",
  done: "success",
  cancelled: "neutral",
};

const CACHE_KEY = "tyot";

function isActive(job: JobRow): boolean {
  return job.status === "pending" || job.status === "running";
}

/**
 * Jobs (BOOKS-11): what is running now plus the last few finished. A failed
 * analysis is listed once, in the exception queue with its retry, never twice.
 */
function visibleJobs(jobs: JobRow[]): JobRow[] {
  const active = jobs.filter(isActive);
  const finished = jobs.filter((job) => job.status === "done" || job.status === "cancelled").slice(0, RECENT_FINISHED);
  return [...active, ...finished];
}

export default function TyotPage() {
  const [fetchedData, setData] = useState<TyotData | null>(() => readPageCache<TyotData>(CACHE_KEY));
  // Cold launch: the cache is hydrated after this page mounted, so the copy
  // from the last session paints once it is readable instead of the skeleton (N3).
  const lateData = useCacheAfterBoot<TyotData>(CACHE_KEY);
  const data = fetchedData ?? lateData;
  const [loadError, setLoadError] = useState<unknown>(null);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [jobResponse, workResponse] = await Promise.all([apiFetch("/api/jobs"), apiFetch("/api/work-queue")]);
      const jobData = await readJson<{ jobs: JobRow[] }>(jobResponse, "Töiden lataus epäonnistui");
      const workData = await readJson<{ items: WorkRow[] }>(workResponse, "Huomioitavien lataus epäonnistui");
      const next = { jobs: jobData.jobs || [], items: workData.items || [] };
      writePageCache(CACHE_KEY, next);
      setData(next);
      setLoadError(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // "Not loaded" is not "empty" (BOOKS-16): the error is kept as is and
      // the page shows it instead of zero counts.
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount
    void load();
  }, [load]);

  // Poll only while a job is actually running (BOOKS-16), and only while the
  // page is visible; a finished page does not flicker every four seconds.
  const hasActiveJob = Boolean(data?.jobs.some(isActive));
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      window.clearInterval(timer);
      const delay = hasActiveJob ? pollDelay(document.visibilityState, 4000) : null;
      syncPageHiddenFlag(document.visibilityState === "hidden");
      if (delay == null) return;
      timer = window.setInterval(() => void load(), delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
      arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, hasActiveJob]);

  async function retry(jobIds: string[], rowId: string) {
    setRetryingId(rowId);
    try {
      for (const jobId of jobIds) {
        const response = await apiFetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
        if (!response.ok) await readJson(response, "Uudelleenyritys epäonnistui");
      }
      showToast({ tone: "success", text: "Luku käynnistettiin uudelleen." });
      await load();
    } catch (retryError: unknown) {
      if (isUnauthorized(retryError)) {
        redirectToLogin();
        return;
      }
      void hapticNotify("error");
      showToast({ tone: "error", text: errorMessage(retryError, "Uudelleenyritys epäonnistui") });
    } finally {
      setRetryingId(null);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);
  // Each kind is capped at WORK_QUEUE_TAKE rows server-side, so a kind whose
  // fetched count hits that cap gets a "+" (never presented as exact).
  const workChips = useMemo(() => {
    const chips = WORK_FILTERS.filter((kind) => kind !== "all").map((kind) => {
      const count = items.filter((item) => item.kind === kind).length;
      const capped = count >= WORK_QUEUE_TAKE;
      return { id: kind, label: workKindLabel(kind), count: capped ? `${count}+` : count, capped };
    });
    const anyCapped = chips.some((chip) => chip.capped);
    return [
      { id: "all" as const, label: "Kaikki", count: anyCapped ? `${items.length}+` : items.length },
      // Only kinds that have something: six zero chips say nothing.
      ...chips.filter((chip) => chip.count !== 0 || chip.id === filter),
    ];
  }, [items, filter]);
  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);
  const jobs = data ? visibleJobs(data.jobs) : [];
  const fade = useSkeletonFade(data === null && loadError === null);

  return (
    <div className="space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={() => load()} />
      <PageTitle title="Huomioitavat" subtitle="Tuonnit, haut ja niiden virheet." />

      {data === null && loadError != null ? (
        <ConnectionNotice error={loadError} fallback="Töiden lataus epäonnistui" onRetry={() => void load()} compact />
      ) : data === null ? (
        <SkeletonGroup label="Ladataan töitä" className="space-y-6">
          <SectionSkeleton rows={2} />
          <SectionSkeleton rows={4} />
        </SkeletonGroup>
      ) : (
        <div className={`space-y-6 ${fade}`}>
          {loadError != null && (
            <StaleBanner fetchedAt={pageCacheFetchedAt(CACHE_KEY)} onRetry={() => void load()} />
          )}

          {jobs.length === 0 ? (
            <EmptySection title="Työt">Ei käynnissä olevia töitä. Tuonnit ja haut näkyvät tässä, kun ne ovat kesken.</EmptySection>
          ) : (
          <Section title="Työt">
            {(
              jobs.map((job) => {
                const status = jobStatusLabel(job.status);
                const progress =
                  isActive(job) && job.progressLabel && job.progressLabel !== status ? ` · ${job.progressLabel}` : "";
                return (
                  <ListRow
                    key={job.id}
                    title={job.title}
                    secondary={`${jobKindLabel(job.kind)}${progress}`}
                    trailing={<StatusTag tone={JOB_STATUS_TONE[job.status] ?? "neutral"}>{status}</StatusTag>}
                  />
                );
              })
            )}
          </Section>
          )}

          {items.length === 0 ? (
            <EmptySection title="Korjattavat">Ei korjattavaa. Jos tuonti tai haku epäonnistuu, se näkyy tässä.</EmptySection>
          ) : (
          <div className="space-y-3">
            <h2 className="px-1 text-caption text-ink-2">Korjattavat</h2>
            <FilterChips label="Suodata huomioitavia" items={workChips} value={filter} onChange={setFilter} />

            {visible.length === 0 ? (
              <EmptyNote>Ei korjattavaa.</EmptyNote>
            ) : (
              <Section>
                {visible.map((item) => (
                  <ListRow
                    key={item.id}
                    title={item.title}
                    // The reason ends in the advice, so it is shown in full (F29).
                    secondary={`${workKindLabel(item.kind)} · ${item.detail}`}
                    secondaryLines="all"
                    trailing={
                      item.retryJobId ? (
                        <ActionPill
                          onClick={() => void retry(item.retryJobIds ?? [item.retryJobId!], item.retryJobId!)}
                          disabled={retryingId !== null}
                          ariaLabel={`Yritä uudelleen: ${item.title}`}
                        >
                          {retryingId === item.retryJobId ? "Käynnistetään…" : "Yritä uudelleen"}
                        </ActionPill>
                      ) : item.href ? (
                        <ActionPill href={normalizeLegacyDetailPath(item.href) ?? item.href}>Avaa</ActionPill>
                      ) : undefined
                    }
                  />
                ))}
              </Section>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
