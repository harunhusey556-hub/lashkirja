"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { Button } from "@/components/ui";
import { ActionPill, Card, FilterChips, ListRow, PageTitle, Section, StatusTag } from "@/components/ds";
import { jobKindLabel, jobStatusLabel, workKindLabel } from "@/lib/job-labels";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";
import { normalizeLegacyDetailPath } from "@/lib/routes";

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
}

const WORK_FILTERS = [
  "all",
  "pending_review",
  "missing_document",
  "amount_mismatch",
  "corrupt_file",
  "link_error",
  "ambiguous_match",
] as const;

type WorkFilter = (typeof WORK_FILTERS)[number];

// Must match TAKE in lib/work-queue.ts: each kind's query there is capped at
// this many rows, so a chip count sitting exactly on it may be an
// undercount, not the true total.
const WORK_QUEUE_TAKE = 40;

const JOB_STATUS_TONE: Record<string, "neutral" | "accent" | "danger" | "success" | "warning"> = {
  pending: "neutral",
  running: "accent",
  failed: "danger",
  done: "success",
  cancelled: "neutral",
};

export default function TyotPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [items, setItems] = useState<WorkRow[]>([]);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [jobResponse, workResponse] = await Promise.all([
        apiFetch("/api/jobs"),
        apiFetch("/api/work-queue"),
      ]);
      const jobData = await readJson<{ jobs: JobRow[] }>(jobResponse, "Töiden lataus epäonnistui");
      const workData = await readJson<{ items: WorkRow[] }>(workResponse, "Poikkeusten lataus epäonnistui");
      setJobs(jobData.jobs || []);
      setItems(workData.items || []);
    } catch (loadError: unknown) {
      if (isUnauthorized(loadError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(loadError, "Töiden lataus epäonnistui"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    const arm = () => {
      window.clearInterval(timer);
      const delay = pollDelay(document.visibilityState, 4000);
      syncPageHiddenFlag(delay == null);
      if (delay == null) return;
      timer = window.setInterval(() => {
        void load();
      }, delay);
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
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(id: string) {
    setRetryingId(id);
    setError("");
    try {
      const response = await apiFetch(`/api/jobs/${id}/retry`, { method: "POST" });
      if (!response.ok) await readJson(response, "Uudelleenyritys epäonnistui");
      await load();
    } catch (retryError: unknown) {
      if (isUnauthorized(retryError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(retryError, "Uudelleenyritys epäonnistui"));
    } finally {
      setRetryingId(null);
    }
  }

  // Each kind is capped at WORK_QUEUE_TAKE rows server-side (/api/work-queue
  // -> lib/work-queue.ts), so a kind whose fetched count hits that cap may
  // have more rows than shown; its chip (and "Kaikki", which sums the
  // kinds) gets a "+" so the count is never presented as exact when it
  // might not be.
  const workChips = useMemo(() => {
    const chips = WORK_FILTERS.filter((kind) => kind !== "all").map((kind) => {
      const count = items.filter((item) => item.kind === kind).length;
      const capped = count >= WORK_QUEUE_TAKE;
      return { id: kind, label: workKindLabel(kind), count: capped ? `${count}+` : count, capped };
    });
    const anyCapped = chips.some((chip) => chip.capped);
    return [
      { id: "all" as const, label: "Kaikki", count: anyCapped ? `${items.length}+` : items.length },
      ...chips,
    ];
  }, [items]);
  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);

  return (
    <div className="space-y-6">
      <PageTitle
        title="Työt ja poikkeukset"
        subtitle="Pankkihaun, sähköpostin ja kuitin analysoinnin tila sekä avoimet poikkeukset."
      />

      {error && (
        <p className="rounded-card bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <Card className="space-y-3">
        <h2 className="text-[13px] text-ink-2">Työt</h2>
        {loading && jobs.length === 0 ? (
          <p className="text-[13px] text-ink-2">Ladataan…</p>
        ) : jobs.length === 0 ? (
          <p className="text-[13px] text-ink-2">Ei taustatöitä.</p>
        ) : (
          <ul>
            {jobs.map((job, index) => (
              <li key={job.id} className={`space-y-1.5 py-3 ${index === 0 ? "pt-0" : "border-t border-line"}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 break-words text-[15px] font-medium text-ink">{job.title}</p>
                  <StatusTag tone={JOB_STATUS_TONE[job.status] ?? "neutral"}>
                    {jobStatusLabel(job.status)}
                  </StatusTag>
                </div>
                <p className="text-[13px] text-ink-2">{jobKindLabel(job.kind)}</p>
                {job.progressLabel && <p className="text-[13px] text-ink-2">{job.progressLabel}</p>}
                {job.error && <p className="text-[13px] text-danger">{job.error}</p>}
                {job.status === "failed" && job.kind === "document_analysis" && (
                  <Button
                    type="button"
                    variant="secondary"
                    busy={retryingId === job.id}
                    onClick={() => void retry(job.id)}
                  >
                    Yritä uudelleen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="space-y-3">
        <h2 className="px-1 text-[13px] text-ink-2">Poikkeusjono</h2>
        <FilterChips label="Suodata poikkeuksia" items={workChips} value={filter} onChange={setFilter} />

        {visible.length === 0 ? (
          <p className="px-1 text-[13px] text-ink-2">Ei avoimia poikkeuksia.</p>
        ) : (
          <Section>
            {visible.map((item) => (
              <ListRow
                key={item.id}
                title={item.title}
                secondary={`${workKindLabel(item.kind)} · ${item.detail}`}
                trailing={
                  item.href ? (
                    <ActionPill href={normalizeLegacyDetailPath(item.href) ?? item.href}>Avaa</ActionPill>
                  ) : undefined
                }
              />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
