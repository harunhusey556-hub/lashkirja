"use client";

import { Disclosure } from "@/components/ds/Disclosure";
import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import BottomSheet from "@/components/BottomSheet";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDayMonth, formatEur } from "@/lib/format";
import { ChevronDown, FileText, Landmark, Repeat, Users } from "lucide-react";
import {
  ActionPill,
  FilterChips,
  HeaderAddPill,
  Icon,
  ListRow,
  PageTitle,
  SearchField,
  Section,
  SlotSkeleton,
  StatusTag,
  useSkeletonFade,
} from "@/components/ds";
import { SALES_STATUS } from "@/lib/status-labels";
import { detailHref } from "@/lib/routes";
import {
  INVOICE_LIST_LIMIT,
  SALES_FILTER_IDS,
  salesFilterChips,
  salesInvoiceGroups,
  type SalesFilterId,
  type SalesStatusCounts,
} from "@/lib/invoice-groups";

import { Button } from "@/components/ui";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { useCachedResource } from "@/components/useCachedResource";
import { CUSTOMER_COUNT_KEY, RECURRING_COUNT_KEY } from "@/lib/cached-resource";
import { isForbidden } from "@/lib/screen-state";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";

interface InvoiceSummary {
  id: string;
  number: number;
  reference: string;
  status: string;
  displayStatus: "draft" | "sent" | "paid" | "credited" | "overdue";
  documentKind?: "invoice" | "credit_note";
  issueDate: string;
  dueDate: string;
  gross: number;
  open: number;
  /** Set while a new reminder is certain to be refused: when it is accepted. */
  nextReminderAt?: string | null;
  customer: { id: string; name: string };
}

interface Aging {
  buckets: Record<string, { count: number; openCents: number }>;
  totalOpen: number;
  overdue: number;
  overdueCount: number;
}

interface MatchPreview {
  preview: Array<{ invoiceNumber: number; customerName: string; amount: number }>;
  suggestions: unknown[];
  /** Reference hits in a locked period: the run leaves them alone. */
  skippedLocked?: unknown[];
}

/** "1 maksu on lukitulla kaudella…" - what a run leaves alone and why. */
function lockedNote(count: number): string {
  return count === 1
    ? "1 maksu on lukitulla kaudella, joten sitä ei kirjata."
    : `${count} maksua on lukitulla kaudella, joten niitä ei kirjata.`;
}

const AGING_BUCKETS = ["1-30", "31-60", "61-90", "90+"] as const;

/** "Lasku N, eräpäivä d.m." - "myöhässä" once overdue, no date at all while still a draft. */
function rowSecondary(invoice: InvoiceSummary): string {
  if (invoice.documentKind === "credit_note") return `Hyvityslasku ${invoice.number}`;
  if (invoice.displayStatus === "draft") return `Lasku ${invoice.number}`;
  const datePhrase = invoice.displayStatus === "overdue" ? "myöhässä, eräpäivä" : "eräpäivä";
  return `Lasku ${invoice.number}, ${datePhrase} ${formatDayMonth(invoice.dueDate)}`;
}

