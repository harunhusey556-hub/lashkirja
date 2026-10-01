"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import QueuedReceiptsCard from "@/components/QueuedReceiptsCard";
import { useRefetchOnReconnect } from "@/components/useRefetchOnReconnect";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";
import ReviewQueue from "@/components/ReviewQueue";
import RejectedReceipts from "@/components/RejectedReceipts";
import { showToast } from "@/lib/toast";
import { receiptTitle } from "@/lib/display-titles";
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
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";

import { categoryLabel } from "@/lib/receipt-categories";
import { formatMonth, parseFinnishNumber } from "@/lib/format";
import { drillFromSearch } from "@/lib/report-drill";
import {
  coerceReceiptListCache,
  dropReceipts,
  mergeReceiptPage,
  receiptCountLabel,
  type ReceiptListPayload,
} from "@/lib/receipt-list";
import {
  receiptTabFromQuery,
  receiptTabQuery,
  type ReceiptTabCounts,
} from "@/lib/receipt-tabs";
import { Button, buttonClass } from "@/components/ui";
import { Check, Minus, Receipt } from "lucide-react";
import { HeaderAddPill, PageTitle, Section, SlotSkeleton, useSkeletonFade } from "@/components/ds";
import { batchOutcomeMessage } from "@/lib/upload-queue";
import {
  approvalFailureText,
  noticeToneFor,
  retryableFailureIds,
  type NoticeTone,
} from "@/lib/review-queue";
import { ReceiptFilters, type ReceiptAdvancedFilters } from "./ReceiptFilters";
import { ReceiptRow } from "./ReceiptRow";
import { BULK_BAR_SPACE_VAR, BulkBar } from "./BulkBar";
import type { SavedReceipt } from "./types";

const RECENT_LIMIT = 5;

