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
import { formatDayMonth, formatEur } from "@/lib/format";
import {
  ActionPill,
  FilterChips,
  ListRow,
  PageTitle,
  Section,
  StatusTag,
  SummaryCard,
} from "@/components/ds";
import { SALES_STATUS } from "@/lib/status-labels";
import {
  SALES_FILTER_IDS,
  salesFilterChips,
  salesInvoiceGroups,
  type SalesFilterId,
} from "@/lib/invoice-groups";

import { Button } from "@/components/ui";
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

const AGING_BUCKETS = ["1-30", "31-60", "61-90", "90+"] as const;

/** Leading icon for the "Asiakkaat" registry row. */
function CustomersIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />
    </svg>
  );
}

/** Leading icon for the "Toistuvat laskut" registry row. */
function RecurringIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h11a4 4 0 0 1 4 4v1M20 17H9a4 4 0 0 1-4-4v-1" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m15 4 3 3-3 3M9 20l-3-3 3-3" />
    </svg>
  );
}

/** "Lasku N, eräpäivä d.m." - "erääntyi" once overdue, no date at all while still a draft. */
function rowSecondary(invoice: InvoiceSummary): string {
  if (invoice.displayStatus === "draft") return `Lasku ${invoice.number}`;
  const datePhrase = invoice.displayStatus === "overdue" ? "erääntyi" : "eräpäivä";
  return `Lasku ${invoice.number}, ${datePhrase} ${formatDayMonth(invoice.dueDate)}`;
}

function rowTrailing(invoice: InvoiceSummary) {
  if (invoice.displayStatus === "overdue") {
    return (
      <ActionPill href={`/laskut/${invoice.id}`} ariaLabel={`Muistuta: ${invoice.customer.name}`}>
        Muistuta
      </ActionPill>
    );
  }
  if (invoice.displayStatus === "draft") {
    return (
      <ActionPill href={`/laskut/${invoice.id}`} ariaLabel={`Lähetä: ${invoice.customer.name}`}>
        Lähetä
      </ActionPill>
    );
  }
  const status = SALES_STATUS[invoice.displayStatus];
  return <StatusTag tone={status.tone}>{status.label}</StatusTag>;
}

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
  const [filter, setFilter] = usePersistedState<SalesFilterId>("laskut.filter", "all");
  useEffect(() => {
    if (statusFromUrl && (SALES_FILTER_IDS as readonly string[]).includes(statusFromUrl)) {
      setFilter(statusFromUrl as SalesFilterId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFromUrl]);
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [registryCounts, setRegistryCounts] = useState<{ customers?: number; recurring?: number }>({});

  // The list is always fetched unfiltered: filtering/grouping by status
  // happens locally (see salesInvoiceGroups) so every filter chip's count
  // stays correct no matter which tab is currently selected.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
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
      if (!customerFilter && !monthFilter) writePageCache("invoices", data);
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
  }, [customerFilter, monthFilter]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Best-effort counts for the registry rows at the bottom of the page; a
  // failure here must not block the invoice list itself, so errors are
  // swallowed and the row simply renders without a count.
  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/customers", { credentials: "include", signal: controller.signal })
      .then((res) => readJson<{ customers: unknown[] }>(res, ""))
      .then((data) => setRegistryCounts((prev) => ({ ...prev, customers: data.customers.length })))
      .catch(() => {});
    apiFetch("/api/recurring-invoices", { credentials: "include", signal: controller.signal })
      .then((res) => readJson<{ recurring: unknown[] }>(res, ""))
      .then((data) => setRegistryCounts((prev) => ({ ...prev, recurring: data.recurring.length })))
      .catch(() => {});
    return () => controller.abort();
  }, []);

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

  const filterChips = salesFilterChips(invoices);
  const groups = salesInvoiceGroups(invoices, filter);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const filtered = filter !== "all" || Boolean(customerFilter);

  return (
    <div className="space-y-6 pb-6">
      <PageTitle
        title="Myynti"
        action={
          <Link
            href={customerFilter ? `/laskut/uusi?customerId=${encodeURIComponent(customerFilter)}` : "/laskut/uusi"}
            className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
            Uusi lasku
          </Link>
        }
      />

      {aging && (
        <>
          <SummaryCard
            label="Avoinna"
            value={formatEur(aging.totalOpen)}
            note={aging.overdueCount > 0 ? `${formatEur(aging.overdue)} myöhässä` : undefined}
          />
          <div className="grid grid-cols-4 divide-x divide-line overflow-hidden rounded-card border border-line bg-surface text-center">
            {AGING_BUCKETS.map((bucket) => (
              <div key={bucket} className="px-2 py-3">
                <p className="text-[11px] text-ink-2">{bucket} pv</p>
                <p className="mt-0.5 text-[13px] font-medium tabular-nums text-ink">
                  {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <Button
        type="button"
        variant="secondary"
        onClick={() => void runBankMatch()}
        busy={busy}
        busyLabel="Kohdistetaan…"
        className="w-full"
      >
        Kohdista maksut
      </Button>

      {message && (
        <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
          {message}
        </p>
      )}

      <FilterChips label="Suodata laskut" items={filterChips} value={filter} onChange={setFilter} />

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
        <>
          {groups.map((group) => (
            <Section key={group.id} title={group.label} count={group.items.length}>
              {group.items.map((invoice) => (
                <ListRow
                  key={invoice.id}
                  href={`/laskut/${invoice.id}`}
                  title={invoice.customer.name}
                  amount={formatEur(invoice.gross)}
                  secondary={rowSecondary(invoice)}
                  trailing={rowTrailing(invoice)}
                />
              ))}
            </Section>
          ))}

          {visibleCount === 0 && (
            <EmptyState
              kind={filtered ? "filtered" : "records"}
              title={filtered ? "Ei laskuja tällä suodattimella" : "Ei laskuja vielä"}
              body={filtered ? "Kokeile toista suodatinta." : "Luo ensimmäinen myyntilasku."}
              onClear={filtered ? () => setFilter("all") : undefined}
              clearLabel="Tyhjennä suodatin"
            />
          )}
        </>
      )}

      <Section>
        <ListRow
          leading={<CustomersIcon />}
          title="Asiakkaat"
          amount={registryCounts.customers !== undefined ? String(registryCounts.customers) : undefined}
          href="/asiakkaat"
        />
        <ListRow
          leading={<RecurringIcon />}
          title="Toistuvat laskut"
          amount={registryCounts.recurring !== undefined ? String(registryCounts.recurring) : undefined}
          href="/toistuvat"
        />
      </Section>
    </div>
  );
}
