"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LoadingState, SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatEur } from "@/lib/format";

import { INVOICE_LINKS, WorkspaceLinks, linksWithActive } from "@/components/WorkspaceLinks";
import { Button, buttonClass, chipClass } from "@/components/ui";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { isForbidden } from "@/lib/screen-state";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
interface InvoiceSummary {
  id: string;
  number: number;
  reference: string;
  status: string;
  displayStatus: "draft" | "sent" | "paid" | "credited" | "overdue";
  issueDate: string;
  dueDate: string;
  gross: number;
  open: number;
  customer: { id: string; name: string };
}

interface Aging {
  buckets: Record<string, { count: number; openCents: number }>;
  totalOpen: number;
  overdue: number;
  overdueCount: number;
}

const STATUS_LABEL: Record<InvoiceSummary["displayStatus"], string> = {
  draft: "Luonnos",
  sent: "Lähetetty",
  overdue: "Myöhässä",
  paid: "Maksettu",
  credited: "Hyvitetty",
};

const STATUS_CLASS: Record<InvoiceSummary["displayStatus"], string> = {
  draft: "bg-warm-gray-light/30 text-warm-gray",
  sent: "bg-blush text-accent-dark",
  overdue: "bg-danger/10 text-danger",
  paid: "bg-success/10 text-success",
  credited: "bg-warm-gray-light/30 text-warm-gray",
};

const FILTERS = [
  { id: "all", label: "Kaikki" },
  { id: "draft", label: "Luonnokset" },
  { id: "sent", label: "Lähetetyt" },
  { id: "overdue", label: "Myöhässä" },
  { id: "paid", label: "Maksetut" },
] as const;

/**
 * useSearchParams opts the tree out of static rendering, so the reader lives
 * behind a Suspense boundary and the page itself stays prerenderable.
 */
export default function InvoicesPage() {
  return (
    <Suspense
      fallback={
        <>
          <LoadingState label="Haetaan laskuja…" />
        </>
      }
    >
      <InvoicesPageContent />
    </Suspense>
  );
}

