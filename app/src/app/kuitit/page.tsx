"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import ReviewQueue from "@/components/ReviewQueue";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";

import { categoryLabel } from "@/lib/receipt-categories";
import { formatMonth, parseFinnishNumber } from "@/lib/format";
import { drillFromSearch } from "@/lib/report-drill";
import {
  coerceReceiptListCache,
  dropReceipt,
  dropReceipts,
  mergeReceiptPage,
  receiptCountLabel,
  type ReceiptListPayload,
} from "@/lib/receipt-list";
import {
  receiptTabFromQuery,
  receiptTabQuery,
  ZERO_RECEIPT_TAB_COUNTS,
  type ReceiptTabCounts,
} from "@/lib/receipt-tabs";
import { Button, buttonClass } from "@/components/ui";
import { PageTitle, Section } from "@/components/ds";
import { batchOutcomeMessage } from "@/lib/upload-queue";
import { ReceiptFilters, type ReceiptAdvancedFilters } from "./ReceiptFilters";
import { ReceiptRow } from "./ReceiptRow";
import { BulkBar } from "./BulkBar";
import type { SavedReceipt } from "./types";

const RECENT_LIMIT = 5;

const emptyAdvanced: ReceiptAdvancedFilters = {
  type: "",
  category: "",
  source: "",
  minAmount: "",
  maxAmount: "",
  sort: "date_desc",
  linkedStatus: "",
};

