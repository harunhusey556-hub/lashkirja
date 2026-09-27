"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { Button } from "@/components/ui";
import { jobKindLabel, jobStatusLabel, workKindLabel } from "@/lib/job-labels";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";

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

export default function TyotPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [items, setItems] = useState<WorkRow[]>([]);
  const [filter, setFilter] = useState<(typeof WORK_FILTERS)[number]>("all");
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

  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-medium text-charcoal">Työt ja poikkeukset</h2>
        <p className="text-sm text-warm-gray">
          Pankkihaun, sähköpostin ja kuitin analysoinnin tila sekä avoimet poikkeukset.
        </p>
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger/10 rounded-xl px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <section className="bg-white rounded-3xl border border-warm-gray-light/30 shadow-sm p-4 space-y-3">
        <h3 className="text-sm font-semibold text-charcoal">Työt</h3>
        {loading && jobs.length === 0 ? (
          <p className="text-sm text-warm-gray">Ladataan…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-warm-gray">Ei taustatöitä.</p>
        ) : (
          <ul className="space-y-3">
            {jobs.map((job) => (
              <li key={job.id} className="rounded-2xl border border-warm-gray-light/40 px-3 py-3 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-charcoal break-words">{job.title}</p>
                  <p className="text-xs text-warm-gray shrink-0">{jobStatusLabel(job.status)}</p>
                </div>
                <p className="text-xs text-warm-gray">{jobKindLabel(job.kind)}</p>
                {job.progressLabel && <p className="text-xs text-warm-gray">{job.progressLabel}</p>}
                {job.error && <p className="text-xs text-danger">{job.error}</p>}
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
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-charcoal">Poikkeusjono</h3>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {WORK_FILTERS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={filter === kind}
              onClick={() => setFilter(kind)}
              className={`shrink-0 min-h-11 px-3 rounded-full text-xs font-medium border ${
                filter === kind
                  ? "bg-charcoal text-white border-charcoal"
                  : "bg-white text-charcoal border-warm-gray-light/50"
              }`}
            >
              {kind === "all" ? "Kaikki" : workKindLabel(kind)}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-warm-gray">Ei avoimia poikkeuksia.</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li key={item.id} className="bg-white rounded-2xl border border-warm-gray-light/30 px-3 py-3">
                <p className="text-xs text-warm-gray">{workKindLabel(item.kind)}</p>
                <p className="text-sm font-medium text-charcoal">{item.title}</p>
                <p className="text-xs text-warm-gray mt-1">{item.detail}</p>
                {item.href && (
                  <Link href={item.href} className="inline-flex min-h-11 items-center text-sm font-medium text-accent">
                    Avaa
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