function InvoicesPageContent() {
  const searchParams = useSearchParams();
  const customerFilter = searchParams.get("customerId") ?? "";
  const monthFilter = /^\d{4}-(0[1-9]|1[0-2])$/.test(searchParams.get("month") || "")
    ? searchParams.get("month")!
    : "";
  const statusFromUrl = searchParams.get("status");

  // The cache only ever holds the unfiltered list, so a customer-scoped link
  // must not paint it as if it were the filtered result.
  const cached =
    customerFilter || monthFilter
      ? null
      : readPageCache<{ invoices: InvoiceSummary[]; aging: Aging }>("invoices");
  const [invoices, setInvoices] = useState<InvoiceSummary[]>(cached?.invoices ?? []);
  const [aging, setAging] = useState<Aging | null>(cached?.aging ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Persisted (not just in-memory) so back-navigation restores the active
  // tab instead of resetting the list to "Kaikki".
  const [filter, setFilter] = usePersistedState<(typeof FILTERS)[number]["id"]>(
    "laskut.filter",
    "all"
  );
  useEffect(() => {
    if (statusFromUrl && FILTERS.some((item) => item.id === statusFromUrl)) {
      setFilter(statusFromUrl as (typeof FILTERS)[number]["id"]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFromUrl]);
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // `signal` is only ever passed by the mount/filter-change effect below —
  // manual call sites (retry button, post-mutation refresh) call load() with
  // no signal so they are never cancelled out from under themselves.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (customerFilter) params.set("customerId", customerFilter);
      if (monthFilter) params.set("month", monthFilter);
      const response = await apiFetch(`/api/invoices?${params.toString()}`, {
        credentials: "include",
        signal,
      });
      const data = await readJson<{ invoices: InvoiceSummary[]; aging: Aging }>(
        response,
        "Laskujen haku epäonnistui"
      );
      if (signal?.aborted) return;
      if (filter === "all" && !customerFilter && !monthFilter) writePageCache("invoices", data);
      setInvoices(data.invoices);
      setAging(data.aging);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setMessage(errorMessage(error, "Laskujen haku epäonnistui"));
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [filter, customerFilter, monthFilter]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useScrollRestoration("laskut", status === "ready");

  async function runBankMatch() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/invoices/match", {
        method: "POST",
        credentials: "include",
      });
      const result = await readJson<{
        applied: unknown[];
        suggestions: unknown[];
      }>(response, "Kohdistus epäonnistui");
      setMessage(
        `Kohdistettiin ${result.applied.length} maksua viitenumerolla. ` +
          `${result.suggestions.length} mahdollista osumaa vaatii tarkistuksen.`
      );
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Kohdistus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <p className="text-sm text-warm-gray leading-relaxed">
            Laskuta asiakkaita ja seuraa maksuja viitenumerolla.
          </p>
          <WorkspaceLinks items={linksWithActive(INVOICE_LINKS, "/laskut")} />
        </header>

        {aging && (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
            <p className="text-sm text-warm-gray">Avoimet saatavat</p>
            <p className="text-3xl font-semibold text-charcoal tracking-tight">
              {formatEur(aging.totalOpen)}
            </p>
            {aging.overdueCount > 0 && (
              <p className="text-xs text-danger">
                {formatEur(aging.overdue)} myöhässä ({aging.overdueCount} laskua)
              </p>
            )}
            <div className="grid grid-cols-4 gap-2 pt-1 text-center">
              {["1-30", "31-60", "61-90", "90+"].map((bucket) => (
                <div key={bucket} className="rounded-xl bg-cream/70 py-2">
                  <p className="text-[11px] text-warm-gray">{bucket} pv</p>
                  <p className="text-xs font-medium text-charcoal">
                    {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {message && (
          <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
            {message}
          </p>
        )}

        <div className="flex gap-3">
          <Link
            href={customerFilter ? `/laskut/uusi?customerId=${encodeURIComponent(customerFilter)}` : "/laskut/uusi"}
            className={`${buttonClass()} flex-1`}
          >
            Uusi lasku
          </Link>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void runBankMatch()}
            busy={busy}
            busyLabel="Kohdistetaan…"
          >
            Kohdista maksut
          </Button>
        </div>

        <div className="flex gap-2 overflow-x-auto scrollbar-none">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              aria-pressed={filter === entry.id}
              className={chipClass(filter === entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("invoices")} onRetry={() => void load()} />
        )}
        {status === "loading" && <SkeletonList rows={4} />}
        {status === "error" &&
          (isForbidden(loadFailure) ? (
            <EmptyState kind="forbidden" />
          ) : (
            <ConnectionNotice
              error={loadFailure}
              fallback={message || "Laskujen haku epäonnistui"}
              onRetry={() => void load()}
            />
          ))}

        {status === "ready" && (
          <ul className="space-y-3 list-stagger">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <Link
                  href={`/laskut/${invoice.id}`}
                  className="block bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-5 space-y-2 hover:border-accent/20"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-medium text-charcoal truncate">
                        {invoice.customer.name}
                      </p>
                      <p className="text-xs text-warm-gray">
                        Lasku {invoice.number} · {formatDate(invoice.issueDate)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-base font-semibold text-charcoal">
                        {formatEur(invoice.gross)}
                      </p>
                      {invoice.open !== 0 && invoice.open !== invoice.gross && (
                        <p className="text-[11px] text-warm-gray">
                          avoinna {formatEur(invoice.open)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${
                        STATUS_CLASS[invoice.displayStatus]
                      }`}
                    >
                      {STATUS_LABEL[invoice.displayStatus]}
                    </span>
                    <span className="text-[11px] text-warm-gray">
                      Eräpäivä {formatDate(invoice.dueDate)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}

            {invoices.length === 0 && (
              <EmptyState
                kind={filter !== "all" || customerFilter ? "filtered" : "records"}
                title={filter !== "all" || customerFilter ? "Ei laskuja tällä suodattimella" : "Ei laskuja vielä"}
                body={
                  filter !== "all" || customerFilter
                    ? "Kokeile toista suodatinta."
                    : "Luo ensimmäinen myyntilasku."
                }
                onClear={
                  filter !== "all" || customerFilter ? () => setFilter("all") : undefined
                }
                clearLabel="Tyhjennä suodatin"
              />
            )}
          </ul>
        )}
      </div>
    </>
  );
}