export default function KuititPage() {
  const [listResult, setListResult] = useState<{
    query: string;
    receipts: SavedReceipt[];
    count: number;
    truncated: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Persisted so back-navigation restores the active month/search/advanced
  // filters instead of resetting the list to its defaults.
  const [monthFilter, setMonthFilter] = usePersistedState("kuitit.monthFilter", "");
  const [searchInput, setSearchInput] = usePersistedState("kuitit.searchInput", "");
  const [searchQuery, setSearchQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = usePersistedState("kuitit.advanced", emptyAdvanced);
  const [appliedAdvanced, setAppliedAdvanced] = usePersistedState(
    "kuitit.appliedAdvanced",
    emptyAdvanced
  );
  const [receiptToDelete, setReceiptToDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAllReceipts, setShowAllReceipts] = usePersistedState(
    "kuitit.showAllReceipts",
    false
  );
  const [loadError, setLoadError] = useState<{ query: string; error: unknown } | null>(null);
  const [actionError, setActionError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [tabCounts, setTabCounts] = useState<ReceiptTabCounts>(ZERO_RECEIPT_TAB_COUNTS);

  const [pendingReceipts, setPendingReceipts] = useState<SavedReceipt[]>(
    () => readPageCache<SavedReceipt[]>("receipts-pending") ?? []
  );
  const [pendingTruncated, setPendingTruncated] = useState(false);
  const [loadingMorePending, setLoadingMorePending] = useState(false);
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [retryApproveIds, setRetryApproveIds] = useState<string[]>([]);
  const [loadingPending, setLoadingPending] = useState(
    () => readPageCache<SavedReceipt[]>("receipts-pending") === null
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    const drill = drillFromSearch(window.location.search);
    if (!drill.month && !drill.type && !drill.category) return;
    if (drill.month) setMonthFilter(drill.month);
    if (drill.type || drill.category) {
      const next = {
        ...emptyAdvanced,
        type: drill.type || "",
        category: drill.category || "",
      };
      setAdvanced(next);
      setAppliedAdvanced(next);
    }
    // A report link sets the filter once; later edits stay on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search typing
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (searchQuery) params.set("q", searchQuery);
    if (appliedAdvanced.type) params.set("type", appliedAdvanced.type);
    if (appliedAdvanced.category)
      params.set("category", appliedAdvanced.category);
    if (appliedAdvanced.source) params.set("source", appliedAdvanced.source);
    if (appliedAdvanced.minAmount)
      params.set("minAmount", appliedAdvanced.minAmount);
    if (appliedAdvanced.maxAmount)
      params.set("maxAmount", appliedAdvanced.maxAmount);
    if (appliedAdvanced.sort) params.set("sort", appliedAdvanced.sort);
    if (appliedAdvanced.linkedStatus) params.set("linkedStatus", appliedAdvanced.linkedStatus);

    return params.toString();
  }, [monthFilter, searchQuery, appliedAdvanced]);

  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/receipts${query ? `?${query}` : ""}`)
      .then((response) =>
        readJson<{ receipts?: SavedReceipt[]; count?: number; truncated?: boolean }>(
          response,
          "Kuittien lataus epäonnistui"
        )
      )
      .then((data) => {
        if (cancelled) return;
        setLoadError(null);
        const page = mergeReceiptPage<SavedReceipt>(
          [],
          {
            receipts: data.receipts || [],
            count: typeof data.count === "number" ? data.count : (data.receipts || []).length,
            truncated: Boolean(data.truncated),
          },
          0
        );
        writePageCache(`receipts:${query}`, page);
        setListResult({ query, ...page });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError({ query, error });
      });

    apiFetch("/api/receipts?reviewStatus=pending")
      .then((res) =>
        readJson<{ receipts?: SavedReceipt[]; truncated?: boolean }>(res, "Virhe")
      )
      .then((data) => {
        if (cancelled) return;
        writePageCache("receipts-pending", data.receipts || []);
        setPendingReceipts(data.receipts || []);
        setPendingTruncated(Boolean(data.truncated));
        setLoadingPending(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query, loadAttempt]);

  // Filter-chip counts: DB-side, scoped by the same month/search/advanced
  // filters as the visible list (everything except the tab dimension itself,
  // which each chip overlays) - the row list above is capped, so counting
  // those rows would silently undercount past the cap. Refetched after every
  // mutation below (review/approve/delete) so the chips never go stale.
  const countsQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (searchQuery) params.set("q", searchQuery);
    if (appliedAdvanced.category) params.set("category", appliedAdvanced.category);
    if (appliedAdvanced.source) params.set("source", appliedAdvanced.source);
    if (appliedAdvanced.minAmount) params.set("minAmount", appliedAdvanced.minAmount);
    if (appliedAdvanced.maxAmount) params.set("maxAmount", appliedAdvanced.maxAmount);
    return params.toString();
  }, [monthFilter, searchQuery, appliedAdvanced.category, appliedAdvanced.source, appliedAdvanced.minAmount, appliedAdvanced.maxAmount]);

  async function loadCounts(signal?: AbortSignal) {
    try {
      const response = await apiFetch(`/api/receipts/counts${countsQuery ? `?${countsQuery}` : ""}`, { signal });
      const data = await readJson<{ counts: ReceiptTabCounts }>(response, "Määrien haku epäonnistui");
      if (signal?.aborted) return;
      setTabCounts(data.counts);
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) redirectToLogin();
      // Otherwise leave the last-known (or zero) counts - the receipt list
      // itself still loads independently of this fetch.
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount/refetch: storing the fetched counts is exactly the external-system sync this effect exists for
    void loadCounts(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countsQuery]);

  // A stale-but-cached copy paints immediately while the fetch above
  // revalidates; the skeleton is reserved for a genuinely never-seen query.
  const cachedList =
    listResult?.query === query
      ? null
      : coerceReceiptListCache<SavedReceipt>(readPageCache(`receipts:${query}`));
  const receipts =
    listResult?.query === query ? listResult.receipts : cachedList?.receipts ?? [];
  const receiptCount =
    listResult?.query === query ? listResult.count : cachedList?.count ?? receipts.length;
  const truncated =
    listResult?.query === query ? listResult.truncated : cachedList?.truncated ?? false;
  const currentLoadError = loadError?.query === query ? loadError.error : null;
  const loadingList =
    listResult?.query !== query && cachedList === null && !currentLoadError;

  useScrollRestoration("kuitit", !loadingList);

  useEffect(() => {
    if (!expandedId || document.visibilityState === "hidden") return;
    let cancelled = false;
    apiFetch(`/api/receipts/${expandedId}`)
      .then((response) =>
        readJson<{ receipt?: { match?: SavedReceipt["match"] } }>(
          response,
          "Täsmäytyksen lataus epäonnistui"
        )
      )
      .then((data) => {
        if (cancelled || !data.receipt?.match) return;
        const match = { ...data.receipt.match, candidatesDeferred: false };
        setListResult((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            receipts: prev.receipts.map((item) =>
              item.id === expandedId ? { ...item, match } : item
            ),
          };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setListResult((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            receipts: prev.receipts.map((item) =>
              item.id === expandedId
                ? { ...item, match: { ...item.match, candidatesDeferred: false } }
                : item
            ),
          };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId]);

  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (monthFilter) {
      chips.push({
        key: "month",
        label: formatMonth(monthFilter),
        clear: () => setMonthFilter(""),
      });
    }
    if (searchQuery) {
      chips.push({
        key: "q",
        label: `"${searchQuery}"`,
        clear: () => {
          setSearchInput("");
          setSearchQuery("");
        },
      });
    }
    if (appliedAdvanced.category) {
      chips.push({
        key: "category",
        label: categoryLabel(appliedAdvanced.category),
        clear: () => {
          setAdvanced((a) => ({ ...a, category: "" }));
          setAppliedAdvanced((a) => ({ ...a, category: "" }));
        },
      });
    }
    if (appliedAdvanced.source) {
      chips.push({
        key: "source",
        label:
          appliedAdvanced.source === "ai"
            ? "AI"
            : appliedAdvanced.source === "ocr"
              ? "OCR"
              : "Manuaalinen",
        clear: () => {
          setAdvanced((a) => ({ ...a, source: "" }));
          setAppliedAdvanced((a) => ({ ...a, source: "" }));
        },
      });
    }
    if (appliedAdvanced.minAmount || appliedAdvanced.maxAmount) {
      const min = appliedAdvanced.minAmount || "0";
      const max = appliedAdvanced.maxAmount || "∞";
      chips.push({
        key: "amount",
        label: `${min}–${max} €`,
        clear: () => {
          setAdvanced((a) => ({ ...a, minAmount: "", maxAmount: "" }));
          setAppliedAdvanced((a) => ({ ...a, minAmount: "", maxAmount: "" }));
        },
      });
    }
    return chips;
    // "type"/"linkedStatus" are the tab dimension, shown by the FilterChips
    // row itself rather than as a dismissible chip here.
  }, [monthFilter, searchQuery, appliedAdvanced]);

  function applyAdvanced() {
    // Amount fields accept the Finnish decimal comma; normalize to a
    // period-decimal string here so the API (which parses with Number())
    // and the "active filters" chips always see a consistent format.
    const minAmount = parseFinnishNumber(advanced.minAmount);
    const maxAmount = parseFinnishNumber(advanced.maxAmount);
    setAppliedAdvanced({
      ...advanced,
      minAmount: minAmount !== null ? String(minAmount) : "",
      maxAmount: maxAmount !== null ? String(maxAmount) : "",
    });
    setAdvancedOpen(false);
  }

  function clearAllFilters() {
    setMonthFilter("");
    setSearchInput("");
    setSearchQuery("");
    setAdvanced(emptyAdvanced);
    setAppliedAdvanced(emptyAdvanced);
  }

  async function handleMatchConfirm(receiptId: string, transactionId: string) {
    setMatchBusyId(receiptId);
    setActionError("");
    try {
      const res = await apiFetch("/api/matching/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, receiptId }),
      });
      if (!res.ok) await readJson(res, "Linkitys epäonnistui");
      setLoadAttempt((a) => a + 1);
      void loadCounts();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Linkitys epäonnistui"));
    } finally {
      setMatchBusyId(null);
    }
  }

  async function executeDeleteReceipt() {
    if (!receiptToDelete) return;
    const id = receiptToDelete;
    setDeletingId(id);
    setActionError("");
    try {
      const res = await apiFetch(`/api/receipts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        await readJson(res, "Kuitin poistaminen epäonnistui");
      }
      setListResult((previous) => {
        const cached = coerceReceiptListCache<SavedReceipt>(readPageCache(`receipts:${query}`));
        const base: ReceiptListPayload<SavedReceipt> | null =
          previous?.query === query
            ? { receipts: previous.receipts, count: previous.count, truncated: previous.truncated }
            : cached;
        if (!base) return previous;
        const next = dropReceipt(base, id);
        writePageCache(`receipts:${query}`, next);
        return { query, ...next };
      });
      void loadCounts();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(error, "Kuitin poistaminen epäonnistui");
      setActionError(message);
      throw new Error(message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleReview(id: string, status: "approved" | "rejected") {
    setActionError("");
    try {
      const res = await apiFetch(`/api/receipts/${id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: status }),
      });
      if (!res.ok) await readJson(res, "Päivitys epäonnistui");
      setLoadAttempt((a) => a + 1);
      void loadCounts();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Tilan päivitys epäonnistui"));
    }
  }

  async function handleReviewMany(ids: string[]) {
    if (ids.length === 0) return;
    setActionError("");
    setBulkReviewing(true);
    try {
      const res = await apiFetch("/api/receipts/batch-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: ids }),
      });
      const data = await readJson<{
        updatedCount?: number;
        failedCount?: number;
        failed?: { id: string }[];
      }>(res, "Hyväksyntä epäonnistui");
      const failed = data.failed ?? [];
      const failedCount = data.failedCount ?? failed.length;
      const updatedCount = data.updatedCount ?? Math.max(0, ids.length - failedCount);
      setActionError(batchOutcomeMessage("Hyväksyttiin", updatedCount, failedCount));
      setRetryApproveIds(failed.map((item) => item.id));
      setLoadAttempt((a) => a + 1);
      void loadCounts();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Hyväksyntä epäonnistui"));
    } finally {
      setBulkReviewing(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    setActionError("");
    try {
      const res = await apiFetch("/api/receipts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selectedIds) }),
      });
      const data = await readJson<{
        succeeded?: string[];
        failed?: { id: string }[];
        deletedCount?: number;
        failedCount?: number;
      }>(res, "Poisto epäonnistui");
      const succeeded = new Set(data.succeeded ?? []);
      const failed = data.failed ?? [];
      const failedCount = data.failedCount ?? failed.length;
      const deletedCount = data.deletedCount ?? succeeded.size;
      if (succeeded.size > 0) {
        setListResult((prev) => {
          const cached = coerceReceiptListCache<SavedReceipt>(readPageCache(`receipts:${query}`));
          const base: ReceiptListPayload<SavedReceipt> | null =
            prev?.query === query
              ? { receipts: prev.receipts, count: prev.count, truncated: prev.truncated }
              : cached;
          if (!base) return prev;
          const next = dropReceipts(base, succeeded);
          writePageCache(`receipts:${query}`, next);
          return { query, ...next };
        });
        void loadCounts();
      }
      setActionError(batchOutcomeMessage("Poistettiin", deletedCount, failedCount));
      setSelectedIds(new Set(failed.map((item) => item.id)));
      setShowBulkConfirm(false);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(error, "Poisto epäonnistui");
      setActionError(message);
      throw new Error(message);
    } finally {
      setBulkDeleting(false);
    }
  }

  async function loadMoreReceipts() {
    if (loadingMore || !truncated) return;
    const requested = query;
    const offset = receipts.length;
    setLoadingMore(true);
    setActionError("");
    try {
      const params = new URLSearchParams(requested);
      params.set("offset", String(offset));
      const response = await apiFetch(`/api/receipts?${params.toString()}`);
      const data = await readJson<{ receipts?: SavedReceipt[]; count?: number; truncated?: boolean }>(
        response,
        "Kuittien lataus epäonnistui"
      );
      if (queryRef.current !== requested) return;
      setListResult((previous) => {
        const current =
          previous?.query === requested ? previous.receipts : receipts;
        const page = mergeReceiptPage(
          current,
          {
            receipts: data.receipts || [],
            count: typeof data.count === "number" ? data.count : offset + (data.receipts || []).length,
            truncated: Boolean(data.truncated),
          },
          offset
        );
        writePageCache(`receipts:${requested}`, page);
        return { query: requested, ...page };
      });
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kuittien lataus epäonnistui"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadMorePending() {
    if (loadingMorePending || !pendingTruncated) return;
    const offset = pendingReceipts.length;
    setLoadingMorePending(true);
    try {
      const response = await apiFetch(`/api/receipts?reviewStatus=pending&offset=${offset}`);
      const data = await readJson<{ receipts?: SavedReceipt[]; truncated?: boolean }>(
        response,
        "Kuittien lataus epäonnistui"
      );
      setPendingReceipts((current) => {
        const next = [...current, ...(data.receipts || [])];
        writePageCache("receipts-pending", next);
        return next;
      });
      setPendingTruncated(Boolean(data.truncated));
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kuittien lataus epäonnistui"));
    } finally {
      setLoadingMorePending(false);
    }
  }

  const hasFilters = activeChips.length > 0;
  const activeTab = receiptTabFromQuery(appliedAdvanced.type, appliedAdvanced.linkedStatus);

  function onTabChange(id: Parameters<typeof receiptTabQuery>[0]) {
    const patch = receiptTabQuery(id);
    setAdvanced((a) => ({ ...a, ...patch }));
    setAppliedAdvanced((a) => ({ ...a, ...patch }));
  }

  // Split the review queue by where the document came from.
  const emailPending = pendingReceipts.filter((r) => r.source === "email_sync");
  const otherPending = pendingReceipts.filter(
    (r) => r.source !== "email_sync" && r.source !== "auto_income"
  );

  const visibleReceipts = showAllReceipts ? receipts : receipts.slice(0, RECENT_LIMIT);
  const allSelected = receipts.length > 0 && selectedIds.size === receipts.length;

  return (
    <>
      <div className="space-y-6 pb-6">
        <PageTitle
          title="Kuitit"
          action={
            <Link
              href="/kuitit/uusi"
              className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
            >
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                <path strokeLinecap="round" d="M12 5v14M5 12h14" />
              </svg>
              Lisää
            </Link>
          }
        />

        <Link href="/tyot" className="active-press -mt-4 inline-flex min-h-11 items-center px-1 text-[13px] font-medium text-accent">
          Työt ja poikkeukset
        </Link>

        {loadingPending && pendingReceipts.length === 0 && (
          <div className="h-24 animate-pulse rounded-card border border-line bg-surface" />
        )}

        {emailPending.length > 0 && (
          <ReviewQueue
            title="Tarkastettavat sähköpostikuitit"
            description="Sähköpostista tuodut kuitit odottavat hyväksyntää ennen kirjanpitoon siirtymistä."
            receipts={emailPending}
            rejectLabel="Hylkää (Yksityinen)"
            onReview={handleReview}
            onApproveAll={() => void handleReviewMany(emailPending.map((r) => r.id))}
            bulkBusy={bulkReviewing}
          />
        )}

        {otherPending.length > 0 && (
          <ReviewQueue
            title="Muut tarkastettavat kuitit"
            description="Odottavat hyväksyntää ennen kirjanpitoon siirtymistä."
            receipts={otherPending}
            rejectLabel="Hylkää"
            onReview={handleReview}
            onApproveAll={() => void handleReviewMany(otherPending.map((r) => r.id))}
            bulkBusy={bulkReviewing}
          />
        )}

        {pendingTruncated && (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={loadingMorePending}
            onClick={() => void loadMorePending()}
          >
            {loadingMorePending ? "Ladataan…" : "Lataa lisää tarkastettavia"}
          </Button>
        )}

        <ReceiptFilters
          monthFilter={monthFilter}
          onMonthChange={setMonthFilter}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          isSearchOpen={isSearchOpen}
          onToggleSearchOpen={() => setIsSearchOpen((v) => !v)}
          advancedOpen={advancedOpen}
          onToggleAdvancedOpen={() => {
            setAdvanced({ ...appliedAdvanced });
            setAdvancedOpen((v) => !v);
          }}
          advanced={advanced}
          onAdvancedChange={setAdvanced}
          advancedIsActive={Boolean(
            appliedAdvanced.category ||
              appliedAdvanced.source ||
              appliedAdvanced.minAmount ||
              appliedAdvanced.maxAmount ||
              appliedAdvanced.sort !== "date_desc"
          )}
          onApplyAdvanced={applyAdvanced}
          onClearAdvanced={() => {
            setAdvanced(emptyAdvanced);
            setAppliedAdvanced(emptyAdvanced);
            setAdvancedOpen(false);
          }}
          activeTab={activeTab}
          tabCounts={tabCounts}
          onTabChange={onTabChange}
          activeChips={activeChips}
          onClearAll={clearAllFilters}
        />

        {actionError && (
          <div
            className={`space-y-2 rounded-card px-4 py-3 text-sm ${
              actionError.includes("epäonnistui 0") ? "bg-canvas text-ink" : "bg-danger/10 text-danger"
            }`}
            role="status"
          >
            <p>{actionError}</p>
            {retryApproveIds.length > 0 && (
              <button
                type="button"
                className="min-h-11 text-sm font-medium text-accent"
                onClick={() => void handleReviewMany(retryApproveIds)}
              >
                Yritä epäonnistuneet uudelleen
              </button>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-3 px-1">
            {receipts.length > 0 && (
              <label className="relative -ml-2.5 flex h-11 w-11 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={allSelected}
                  onChange={() => setSelectedIds(allSelected ? new Set() : new Set(receipts.map((r) => r.id)))}
                  aria-label="Valitse kaikki"
                />
                <span
                  className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-colors ${
                    selectedIds.size > 0 ? "border-ink bg-ink" : "border-line bg-surface"
                  }`}
                >
                  {selectedIds.size > 0 && selectedIds.size === receipts.length && (
                    <svg className="h-2.5 w-2.5 text-canvas" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  )}
                  {selectedIds.size > 0 && selectedIds.size < receipts.length && (
                    <svg className="h-2.5 w-2.5 text-canvas" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
                    </svg>
                  )}
                </span>
              </label>
            )}
            <h2 className="text-[13px] text-ink-2">
              {loadingList ? "Ladataan…" : receiptCountLabel(receiptCount, hasFilters)}
            </h2>
          </div>

          {currentLoadError != null && receipts.length > 0 ? (
            <StaleBanner
              fetchedAt={pageCacheFetchedAt(`receipts:${query}`)}
              onRetry={() => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
              }}
            />
          ) : null}
          {currentLoadError != null && receipts.length === 0 ? (
            <ConnectionNotice
              error={currentLoadError}
              fallback="Kuittien lataus epäonnistui"
              onRetry={() => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
              }}
              compact
            />
          ) : loadingList ? (
            <SkeletonList rows={5} />
          ) : receipts.length === 0 ? (
            <EmptyState
              kind={hasFilters ? "filtered" : "records"}
              title={hasFilters ? "Ei kuitteja näillä suodattimilla" : "Ei kuitteja vielä"}
              body={
                hasFilters
                  ? "Kokeile väljempää hakua."
                  : "Lisää ensimmäinen kuitti kuvana tai PDF-tiedostona."
              }
              onClear={hasFilters ? clearAllFilters : undefined}
              action={
                hasFilters ? undefined : (
                  <Link href="/kuitit/uusi" className={buttonClass("primary")}>
                    Lisää ensimmäinen kuitti
                  </Link>
                )
              }
            />
          ) : (
            <div className="space-y-3">
              <Section>
                {visibleReceipts.map((r) => (
                  <ReceiptRow
                    key={r.id}
                    receipt={r}
                    expanded={expandedId === r.id}
                    onToggleExpand={() => setExpandedId((id) => (id === r.id ? null : r.id))}
                    selected={selectedIds.has(r.id)}
                    onToggleSelect={() => toggleSelection(r.id)}
                    matchBusy={matchBusyId === r.id}
                    onConfirmMatch={(txId) => handleMatchConfirm(r.id, txId)}
                    onDeleteRequest={() => setReceiptToDelete(r.id)}
                    deleting={deletingId === r.id}
                  />
                ))}
              </Section>
              {receipts.length > RECENT_LIMIT && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={() => setShowAllReceipts((v) => !v)}
                >
                  {showAllReceipts ? "Näytä vähemmän" : `Katso kaikki (${receipts.length})`}
                </Button>
              )}
              {truncated && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={() => void loadMoreReceipts()}
                >
                  {loadingMore ? "Ladataan…" : `Lataa lisää (${receipts.length} / ${receiptCount})`}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={receiptToDelete !== null}
        title="Poista kuitti?"
        description="Oletko varma, että haluat poistaa tämän kuitin? Tätä toimintoa ei voi perua."
        onConfirm={executeDeleteReceipt}
        onCancel={() => setReceiptToDelete(null)}
      />

      <ConfirmModal
        isOpen={showBulkConfirm}
        title={`Poista ${selectedIds.size} kuittia?`}
        description="Oletko varma, että haluat poistaa valitut kuitit? Tätä toimintoa ei voi perua."
        onConfirm={handleBulkDelete}
        onCancel={() => setShowBulkConfirm(false)}
      />

      {selectedIds.size > 0 && (
        <BulkBar
          count={selectedIds.size}
          busy={bulkDeleting}
          onCancel={() => setSelectedIds(new Set())}
          onDeleteRequest={() => setShowBulkConfirm(true)}
        />
      )}
    </>
  );
}