function rowTrailing(invoice: InvoiceSummary) {
  if (invoice.documentKind === "credit_note") {
    return <StatusTag tone="neutral">Hyvityslasku</StatusTag>;
  }
  if (invoice.displayStatus === "overdue") {
    // Reminded lately: a new reminder would be refused, so no "Muistuta".
    if (invoice.nextReminderAt && new Date(invoice.nextReminderAt).getTime() > Date.now()) {
      return <StatusTag tone="neutral">Muistutettu</StatusTag>;
    }
    return (
      <ActionPill href={detailHref("invoice", invoice.id)} ariaLabel={`Muistuta: ${invoice.customer.name}`}>
        Muistuta
      </ActionPill>
    );
  }
  if (invoice.displayStatus === "draft") {
    return (
      <ActionPill href={detailHref("invoice", invoice.id)} ariaLabel={`Lähetä: ${invoice.customer.name}`}>
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
    <Suspense fallback={<SkeletonList rows={4} />}>
      <InvoicesPageContent />
    </Suspense>
  );
}

function InvoicesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const customerFilter = searchParams.get("customerId") ?? "";
  const monthFilter = /^\d{4}(-(0[1-9]|1[0-2]))?$/.test(searchParams.get("month") || "")
    ? searchParams.get("month")!
    : "";
  const statusFromUrl = searchParams.get("status");

  const [search, setSearch] = usePersistedState("laskut.search", "");
  const [query, setQuery] = useState(search.trim());
  // Persisted (not just in-memory) so back-navigation restores the active
  // tab instead of resetting the list to "Kaikki".
  const [filter, setFilter] = usePersistedState<SalesFilterId>("laskut.filter", "all");
  const [agingOpen, setAgingOpen] = usePersistedState("laskut.aging", false);

  // The cache only ever holds the unfiltered list, so a customer-scoped link
  // or a search must not paint it as if it were the filtered result.
  const cached =
    customerFilter || monthFilter || query
      ? null
      : readPageCache<{ invoices: InvoiceSummary[]; aging: Aging }>("invoices");
  const [invoices, setInvoices] = useState<InvoiceSummary[]>(cached?.invoices ?? []);
  const [aging, setAging] = useState<Aging | null>(cached?.aging ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateCache = useCacheAfterBoot<{ invoices: InvoiceSummary[]; aging: Aging }>(
    customerFilter || monthFilter || query ? null : "invoices"
  );
  const [appliedLateCache, setAppliedLateCache] = useState<unknown>(null);
  // Content that replaces the skeleton fades in (owner report 2026-09-30: fluidity).
  const readyFade = useSkeletonFade(status === "loading");
  if (lateCache && lateCache !== appliedLateCache && status === "loading") {
    setAppliedLateCache(lateCache);
    setInvoices(lateCache.invoices);
    setAging(lateCache.aging);
    setStatus("ready");
  }
  useEffect(() => {
    // A report link opens exactly the list it names: its status tab (Kaikki
    // when it names none) and no remembered search (V44).
    if (!statusFromUrl && !monthFilter) return;
    setSearch("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a report link resets the list state when its target changes; the list state is the target, not derived state
    setQuery("");
    setFilter(
      statusFromUrl && (SALES_FILTER_IDS as readonly string[]).includes(statusFromUrl)
        ? (statusFromUrl as SalesFilterId)
        : "all"
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFromUrl, monthFilter]);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [matchPreview, setMatchPreview] = useState<MatchPreview | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState("");

  // Debounced search: one request per pause in typing, not per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The active filter's status is sent to the server (as before): a fetch
  // capped at INVOICE_LIST_LIMIT rows and then filtered in JS would hide an
  // old invoice behind newer ones in its own tab. Chip counts do NOT come
  // from this list - see the /api/invoices/counts fetch below - because that
  // same cap would silently undercount past INVOICE_LIST_LIMIT invoices.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (customerFilter) params.set("customerId", customerFilter);
      if (monthFilter) params.set("month", monthFilter);
      if (query) params.set("search", query);
      const response = await apiFetch(`/api/invoices?${params.toString()}`, {
        credentials: "include",
        signal,
      });
      const data = await readJson<{ invoices: InvoiceSummary[]; aging: Aging }>(
        response,
        "Laskujen haku epäonnistui"
      );
      if (signal?.aborted) return;
      if (filter === "all" && !customerFilter && !monthFilter && !query) writePageCache("invoices", data);
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
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [filter, customerFilter, monthFilter, query]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Filter-chip counts: fetched separately from the (capped) list above, so
  // every chip stays correct regardless of which tab is active. Scoped the
  // same way as the list (customerId/month), but never by status/filter.
  // Painted from the cache and refreshed quietly, so a chip never starts from
  // a made-up "0" (SALES-18) or pops its number in on every visit (N3); the
  // first ever visit shows a skeleton where the number goes.
  const countsParams = new URLSearchParams();
  if (customerFilter) countsParams.set("customerId", customerFilter);
  if (monthFilter) countsParams.set("month", monthFilter);
  const countsQuery = countsParams.toString();
  const {
    value: statusCounts,
    failed: countsFailed,
    reload: reloadCounts,
  } = useCachedResource<SalesStatusCounts>(`invoice-counts:${countsQuery}`, async (signal) => {
    const res = await apiFetch(`/api/invoices/counts?${countsQuery}`, { credentials: "include", signal });
    return (await readJson<{ counts: SalesStatusCounts }>(res, "Määrien haku epäonnistui")).counts;
  });

  // A remembered filter whose chip no longer exists (the last credited
  // invoice is gone) falls back to "Kaikki" instead of an empty, unmarked list.
  useEffect(() => {
    if (statusCounts && filter === "credited" && statusCounts.credited === 0) setFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusCounts, filter]);

  // Best-effort counts for the registry rows at the bottom of the page; a
  // failure here must not block the invoice list itself, so the row simply
  // renders without a count. Cached like every other value (N3).
  const customerCount = useCachedResource<{ count: number }>(CUSTOMER_COUNT_KEY, async (signal) => {
    const res = await apiFetch("/api/customers", { credentials: "include", signal });
    return { count: (await readJson<{ customers: unknown[] }>(res, "")).customers.length };
  });
  const recurringCount = useCachedResource<{ count: number }>(RECURRING_COUNT_KEY, async (signal) => {
    const res = await apiFetch("/api/recurring-invoices", { credentials: "include", signal });
    return { count: (await readJson<{ recurring: unknown[] }>(res, "")).recurring.length };
  });
  const registryAmount = (row: { value: { count: number } | null; failed: boolean }) =>
    row.value ? String(row.value.count) : row.failed ? undefined : <SlotSkeleton width={20} />;

  useScrollRestoration("laskut", status === "ready");

  /** Step 1: show what a run would book, before anything is booked (SALES-06). */
  async function previewBankMatch() {
    if (matchLoading || status !== "ready") return;
    setMatchLoading(true);
    setMatchError("");
    try {
      const response = await apiFetch("/api/invoices/match", { credentials: "include" });
      setMatchPreview(await readJson<MatchPreview>(response, "Kohdistuksen tarkistus epäonnistui"));
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Kohdistuksen tarkistus epäonnistui") });
    } finally {
      setMatchLoading(false);
    }
  }

  /** Step 2: book the previewed payments. */
  async function runBankMatch() {
    setMatchBusy(true);
    setMatchError("");
    try {
      const response = await apiFetch("/api/invoices/match", {
        method: "POST",
        credentials: "include",
      });
      const result = await readJson<{
        applied: unknown[];
        suggestions: unknown[];
        skippedLocked?: unknown[];
      }>(response, "Kohdistus epäonnistui");
      setMatchPreview(null);
      const skipped = result.skippedLocked?.length ?? 0;
      const booked =
        result.applied.length === 1
          ? "1 maksu kohdistettiin laskulle."
          : `${result.applied.length} maksua kohdistettiin laskuille.`;
      // The success toast gives the haptic (ToastHost); no second one here.
      showToast({
        tone: result.applied.length > 0 ? "success" : "info",
        text: skipped > 0 ? `${booked} ${lockedNote(skipped)}` : booked,
      });
      reloadCounts();
      await load();
    } catch (error) {
      setMatchError(errorMessage(error, "Kohdistus epäonnistui"));
      void hapticNotify("error");
    } finally {
      setMatchBusy(false);
    }
  }

  const filterChips = salesFilterChips(
    statusCounts ?? { draft: 0, sent: 0, overdue: 0, paid: 0, credited: 0 }
  ).map((chip) =>
    statusCounts ? chip : { ...chip, count: countsFailed ? undefined : <SlotSkeleton width={14} /> }
  );
  const groups = salesInvoiceGroups(invoices, filter);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const filtered = filter !== "all" || Boolean(customerFilter) || Boolean(query);
  const reachedListLimit = invoices.length === INVOICE_LIST_LIMIT;
  const noInvoicesAtAll =
    status === "ready" && !filtered && !monthFilter && visibleCount === 0;
  const matchCount = matchPreview?.preview.length ?? 0;

  return (
    <div className="space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={() => load()} />
      <PageTitle
        title="Myynti"
        action={
          <HeaderAddPill
            label="Uusi lasku"
            href={customerFilter ? `/laskut/uusi?customerId=${encodeURIComponent(customerFilter)}` : "/laskut/uusi"}
          />
        }
      />

      {aging && !noInvoicesAtAll && status !== "error" && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <button
            type="button"
            aria-expanded={agingOpen}
            aria-controls="laskut-aging"
            onClick={() => setAgingOpen((open) => !open)}
            className="active-press flex w-full items-start justify-between gap-3 p-4 text-left"
          >
            <span>
              <span className="block text-caption text-ink-2">Avoinna</span>
              <span className="mt-0.5 block text-title-2 font-bold tracking-[-0.02em] tabular-nums text-ink">
                {formatEur(aging.totalOpen)}
              </span>
              {aging.overdueCount > 0 ? (
                <span className="mt-0.5 block text-caption text-accent">{formatEur(aging.overdue)} myöhässä</span>
              ) : null}
            </span>
            <span className="mt-1 flex items-center gap-1 text-caption text-ink-2">
              Erittely
              <Icon
                icon={ChevronDown}
                size="inline"
                className={`transition-transform duration-[var(--dur-pop)] ${agingOpen ? "rotate-180" : ""}`}
              />
            </span>
          </button>
          <Disclosure open={agingOpen}>
            <div
              id="laskut-aging"
              className="grid grid-cols-4 divide-x divide-line border-t border-line text-center"
            >
              {AGING_BUCKETS.map((bucket) => (
                <div key={bucket} className="px-2 py-3">
                  <p className="text-caption text-ink-2">{bucket} pv myöhässä</p>
                  <p className="mt-0.5 text-caption font-medium tabular-nums text-ink">
                    {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                  </p>
                </div>
              ))}
            </div>
          </Disclosure>
        </div>
      )}

      {!noInvoicesAtAll && status !== "error" && (
        <>
          <SearchField label="Hae laskuja" value={search} onChange={setSearch} />

          <FilterChips label="Suodata laskut" items={filterChips} value={filter} onChange={setFilter} />
        </>
      )}

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
            fallback="Laskujen haku epäonnistui"
            onRetry={() => void load()}
          />
        ))}

      {status === "ready" && (
        <div className={readyFade || undefined}>
          {groups.map((group) => (
            <Section key={group.id} title={group.label}>
              {group.items.map((invoice) => (
                <ListRow
                  key={invoice.id}
                  href={detailHref("invoice", invoice.id)}
                  title={invoice.customer.name}
                  amount={formatEur(invoice.gross)}
                  secondary={rowSecondary(invoice)}
                  trailing={rowTrailing(invoice)}
                />
              ))}
            </Section>
          ))}

          {visibleCount === 0 &&
            (filtered ? (
              <EmptyState
                kind="filtered"
                title={query ? "Hakua vastaavia laskuja ei löytynyt" : "Ei laskuja tällä suodattimella"}
                body={query ? "Kokeile asiakkaan nimeä tai laskun numeroa." : "Kokeile toista suodatinta."}
                onClear={() => {
                  setFilter("all");
                  setSearch("");
                }}
                clearLabel={query ? "Tyhjennä haku" : "Tyhjennä suodatin"}
              />
            ) : (
              <EmptyState
                kind="records"
                title="Ei laskuja vielä"
                body="Luo ensimmäinen myyntilasku. Se tallentuu luonnokseksi, kunnes lähetät sen."
                icon={FileText}
                onCreate={() => router.push("/laskut/uusi")}
                createLabel="Uusi lasku"
              />
            ))}

          {reachedListLimit && (
            <p className="text-caption text-ink-2">
              Näytetään {INVOICE_LIST_LIMIT} uusinta laskua. Hae tai valitse suodatin nähdäksesi muut.
            </p>
          )}
        </div>
      )}

      <Section>
        <ListRow
          leading={<Icon icon={Landmark} />}
          chevron
          title="Kohdista pankkimaksut"
          secondary={matchLoading ? "Tarkistetaan maksuja…" : "Kirjaa maksut viitenumeron mukaan"}
          onClick={() => void previewBankMatch()}
        />
        <ListRow
          leading={<Icon icon={Users} />}
          chevron
          title="Asiakkaat"
          amount={registryAmount(customerCount)}
          amountTone="muted"
          href="/asiakkaat"
        />
        <ListRow
          leading={<Icon icon={Repeat} />}
          chevron
          title="Toistuvat laskut"
          amount={registryAmount(recurringCount)}
          amountTone="muted"
          href="/toistuvat"
        />
      </Section>

      <BottomSheet
        isOpen={matchPreview !== null}
        onClose={() => {
          setMatchPreview(null);
          setMatchError("");
        }}
        title="Kohdista pankkimaksut"
        labelledBy="match-sheet-title"
      >
        {matchPreview && (
          <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
            {matchCount === 0 ? (
              <p className="text-body text-ink">
                {(matchPreview.skippedLocked?.length ?? 0) > 0
                  ? "Avoimille kausille ei ole kirjattavia maksuja."
                  : "Tiliotteilla ei ole maksuja, joiden viitenumero vastaisi avointa laskua."}
              </p>
            ) : (
              <>
                <p className="text-body text-ink">
                  {matchCount === 1
                    ? "Viitenumero täsmää yhteen maksuun. Se kirjataan laskulle:"
                    : `Viitenumero täsmää ${matchCount} maksuun. Ne kirjataan laskuille:`}
                </p>
                <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
                  {matchPreview.preview.map((row) => (
                    <div
                      key={`${row.invoiceNumber}-${row.amount}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-body"
                    >
                      <span className="min-w-0 line-clamp-2 text-ink [overflow-wrap:anywhere]">
                        Lasku {row.invoiceNumber}, {row.customerName}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink">{formatEur(row.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {(matchPreview.skippedLocked?.length ?? 0) > 0 && (
              <p className="text-caption text-ink-2">
                {lockedNote(matchPreview.skippedLocked?.length ?? 0)} Voit avata kauden kohdassa
                Kirjanpito &gt; Suljetut kaudet, jos maksu kuuluu kirjata.
              </p>
            )}
            {matchPreview.suggestions.length > 0 && (
              <p className="text-caption text-ink-2">
                {matchPreview.suggestions.length === 1
                  ? "Lisäksi 1 maksu täsmää summaltaan. Se ei kirjaudu automaattisesti, vaan tarkistat sen laskulla."
                  : `Lisäksi ${matchPreview.suggestions.length} maksua täsmää summaltaan. Ne eivät kirjaudu automaattisesti, vaan tarkistat ne laskuilla.`}
              </p>
            )}
            {matchError && (
              <p className="text-caption text-danger" role="alert">
                {matchError}
              </p>
            )}
            <div className="flex gap-2">
              {matchCount > 0 && (
                <Button
                  type="button"
                  className="flex-1"
                  busy={matchBusy}
                  busyLabel="Kohdistetaan…"
                  onClick={() => void runBankMatch()}
                >
                  Kohdista
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setMatchPreview(null);
                  setMatchError("");
                }}
              >
                {matchCount > 0 ? "Peruuta" : "Sulje"}
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
