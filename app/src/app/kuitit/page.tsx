"use client";

import { AnimatedRows } from "@/components/AnimatedRows";
import { PullToRefresh } from "@/components/ds/PullToRefresh";
import Link from "next/link";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import QueuedReceiptsCard from "@/components/QueuedReceiptsCard";
import { useCachedResource } from "@/components/useCachedResource";
import { useWindowedRows } from "@/components/useWindowedRows";
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
import { pageCacheFetchedAt, readPageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { rememberReceiptRows } from "@/lib/receipt-row-seed";
import {
  appendReceiptPage,
  nextPageParams,
  readReceiptPage,
  receiptKindParam,
  receiptPageQuery,
  reuseEqualReceipts,
  type ReceiptPageResponse,
} from "@/lib/receipt-paging";

import { categoryLabel } from "@/lib/receipt-categories";
import { formatMonth, parseFinnishNumber } from "@/lib/format";
import { drillFromSearch } from "@/lib/report-drill";
import {
  coerceReceiptListCache,
  dropReceipts,
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
import { HeaderAddPill, PageTitle, Section, SlotSkeleton, useSkeletonFade, Reveal } from "@/components/ds";
import { batchOutcomeMessage } from "@/lib/upload-queue";
import {
  approvalFailureText,
  chunkIds,
  noticeToneFor,
  retryableFailureIds,
  splitApprovable,
  type ApprovalFailure,
  type NoticeTone,
} from "@/lib/review-queue";
import { ReceiptFilters, type ReceiptAdvancedFilters } from "./ReceiptFilters";
import { ReceiptRow } from "./ReceiptRow";
import { BulkBar } from "./BulkBar";
import type { SavedReceipt } from "./types";
import { tintedButtonClass } from "@/components/control-styles";

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
  // A bill filed as an ostolasku lives in Ostolaskut; Kuitit lists kuitit and
  // shows the bills only under its Laskut chip ("invoice").
  const [kindFilter, setKindFilter] = usePersistedState<"receipt" | "invoice">("kuitit.kind", "receipt");
  // Opened from a report figure (`drill=1`): the list holds every document the figure counts, the
  // bills too. Never remembered, so Kuitit's own entry lists the kuitit again.
  const [drilled, setDrilled] = useState(false);
  const [showAllReceipts, setShowAllReceipts] = usePersistedState(
    "kuitit.showAllReceipts",
    false
  );
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
  const { rows: queueRows } = useOfflineReceiptQueue();
  const deliveredCount = queueRows.filter((row) => row.status === "done").length;
  const deliveredSeen = useRef(deliveredCount);
  // Task 10: set once, right after the offline capture path (ReceiptEditor)
  // sends the user back here -- read from the URL rather than router state
  // so it survives the redirect cleanly, then stripped so a later back
  // navigation to this exact URL does not re-show it.
  const [offlineCaptureNotice, setOfflineCaptureNotice] = useState(false);

  const [loadingMorePending, setLoadingMorePending] = useState(false);
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [retryApproveIds, setRetryApproveIds] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);

  // Stable, so the memoised rows do not repaint when one other row is ticked.
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const drill = drillFromSearch(window.location.search);
    if (!drill.drill && !drill.month && !drill.type && !drill.category) return;
    // A report link opens exactly the list it names: month, type and category
    // from the link, and nothing remembered from an earlier visit (search,
    // other filters, the show-all toggle, the Laskut chip) (V44).
    setMonthFilter(drill.month || "");
    setSearchInput("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the report link on mount; the filter state is the target, not derived state
    setSearchQuery("");
    setDrilled(drill.drill === true);
    setKindFilter("receipt");
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

  // W8: the upload summary links here. "tarkista=1" brings the review queues
  // (what auto-accept left pending) into view once they have loaded;
  // "nayta=ei-kohdistettu" opens the list on the receipts no bank row explains.
  const reviewSectionRef = useRef<HTMLDivElement>(null);
  const focusReviewRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const review = params.get("tarkista") === "1";
    const unlinked = params.get("nayta") === "ei-kohdistettu";
    if (!review && !unlinked) return;
    focusReviewRef.current = review;
    if (unlinked) {
      // The Laskut tab (W9) is remembered across visits; this link is about kuitit.
      setKindFilter("receipt");
      const patch = receiptTabQuery("unlinked");
      setAdvanced((a) => ({ ...a, ...patch }));
      setAppliedAdvanced((a) => ({ ...a, ...patch }));
    }
    window.history.replaceState(null, "", "/kuitit");
    // A link sets the view once; later edits stay on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search typing
  useEffect(() => {
    // A transition: typing stays responsive while the list under the new query swaps in.
    const t = setTimeout(() => startTransition(() => setSearchQuery(searchInput.trim())), 300);
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
    const kind = receiptKindParam(kindFilter, drilled);
    if (kind) params.set("kind", kind);

    return params.toString();
  }, [monthFilter, searchQuery, appliedAdvanced, kindFilter, drilled]);

  const queryRef = useRef(query);
  queryRef.current = query;

  // The list, the review queue, the rejected card and the chip counts are four
  // separate cached resources (N3): a chip or filter change refetches only the
  // list under its own key; the queues and counts keep their cached copy and
  // revalidate only on a sync/save, a reconnect or a pull. A revisit paints the
  // cached copy at once and the conditional GET (ETag) confirms it.
  const list = useCachedResource<ReceiptListPayload<SavedReceipt>>(`receipts:${query}`, async (signal) => {
    const response = await apiFetch(`/api/receipts?${receiptPageQuery(query)}`, { signal });
    const page = readReceiptPage(await readJson<ReceiptPageResponse<SavedReceipt>>(response, "Kuittien lataus epäonnistui"));
    const previous = coerceReceiptListCache<SavedReceipt>(readPageCache(`receipts:${query}`));
    return previous ? { ...page, receipts: reuseEqualReceipts(previous.receipts, page.receipts) } : page;
  });
  const pending = useCachedResource<ReceiptListPayload<SavedReceipt>>("receipts-pending", async (signal) => {
    const response = await apiFetch("/api/receipts?reviewStatus=pending&kind=receipt", { signal });
    return readReceiptPage(await readJson<ReceiptPageResponse<SavedReceipt>>(response, "Virhe"));
  });
  const rejected = useCachedResource<SavedReceipt[]>("receipts-rejected", async (signal) => {
    const response = await apiFetch("/api/receipts?reviewStatus=rejected", { signal });
    const data = await readJson<{ receipts?: SavedReceipt[] }>(response, "Hylättyjen haku epäonnistui");
    return data.receipts || [];
  });

  // Filter-chip counts: DB-side, scoped by the same month/search/advanced
  // filters as the visible list (everything except the tab dimension itself,
  // which each chip overlays) - the row list above is paged, so counting
  // those rows would silently undercount past the page. Revalidated after every
  // write (the data version) so the chips never go stale.
  const countsQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (monthFilter) params.set("month", monthFilter);
    if (searchQuery) params.set("q", searchQuery);
    if (appliedAdvanced.category) params.set("category", appliedAdvanced.category);
    if (appliedAdvanced.source) params.set("source", appliedAdvanced.source);
    if (appliedAdvanced.minAmount) params.set("minAmount", appliedAdvanced.minAmount);
    if (appliedAdvanced.maxAmount) params.set("maxAmount", appliedAdvanced.maxAmount);
    // The chips count the list's own documents; the Laskut chip's number comes back in the same answer.
    const kind = receiptKindParam("receipt", drilled);
    if (kind) params.set("kind", kind);
    return params.toString();
  }, [monthFilter, searchQuery, appliedAdvanced.category, appliedAdvanced.source, appliedAdvanced.minAmount, appliedAdvanced.maxAmount, drilled]);

  const counts = useCachedResource<ReceiptTabCounts>(`receipt-counts:${countsQuery}`, async (signal) => {
    const response = await apiFetch(`/api/receipts/counts${countsQuery ? `?${countsQuery}` : ""}`, { signal });
    const data = await readJson<{ counts: ReceiptTabCounts }>(response, "Määrien haku epäonnistui");
    return data.counts;
  });

  const { reload: reloadList } = list;
  const { reload: reloadPending } = pending;
  const { reload: reloadRejected } = rejected;
  const { reload: reloadCounts } = counts;
  /** Pull to refresh, "Yritä uudelleen" and a delivered offline photo: all four resources again. */
  const reloadAll = useCallback(() => {
    reloadList();
    reloadPending();
    reloadRejected();
    reloadCounts();
  }, [reloadList, reloadPending, reloadRejected, reloadCounts]);
  useEffect(() => {
    if (deliveredCount > deliveredSeen.current) reloadAll();
    deliveredSeen.current = deliveredCount;
  }, [deliveredCount, reloadAll]);

  const shown = useMemo(() => coerceReceiptListCache<SavedReceipt>(list.value), [list.value]);
  const receipts = useMemo(() => shown?.receipts ?? [], [shown]);
  const receiptCount = shown?.count ?? receipts.length;
  const truncated = shown?.truncated ?? false;
  const currentLoadError = list.error;
  const loadingList = shown === null && !currentLoadError;
  // The list that replaces the skeleton fades in (owner report 2026-09-30: fluidity).
  const listFade = useSkeletonFade(loadingList);

  // Receipts opened from here paint their title and amount from this row while the full receipt loads.
  useEffect(() => rememberReceiptRows(receipts), [receipts]);

  useScrollRestoration("kuitit", !loadingList);

  const pendingShown = useMemo(() => coerceReceiptListCache<SavedReceipt>(pending.value), [pending.value]);
  const pendingReceipts = useMemo(() => pendingShown?.receipts ?? [], [pendingShown]);
  const pendingTruncated = pendingShown?.truncated ?? false;
  const rejectedReceipts = useMemo(() => rejected.value ?? [], [rejected.value]);
  const pendingCount = pendingReceipts.length;
  useEffect(() => {
    if (!focusReviewRef.current || pendingCount === 0 || !reviewSectionRef.current) return;
    focusReviewRef.current = false;
    reviewSectionRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pendingCount]);

  const tabCounts: ReceiptTabCounts | null =
    counts.value ??
    (!loadingList && !truncated && kindFilter !== "invoice" && receiptTabFromQuery(appliedAdvanced.type, appliedAdvanced.linkedStatus) === "all"
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
    startTransition(() =>
      setAppliedAdvanced({
        ...advanced,
        minAmount: minAmount !== null ? String(minAmount) : "",
        maxAmount: maxAmount !== null ? String(maxAmount) : "",
      })
    );
    setFiltersOpen(false);
  }

  function clearAllFilters() {
    setMonthFilter("");
    setSearchInput("");
    setSearchQuery("");
    setAdvanced(emptyAdvanced);
    setAppliedAdvanced(emptyAdvanced);
    setKindFilter("receipt");
  }

  /** Receipts that were just approved or rejected leave the review queue without waiting for the refetch. */
  function dropPending(ids: ReadonlySet<string>) {
    const base = coerceReceiptListCache<SavedReceipt>(pending.value);
    if (base && ids.size > 0) pending.set(dropReceipts(base, ids));
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
      // The row leaves the queue at once; the write's data version refetches the truth (list, counts, rejected).
      if (status !== "pending") dropPending(new Set([id]));
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

  async function handleReviewMany(ids: string[]): Promise<ApprovalFailure[]> {
    if (ids.length === 0) return [];
    setActionError("");
    setBulkReviewing(true);
    try {
      // The endpoint takes at most 200 ids (route.ts); a grown pending list or
      // a page-wide accept sends chunks and aggregates the refusals.
      const failed: ApprovalFailure[] = [];
      let updatedCount = 0;
      for (const chunk of chunkIds(ids)) {
        const res = await apiFetch("/api/receipts/batch-approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptIds: chunk }),
        });
        const data = await readJson<{
          updatedCount?: number;
          failedCount?: number;
          failed?: { id: string; error?: string }[];
        }>(res, "Hyväksyntä epäonnistui");
        failed.push(...(data.failed ?? []).map((item) => ({ id: item.id, error: item.error ?? "" })));
        updatedCount += data.updatedCount ?? Math.max(0, chunk.length - (data.failedCount ?? 0));
      }
      // The refusal is named (F15), and a retry is only offered when a second try can differ.
      setActionError(approvalFailureText(updatedCount, failed), noticeToneFor(failed.length));
      setRetryApproveIds(retryableFailureIds(failed));
      const refused = new Set(failed.map((item) => item.id));
      dropPending(new Set(ids.filter((id) => !refused.has(id))));
      return failed;
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return [];
      }
      setActionError(errorMessage(error, "Hyväksyntä epäonnistui"));
      return [];
    } finally {
      setBulkReviewing(false);
    }
  }

  /** The BulkBar's approve: the selected pending receipts that are ready, one
   * rule for every path (receipt-approval.ts). What failed stays selected. */
  async function handleBulkApprove() {
    const failed = await handleReviewMany(bulkApprovable.map((receipt) => receipt.id));
    setSelectedIds(new Set(failed.map((item) => item.id)));
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
        const base = coerceReceiptListCache<SavedReceipt>(list.value);
        if (base) list.set(dropReceipts(base, succeeded));
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
    if (loadingMore || !truncated || !shown) return;
    const requested = query;
    setLoadingMore(true);
    setActionError("");
    try {
      const response = await apiFetch(`/api/receipts?${receiptPageQuery(requested, nextPageParams(shown))}`);
      const data = await readJson<ReceiptPageResponse<SavedReceipt>>(response, "Kuittien lataus epäonnistui");
      // The owner changed the filter while this page was on its way.
      if (queryRef.current !== requested) return;
      list.set(appendReceiptPage(shown, readReceiptPage(data)));
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
    if (loadingMorePending || !pendingTruncated || !pendingShown) return;
    setLoadingMorePending(true);
    try {
      const params = new URLSearchParams("reviewStatus=pending&kind=receipt");
      const next = nextPageParams(pendingShown);
      if (next.cursor) params.set("cursor", next.cursor);
      else params.set("offset", String(next.offset));
      const response = await apiFetch(`/api/receipts?${params.toString()}`);
      const data = await readJson<ReceiptPageResponse<SavedReceipt>>(response, "Kuittien lataus epäonnistui");
      pending.set(appendReceiptPage(pendingShown, readReceiptPage(data)));
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
  const activeTab = kindFilter === "invoice" ? "laskut" : receiptTabFromQuery(appliedAdvanced.type, appliedAdvanced.linkedStatus);

  function onTabChange(id: Parameters<typeof receiptTabQuery>[0]) {
    const patch = receiptTabQuery(id);
    // A chip tap is a transition: the chip highlights at once, the rows swap in from the cache or the fetch.
    startTransition(() => {
      setKindFilter(id === "laskut" ? "invoice" : "receipt");
      setAdvanced((a) => ({ ...a, ...patch }));
      setAppliedAdvanced((a) => ({ ...a, ...patch }));
    });
  }

  // Split the review queue by where the document came from.
  const emailPending = pendingReceipts.filter((r) => r.source === "email_sync");
  // Sales drafted from bank rows (MobilePay settlements and the like). Koti
  // shows three; this is the whole queue, so they can be approved here too.
  const bankSalesPending = pendingReceipts.filter((r) => r.source === "auto_income");
  const otherPending = pendingReceipts.filter(
    (r) => r.source !== "email_sync" && r.source !== "auto_income"
  );

  // C: one action across every queue on the page — the single rule of
  // receipt-approval.ts decides what it carries; the rest stay in their queue.
  const { ready: allPendingReady, incomplete: allPendingIncomplete } = splitApprovable(pendingReceipts);

  const visibleReceipts = useMemo(
    () => (showAllReceipts ? receipts : receipts.slice(0, RECENT_LIMIT)),
    [showAllReceipts, receipts]
  );
  const rowWindow = useWindowedRows(visibleReceipts.length);
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
  // The bulk bar acts on what is on screen (BOOKS-12); of the selection only
  // the pending receipts without a gap can be approved (F15).
  const pendingIds = new Set(pendingReceipts.map((receipt) => receipt.id));
  const bulkApprovable = splitApprovable(
    selectedVisible.filter((receipt) => pendingIds.has(receipt.id))
  ).ready;

  return (
    <>
      <div className="space-y-6">
        {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
        <PullToRefresh onRefresh={() => {
            reloadAll();
          }} />
        <PageTitle
          title="Kuitit"
          action={<HeaderAddPill label="Uusi kuitti" href="/kuitit/uusi" />}
        />

        <QueuedReceiptsCard offlineNotice={offlineCaptureNotice} />

        {/* The outcome of a tap sits above the queues it came from, never below the fold (F15). */}
        <Reveal show={Boolean(actionError)}>{actionError ? (
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
                className={tintedButtonClass("accent")}
                onClick={() => void handleReviewMany(retryApproveIds)}
              >
                Yritä epäonnistuneet uudelleen
              </button>
            )}
          </div>
        ) : null}</Reveal>

        {/* What waits for the owner: auto-accept (W8) leaves only these. The
            upload summary's "Näytä tarkistettavat" scrolls here. */}
        {pendingReceipts.length > 0 && (
          <div ref={reviewSectionRef} className="scroll-mt-4 space-y-6">
            {/* C: the whole page's ready pending receipts in one action, instead of
                opening each queue card. The ones with a gap are named, never swept in. */}
            {allPendingReady.length > 0 && (
              <div className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3">
                <p className="text-caption text-ink-2">
                  {allPendingReady.length === 1
                    ? "1 kuitti on valmis hyväksyttäväksi."
                    : `${allPendingReady.length} kuittia on valmiina hyväksyttäväksi.`}
                  {allPendingIncomplete.length > 0 &&
                    ` ${allPendingIncomplete.length} vaatii täydennyksen.`}
                </p>
                <Button
                  type="button"
                  className="w-full"
                  busy={bulkReviewing}
                  busyLabel="Hyväksytään…"
                  onClick={() => void handleReviewMany(allPendingReady.map((receipt) => receipt.id))}
                >
                  Hyväksy kaikki valmiit ({allPendingReady.length})
                </Button>
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

            {bankSalesPending.length > 0 && (
              <ReviewQueue
                title="Myynnit pankista"
                description="Tiliotteen tuloista tehdyt myyntikirjaukset odottavat hyväksyntää."
                receipts={bankSalesPending}
                rejectLabel="Hylkää"
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
          </div>
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
          onMonthChange={(month) => startTransition(() => setMonthFilter(month))}
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
                reloadAll();
              }}
            />
          ) : null}
          {currentLoadError != null && receipts.length === 0 ? (
            <ConnectionNotice
              error={currentLoadError}
              fallback="Kuittien lataus epäonnistui"
              onRetry={() => {
                reloadAll();
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
              {rowWindow.windowed ? (
                // Over 200 rows only the ones near the screen are mounted; spacers keep the scroll height.
                <div
                  ref={rowWindow.listRef}
                  className="ui-card overflow-hidden rounded-card border border-line bg-surface divide-y divide-line"
                >
                  <div data-window-pad="top" aria-hidden style={{ height: rowWindow.padTop, borderWidth: 0 }} />
                  {visibleReceipts.slice(rowWindow.start, rowWindow.end).map((r) => (
                    <ReceiptRow key={r.id} receipt={r} selected={selectedIds.has(r.id)} onToggleSelect={toggleSelection} />
                  ))}
                  <div data-window-pad="bottom" aria-hidden style={{ height: rowWindow.padBottom, borderWidth: 0 }} />
                </div>
              ) : (
                <Section>
                  <AnimatedRows rows={visibleReceipts.map((r) => ({ key: r.id, node: (
                    <ReceiptRow
                      key={r.id}
                      receipt={r}
                      selected={selectedIds.has(r.id)}
                      onToggleSelect={toggleSelection}
                    />
                  ) }))} />
                </Section>
              )}
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
        approveBusy={bulkReviewing}
        approvableCount={bulkApprovable.length}
        onCancel={() => setSelectedIds(new Set())}
        onApproveRequest={() => void handleBulkApprove()}
        onDeleteRequest={() => setShowBulkConfirm(true)}
      />
    </>
  );
}