/** "Kahvila Oy, E2E Testi ja 3 muuta" for the bulk-delete confirm (BOOKS-12). */
function selectionSummary(selected: SavedReceipt[]): string {
  const names = selected.map((receipt) => receiptTitle(receipt));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} ja ${names.length - 2} muuta`;
}

/**
 * Chip counts when `/api/receipts/counts` has not answered: exact from the
 * list itself when it holds every receipt (the "Kaikki" tab, not truncated),
 * otherwise unknown. Never a made-up zero (Simulator run: "Kaikki 0" above
 * two listed receipts).
 */
function countsFromList(receipts: SavedReceipt[]): ReceiptTabCounts {
  return {
    all: receipts.length,
    tulo: receipts.filter((receipt) => receipt.type === "tulo").length,
    meno: receipts.filter((receipt) => receipt.type === "meno").length,
    linked: receipts.filter((receipt) => Boolean(receipt.linkedTransaction)).length,
    unlinked: receipts.filter((receipt) => !receipt.linkedTransaction).length,
  };
}

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
  const [advanced, setAdvanced] = usePersistedState("kuitit.advanced", emptyAdvanced);
  const [appliedAdvanced, setAppliedAdvanced] = usePersistedState(
    "kuitit.appliedAdvanced",
    emptyAdvanced
  );
  const [showAllReceipts, setShowAllReceipts] = usePersistedState(
    "kuitit.showAllReceipts",
    false
  );
  const [loadError, setLoadError] = useState<{ query: string; error: unknown } | null>(null);
  const [actionNotice, setActionNotice] = useState<{ text: string; tone: NoticeTone }>({
    text: "",
    tone: "error",
  });
  const actionError = actionNotice.text;
  // The tone comes from the data of the outcome (failed count), never from the wording (V14, R56).
  const setActionError = (text: string, tone: NoticeTone = "error") => setActionNotice({ text, tone });
  const actionErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (actionError) actionErrorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [actionError]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The connection came back, or the offline queue just delivered a photo:
  // the list refetches by itself instead of showing "Lähetetty" next to an
  // old list or an error card (F32).
  useRefetchOnReconnect(() => setLoadAttempt((attempt) => attempt + 1));
  const { rows: queueRows } = useOfflineReceiptQueue();
  const deliveredCount = queueRows.filter((row) => row.status === "done").length;
  const deliveredSeen = useRef(deliveredCount);
  useEffect(() => {
    if (deliveredCount > deliveredSeen.current) setLoadAttempt((attempt) => attempt + 1);
    deliveredSeen.current = deliveredCount;
  }, [deliveredCount]);
  // null = not known yet: the chips show no number rather than a false 0.
  const [fetchedCounts, setFetchedCounts] = useState<{ key: string; counts: ReceiptTabCounts } | null>(null);
  // Task 10: set once, right after the offline capture path (ReceiptEditor)
  // sends the user back here -- read from the URL rather than router state
  // so it survives the redirect cleanly, then stripped so a later back
  // navigation to this exact URL does not re-show it.
  const [offlineCaptureNotice, setOfflineCaptureNotice] = useState(false);

  const [pendingReceipts, setPendingReceipts] = useState<SavedReceipt[]>(
    () => readPageCache<SavedReceipt[]>("receipts-pending") ?? []
  );
  const [pendingTruncated, setPendingTruncated] = useState(false);
  // Rejected receipts stay reachable: shown in a card, restorable (F38).
  const [rejectedReceipts, setRejectedReceipts] = useState<SavedReceipt[]>([]);
  const [loadingMorePending, setLoadingMorePending] = useState(false);
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [retryApproveIds, setRetryApproveIds] = useState<string[]>([]);
  const [, setLoadingPending] = useState(
    () => readPageCache<SavedReceipt[]>("receipts-pending") === null
  );
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    // A report link opens exactly the list it names: month, type and category
    // from the link, and nothing remembered from an earlier visit (search,
    // other filters, the show-all toggle) (V44).
    setMonthFilter(drill.month || "");
    setSearchInput("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the report link on mount; the filter state is the target, not derived state
    setSearchQuery("");
    setShowAllReceipts(false);
    const next = {
      ...emptyAdvanced,
      type: drill.type || "",
      category: drill.category || "",
    };
    setAdvanced(next);
    setAppliedAdvanced(next);
    // A report link sets the filter once; later edits stay on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("offline") !== "1") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot read of a value left by the offline-capture redirect, not state derived from props/state here
    setOfflineCaptureNotice(true);
    window.history.replaceState(null, "", "/kuitit");
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
      writePageCache(`receipt-counts:${countsQuery}`, data.counts);
      setFetchedCounts({ key: countsQuery, counts: data.counts });
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) redirectToLogin();
      // Otherwise leave the last-known (or zero) counts - the receipt list
      // itself still loads independently of this fetch.
    }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/receipts?reviewStatus=rejected")
      .then((res) => readJson<{ receipts?: SavedReceipt[] }>(res, "Hylättyjen haku epäonnistui"))
      .then((data) => {
        if (!cancelled) setRejectedReceipts(data.receipts || []);
      })
      .catch(() => {
        // The card is a convenience; the rest of the page does not wait for it.
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount/refetch: storing the fetched counts is exactly the external-system sync this effect exists for
    void loadCounts(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countsQuery, loadAttempt]);

  // A stale-but-cached copy paints immediately while the fetch above
  // revalidates; the skeleton is reserved for a genuinely never-seen query.
  // Cold launch: the cache hydrates after this page mounted; these two hooks
  // re-render it the moment the copies from the last session are readable, so
  // the reads below find them (N3).
  useCacheAfterBoot(`receipts:${query}`);
  useCacheAfterBoot(`receipt-counts:${countsQuery}`);
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
  // The list that replaces the skeleton fades in (owner report 2026-09-30: fluidity).
  const listFade = useSkeletonFade(loadingList);

  useScrollRestoration("kuitit", !loadingList);

  const tabCounts: ReceiptTabCounts | null =
    fetchedCounts?.key === countsQuery
      ? fetchedCounts.counts
      : readPageCache<ReceiptTabCounts>(`receipt-counts:${countsQuery}`) ??
        (!loadingList && !truncated && receiptTabFromQuery(appliedAdvanced.type, appliedAdvanced.linkedStatus) === "all"
          ? countsFromList(receipts)
          : null);


  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (monthFilter) {
      chips.push({
        key: "month",
        label: monthFilter.length === 4 ? monthFilter : formatMonth(monthFilter),
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
    setFiltersOpen(false);
  }

  function clearAllFilters() {
    setMonthFilter("");
    setSearchInput("");
    setSearchQuery("");
    setAdvanced(emptyAdvanced);
    setAppliedAdvanced(emptyAdvanced);
  }

  async function handleReview(id: string, status: "approved" | "rejected" | "pending") {
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
      if (status === "rejected") {
        // Reject is never a silent delete: it can be undone here, and the receipt
        // stays listed under Hylätyt kuitit (F38).
        showToast({
          tone: "info",
          text: "Kuitti hylättiin",
          action: { label: "Kumoa", onAction: () => void handleReview(id, "pending") },
        });
      } else if (status === "pending") {
        showToast({ tone: "success", text: "Kuitti palautettiin tarkastettavaksi" });
      }
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
        failed?: { id: string; error?: string }[];
      }>(res, "Hyväksyntä epäonnistui");
      const failed = (data.failed ?? []).map((item) => ({ id: item.id, error: item.error ?? "" }));
      const failedCount = data.failedCount ?? failed.length;
      const updatedCount = data.updatedCount ?? Math.max(0, ids.length - failedCount);
      // The refusal is named (F15), and a retry is only offered when a second try can differ.
      setActionError(approvalFailureText(updatedCount, failed), noticeToneFor(failed.length));
      setRetryApproveIds(retryableFailureIds(failed));
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
    // Only rows the user can see (BOOKS-12): a collapsed list never deletes hidden receipts.
    const ids = selectedVisible.map((receipt) => receipt.id);
    if (ids.length === 0) return;
    setBulkDeleting(true);
    setActionError("");
    try {
      const res = await apiFetch("/api/receipts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: ids }),
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
      setActionError(
        batchOutcomeMessage("Poistettiin", deletedCount, failedCount),
        noticeToneFor(failedCount)
      );
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
  // Selection is always read through the visible rows (BOOKS-12, P0): "Valitse
  // kaikki" selects what is on screen, and a row hidden by "Näytä vähemmän" or a
  // filter change drops out of the selection instead of being deleted unseen.
  const selectedVisible = visibleReceipts.filter((receipt) => selectedIds.has(receipt.id));
  const selectedCount = selectedVisible.length;
  // Drop the hidden ids for real (adjust-state-during-render): a row hidden by
  // "Näytä vähemmän" or a filter must not come back still selected when shown again.
  if (selectedVisible.length !== selectedIds.size) {
    setSelectedIds(new Set(selectedVisible.map((receipt) => receipt.id)));
  }
  const allSelected = visibleReceipts.length > 0 && selectedCount === visibleReceipts.length;

  return (
    <>
      {/* BulkBar publishes its height while shown, so the last row and "Katso kaikki" scroll clear of it. */}
      <div className="space-y-6" style={{ paddingBottom: `var(${BULK_BAR_SPACE_VAR}, 0px)` }}>
        {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
        <PullToRefresh onRefresh={() => {
            setLoadError(null);
            setLoadAttempt((attempt) => attempt + 1);
          }} />
        <PageTitle
          title="Kuitit"
          action={<HeaderAddPill label="Uusi kuitti" href="/kuitit/uusi" />}
        />

        <QueuedReceiptsCard offlineNotice={offlineCaptureNotice} />

        {/* The outcome of a tap sits above the queues it came from, never below the fold (F15). */}
        {actionError && (
          <div
            ref={actionErrorRef}
            className={`space-y-2 rounded-card px-4 py-3 text-caption ${
              actionNotice.tone === "success" ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
            }`}
            role="status"
          >
            <p>{actionError}</p>
            {retryApproveIds.length > 0 && (
              <button
                type="button"
                className="min-h-11 text-body font-medium text-accent"
                onClick={() => void handleReviewMany(retryApproveIds)}
              >
                Yritä epäonnistuneet uudelleen
              </button>
            )}
          </div>
        )}

        {emailPending.length > 0 && (
          <ReviewQueue
            title="Tarkastettavat sähköpostikuitit"
            description="Sähköpostista tuodut kuitit odottavat hyväksyntää ennen kirjanpitoon siirtymistä."
            receipts={emailPending}
            rejectLabel="Hylkää (Yksityinen)"
            onReview={handleReview}
            onApproveAll={(readyIds) => void handleReviewMany(readyIds)}
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
            onApproveAll={(readyIds) => void handleReviewMany(readyIds)}
            bulkBusy={bulkReviewing}
          />
        )}

        <RejectedReceipts receipts={rejectedReceipts} onRestore={(id) => void handleReview(id, "pending")} />

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

        {/* Nothing to filter yet (or the load failed): no chips, no search, no "0" counts (VS-30). */}
        {!(receipts.length === 0 && !hasFilters && !loadingList) && (
        <ReceiptFilters
          monthFilter={monthFilter}
          onMonthChange={setMonthFilter}
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          filtersOpen={filtersOpen}
          onToggleFiltersOpen={() => {
            setAdvanced({ ...appliedAdvanced });
            setFiltersOpen((v) => !v);
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
            setFiltersOpen(false);
          }}
          activeTab={activeTab}
          tabCounts={tabCounts}
          onTabChange={onTabChange}
          activeChips={activeChips}
          onClearAll={clearAllFilters}
        />
        )}

        <div className="space-y-3">
          {(receipts.length > 0 || loadingList || hasFilters) && (
          <div className="flex items-center gap-3 px-1">
            {receipts.length > 0 && (
              // -ml-1 cancels the row's px-1 so this circle sits on the same vertical line as the
              // per-receipt circles below (both 44px boxes starting at the card's left edge).
              <label className="relative -ml-1 flex h-11 w-11 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={allSelected}
                  onChange={() => setSelectedIds(allSelected ? new Set() : new Set(visibleReceipts.map((r) => r.id)))}
                  aria-label={`Valitse kaikki näkyvät (${visibleReceipts.length})`}
                />
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 ${
                    selectedCount > 0 ? "border-ink bg-ink" : "border-ink-2/50 bg-surface"
                  }`}
                >
                  {selectedCount > 0 && allSelected && (
                    <Check aria-hidden width={12} height={12} strokeWidth={3.5} className="text-canvas" />
                  )}
                  {selectedCount > 0 && !allSelected && (
                    <Minus aria-hidden width={12} height={12} strokeWidth={3.5} className="text-canvas" />
                  )}
                </span>
              </label>
            )}
            <h2 className="text-caption text-ink-2">
              {loadingList ? <SlotSkeleton width={72} tone="soft" /> : receiptCountLabel(receiptCount, hasFilters)}
            </h2>
          </div>
          )}

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
              icon={Receipt}
              title={hasFilters ? "Ei kuitteja näillä suodattimilla" : "Ei kuitteja vielä"}
              body={
                hasFilters
                  ? "Kokeile väljempää hakua."
                  : "Kun kuvaat kuitin, se kirjautuu tänne ja luetaan puolestasi."
              }
              onClear={hasFilters ? clearAllFilters : undefined}
              action={
                hasFilters ? undefined : (
                  <Link href="/kuitit/uusi" className={buttonClass("primary")}>
                    Uusi kuitti
                  </Link>
                )
              }
            />
          ) : (
            <div className={`space-y-3 ${listFade}`}>
              <Section>
                {visibleReceipts.map((r) => (
                  <ReceiptRow
                    key={r.id}
                    receipt={r}
                    selected={selectedIds.has(r.id)}
                    onToggleSelect={() => toggleSelection(r.id)}
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
        isOpen={showBulkConfirm}
        title={selectedCount === 1 ? "Poista 1 kuitti?" : `Poista ${selectedCount} kuittia?`}
        description={`${selectionSummary(selectedVisible)}. Poistoa ei voi perua.`}
        onConfirm={handleBulkDelete}
        onCancel={() => setShowBulkConfirm(false)}
      />

      <BulkBar
        visible={selectedCount > 0}
        count={selectedCount}
        busy={bulkDeleting}
        onCancel={() => setSelectedIds(new Set())}
        onDeleteRequest={() => setShowBulkConfirm(true)}
      />
    </>
  );
}
