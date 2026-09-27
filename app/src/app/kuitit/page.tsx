"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import ReviewQueue from "@/components/ReviewQueue";
import ReceiptMatchPanel, {
  type ReceiptMatchData,
  type BankTxMatch,
} from "@/components/ReceiptMatchPanel";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import {
  categoryLabel,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";

import { formatEur, formatMonth, parseFinnishNumber } from "@/lib/format";
import { drillFromSearch } from "@/lib/report-drill";
import {
  coerceReceiptListCache,
  dropReceipt,
  dropReceipts,
  mergeReceiptPage,
  receiptCountLabel,
  type ReceiptListPayload,
} from "@/lib/receipt-list";
import { Button, buttonClass, chipClass } from "@/components/ui";
import { batchOutcomeMessage } from "@/lib/upload-queue";
interface SavedReceipt {
  id: string;
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  category: string | null;
  type: string;
  reference: string | null;
  invoiceNumber: string | null;
  fileName: string;
  source: string;
  createdAt: string;
  linkedTransaction?: BankTxMatch | null;
  match: ReceiptMatchData;
}

const RECENT_LIMIT = 5;

const emptyAdvanced = {
  type: "",
  category: "",
  source: "",
  minAmount: "",
  maxAmount: "",
  sort: "date_desc",
  linkedStatus: "",
};


function formatMonthLabel(month: string): string {
  if (!month) return "";
  const [y, m] = month.split("-");
  const names = [
    "tammikuu", "helmikuu", "maaliskuu", "huhtikuu", "toukokuu", "kesäkuu",
    "heinäkuu", "elokuu", "syyskuu", "lokakuu", "marraskuu", "joulukuu",
  ];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

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
  const [isPendingOpen, setIsPendingOpen] = useState(false);
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
        readJson<{ receipt?: { match?: ReceiptMatchData } }>(
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
        label: formatMonthLabel(monthFilter),
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
    if (appliedAdvanced.type) {
      chips.push({
        key: "type",
        label: appliedAdvanced.type === "tulo" ? "Tulo" : "Meno",
        clear: () => {
          setAdvanced((a) => ({ ...a, type: "" }));
          setAppliedAdvanced((a) => ({ ...a, type: "" }));
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
      setLoadAttempt(a => a + 1);
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

  // Split the review queue by where the document came from.
  const emailPending = pendingReceipts.filter((r) => r.source === "email_sync");
  const otherPending = pendingReceipts.filter(
    (r) => r.source !== "email_sync" && r.source !== "auto_income"
  );

  return (
    <>
      <div className="space-y-6">
        <div className="animate-in fade-in slide-in-from-top-2">
          <Link
            href="/kuitit/uusi"
            className="touch-target active-press flex min-h-12 w-full items-center justify-center gap-1.5 rounded-2xl bg-charcoal text-sm font-medium text-white"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
            </svg>
            Lisää
          </Link>
          <Link
            href="/tyot"
            className="mt-3 flex min-h-11 items-center justify-center text-sm font-medium text-accent"
          >
            Työt ja poikkeukset
          </Link>
        </div>

        {loadingPending && pendingReceipts.length === 0 && (
          <div className="skeleton bg-white border border-warm-gray-light/30 rounded-3xl shadow-sm h-24" />
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
            {loadingMorePending ? "Ladataan..." : "Lataa lisää tarkastettavia"}
          </Button>
        )}

        <div className="animate-in fade-in slide-in-from-top-3 stagger-1">
          <div className="flex gap-2 p-1.5 bg-white border border-warm-gray-light/30 rounded-3xl overflow-x-auto scrollbar-none shadow-sm" role="tablist">
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "" }));
              }}
              aria-pressed={!appliedAdvanced.type && !appliedAdvanced.linkedStatus}
              className={chipClass(!appliedAdvanced.type && !appliedAdvanced.linkedStatus)}
            >
              Kaikki
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "tulo", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "tulo", linkedStatus: "" }));
              }}
              aria-pressed={appliedAdvanced.type === "tulo"}
              className={chipClass(appliedAdvanced.type === "tulo")}
            >
              Myynnit
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "meno", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "meno", linkedStatus: "" }));
              }}
              aria-pressed={appliedAdvanced.type === "meno"}
              className={chipClass(appliedAdvanced.type === "meno")}
            >
              Ostot
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "linked" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "linked" }));
              }}
              aria-pressed={appliedAdvanced.linkedStatus === "linked"}
              className={chipClass(appliedAdvanced.linkedStatus === "linked")}
            >
              Linkitetty
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "unlinked" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "unlinked" }));
              }}
              aria-pressed={appliedAdvanced.linkedStatus === "unlinked"}
              className={chipClass(appliedAdvanced.linkedStatus === "unlinked")}
            >
              Ei linkitetty
            </button>
          </div>
        </div>

        <div className="animate-in fade-in slide-in-from-top-4 stagger-2">
          <button
            type="button"
            onClick={() => setIsSearchOpen((v) => !v)}
            className="w-full flex items-center justify-between text-left py-2 group"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-warm-gray group-hover:text-charcoal transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
              </svg>
              <span className="text-sm font-medium text-warm-gray group-hover:text-charcoal transition-colors">Hae ja suodata kuitteja</span>
            </div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-5 h-5 text-warm-gray group-hover:text-charcoal transition-all duration-300 ${isSearchOpen ? "rotate-180" : ""}`}
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </button>

          <div className={`accordion-wrapper ${isSearchOpen ? "expanded" : ""}`}>
            <div className="accordion-content">
              <div className="space-y-3 pt-4 pb-2">
                <div className="relative">
                  <input
                    aria-label="Hae kuitteja"
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Hae myyjää, tiedostoa tai kategoriaa..."
                    className="w-full min-h-12 min-w-0 px-4 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                  />
                </div>

              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={monthFilter}
                  onChange={(e) => setMonthFilter(e.target.value)}
                  className="min-w-0 flex-1 min-h-12 px-4 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                  aria-label="Kuukausi"
                />
                <button
                  type="button"
                  onClick={() => {
                    setAdvanced({ ...appliedAdvanced });
                    setAdvancedOpen((v) => !v);
                  }}
                  className={`min-h-12 px-4 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap shadow-sm ${
                    advancedOpen ||
                    appliedAdvanced.type ||
                    appliedAdvanced.category ||
                    appliedAdvanced.source ||
                    appliedAdvanced.minAmount ||
                    appliedAdvanced.maxAmount ||
                    appliedAdvanced.sort !== "date_desc"
                      ? "bg-blush/20 border-accent/30 text-accent-dark"
                      : "bg-white border-warm-gray-light/50 text-charcoal hover:bg-cream/50"
                  }`}
                  aria-expanded={advancedOpen}
                  aria-controls="advanced-receipt-filters"
                >
                  Edistyneet
                </button>
              </div>

              {advancedOpen && (
                <div
                  id="advanced-receipt-filters"
                  className="border-t border-warm-gray-light/30 pt-3 space-y-3"
                >
              <div className="field-grid">
                <div>
                  <label htmlFor="receipt-type-filter" className="block text-xs text-warm-gray mb-1">
                    Tyyppi
                  </label>
                  <select
                    id="receipt-type-filter"
                    value={advanced.type}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, type: e.target.value })
                    }
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  >
                    <option value="">Kaikki</option>
                    <option value="meno">Meno</option>
                    <option value="tulo">Tulo</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="receipt-category-filter" className="block text-xs text-warm-gray mb-1">
                    Kategoria
                  </label>
                  <select
                    id="receipt-category-filter"
                    value={advanced.category}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, category: e.target.value })
                    }
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  >
                    <option value="">Kaikki</option>
                    {RECEIPT_CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-grid">
                <div>
                  <label htmlFor="receipt-source-filter" className="block text-xs text-warm-gray mb-1">
                    Lähde
                  </label>
                  <select
                    id="receipt-source-filter"
                    value={advanced.source}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, source: e.target.value })
                    }
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  >
                    <option value="">Kaikki</option>
                    <option value="ai">AI</option>
                    <option value="ocr">OCR</option>
                    <option value="manual">Manuaalinen</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="receipt-sort-filter" className="block text-xs text-warm-gray mb-1">
                    Järjestys
                  </label>
                  <select
                    id="receipt-sort-filter"
                    value={advanced.sort}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, sort: e.target.value })
                    }
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  >
                    <option value="date_desc">Päivä (uusin)</option>
                    <option value="date_asc">Päivä (vanhin)</option>
                    <option value="amount_desc">Summa (suurin)</option>
                    <option value="amount_asc">Summa (pienin)</option>
                    <option value="created_desc">Lisätty (uusin)</option>
                  </select>
                </div>
              </div>

              <div className="field-grid">
                <div>
                  <label htmlFor="receipt-min-amount" className="block text-xs text-warm-gray mb-1">
                    Summa alkaen (€)
                  </label>
                  <input
                    id="receipt-min-amount"
                    type="text"
                    inputMode="decimal"
                    value={advanced.minAmount}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, minAmount: e.target.value })
                    }
                    placeholder="0"
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="receipt-max-amount" className="block text-xs text-warm-gray mb-1">
                    Summa asti (€)
                  </label>
                  <input
                    id="receipt-max-amount"
                    type="text"
                    inputMode="decimal"
                    value={advanced.maxAmount}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, maxAmount: e.target.value })
                    }
                    placeholder="—"
                    className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setAdvanced(emptyAdvanced);
                    setAppliedAdvanced(emptyAdvanced);
                    setAdvancedOpen(false);
                  }}
                >
                  Tyhjennä
                </Button>
                <Button type="button" className="flex-1" onClick={applyAdvanced}>
                  Käytä suodattimia
                </Button>
              </div>
              </div>
              )}
            </div>
          </div>
        </div>

          {hasFilters && (
            <div className="flex flex-wrap items-center gap-2">
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.clear}
                  aria-label={`Poista suodatin ${chip.label}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blush/50 text-xs text-charcoal"
                >
                  {chip.label}
                  <span className="text-warm-gray" aria-hidden>
                    ×
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs text-accent font-medium hover:text-accent-dark"
              >
                Tyhjennä kaikki
              </button>
            </div>
          )}
        </div>

        {actionError && (
          <div
            className={`text-sm rounded-xl px-4 py-3 space-y-2 ${
              actionError.includes("epäonnistui 0")
                ? "text-charcoal bg-cream"
                : "text-danger bg-danger/10"
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

        <div className="space-y-3 animate-in-delay-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {receipts.length > 0 && (
                <label className="relative flex items-center justify-center w-11 h-11 -ml-2.5 rounded-full hover:bg-cream/50 cursor-pointer transition-colors" title="Valitse kaikki">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={selectedIds.size > 0 && selectedIds.size === receipts.length}
                    onChange={() => {
                      if (selectedIds.size === receipts.length) {
                        setSelectedIds(new Set());
                      } else {
                        setSelectedIds(new Set(receipts.map((r) => r.id)));
                      }
                    }}
                  />
                  <div className={`w-[18px] h-[18px] rounded-full border flex items-center justify-center transition-colors ${
                    selectedIds.size > 0
                      ? "bg-charcoal border-charcoal"
                      : "bg-white border-warm-gray-light peer-focus-visible:ring-2 peer-focus-visible:ring-charcoal/20"
                  }`}>
                    {selectedIds.size > 0 && selectedIds.size === receipts.length && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                    {selectedIds.size > 0 && selectedIds.size < receipts.length && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
                      </svg>
                    )}
                  </div>
                  <span className="sr-only">Valitse kaikki</span>
                </label>
              )}
              <h3 className="text-sm font-medium text-charcoal">
                {loadingList ? "Ladataan..." : receiptCountLabel(receiptCount, hasFilters)}
              </h3>
            </div>
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
            <div className="space-y-2">
              {(showAllReceipts
                ? receipts
                : receipts.slice(0, RECENT_LIMIT)
              ).map((r, i) => (
                <div key={r.id} className={`bg-white border border-warm-gray-light/30 rounded-3xl shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 stagger-${(i % 5) + 1} relative`}>
                  <div className="absolute left-[7px] top-[9px] z-10 flex items-center justify-center">
                    <label className="relative flex items-center justify-center w-11 h-11 cursor-pointer">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelection(r.id)}
                      />
                      <div className="w-[18px] h-[18px] rounded-full border border-warm-gray-light bg-white peer-checked:bg-charcoal peer-checked:border-charcoal peer-focus-visible:ring-2 peer-focus-visible:ring-charcoal/20 transition-colors flex items-center justify-center">
                        <svg className={`w-2.5 h-2.5 text-white transition-opacity ${selectedIds.has(r.id) ? 'opacity-100' : 'opacity-0'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      </div>
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId((id) => (id === r.id ? null : r.id))
                    }
                    className="w-full text-left outline-none pl-12 pr-5 pt-5 pb-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent transition-colors hover:bg-cream/20"
                    aria-expanded={expandedId === r.id}
                  >
                    <div className="flex justify-between items-start gap-4">
                      <div className="min-w-0">
                        <p className="text-base font-medium text-charcoal truncate tracking-tight">
                          {r.vendor || "Tuntematon"}
                        </p>
                        <p className="text-sm text-warm-gray mt-1">
                          {r.date
                            ? new Date(r.date).toLocaleDateString("fi-FI")
                            : "–"}{" "}
                          · {r.category ? categoryLabel(r.category) : "–"}
                        </p>
                        <div className="mt-2.5 flex items-center gap-2">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            r.match.status === "linked"
                              ? "bg-success/10 text-success"
                              : r.match.status === "suggested" || r.match.matchCandidates?.length
                                ? "bg-warning/10 text-warning"
                                : "bg-warm-gray-light/30 text-warm-gray"
                          }`}>
                            {r.match.status === "linked"
                              ? "Linkitetty"
                              : r.match.status === "suggested"
                                ? "Ehdotus"
                                : r.match.matchCandidates?.length
                                  ? "Ehdotuksia"
                                  : "Ei linkitystä"}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 pt-0.5">
                        <p
                          className={`text-lg font-medium tracking-tight ${
                            r.type === "tulo" ? "text-success" : "text-charcoal"
                          }`}
                        >
                          {r.type === "tulo" ? "+" : ""}
                          {r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                        </p>
                      </div>
                    </div>
                  </button>

                  <div className={`accordion-wrapper ${expandedId === r.id ? "expanded" : ""}`}>
                    <div className="accordion-content bg-white">
                      <div className="px-5 pb-5 space-y-4">
                        <div className="bg-cream/40 rounded-2xl p-4 border border-warm-gray-light/20 space-y-3">
                          <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                            <div>
                              <dt className="text-warm-gray mb-0.5 uppercase tracking-wider text-[10px] font-medium">Tiedosto</dt>
                              <dd className="text-charcoal truncate">{r.fileName}</dd>
                            </div>
                            <div>
                              <dt className="text-warm-gray mb-0.5 uppercase tracking-wider text-[10px] font-medium">Lähde</dt>
                              <dd className="text-charcoal">
                                {r.source === "ai"
                                  ? "AI"
                                  : r.source === "ocr"
                                    ? "OCR"
                                    : "Manuaalinen"}
                              </dd>
                            </div>
                            {r.invoiceNumber && (
                              <div>
                                <dt className="text-warm-gray mb-0.5 uppercase tracking-wider text-[10px] font-medium">Laskun nro</dt>
                                <dd className="text-charcoal">{r.invoiceNumber}</dd>
                              </div>
                            )}
                            {r.reference && (
                              <div>
                                <dt className="text-warm-gray mb-0.5 uppercase tracking-wider text-[10px] font-medium">Viite</dt>
                                <dd className="text-charcoal">{r.reference}</dd>
                              </div>
                            )}
                          </dl>
                        </div>

                        <ReceiptMatchPanel
                          match={r.match}
                          linkedTransaction={r.linkedTransaction}
                          compact
                          busy={matchBusyId === r.id}
                          onConfirm={(txId) => handleMatchConfirm(r.id, txId)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="px-3 py-1 border-t border-warm-gray-light/20 flex gap-2 bg-white/50">
                    <Link
                      href={`/kuitit/${r.id}`}
                      className="min-h-11 inline-flex items-center px-2 text-sm font-medium text-warm-gray hover:text-charcoal transition-colors active:scale-95"
                    >
                      Muokkaa
                    </Link>
                    <button
                      type="button"
                      onClick={() => setReceiptToDelete(r.id)}
                      disabled={deletingId === r.id}
                      className="min-h-11 inline-flex items-center px-2 text-sm font-medium text-danger/80 hover:text-danger transition-colors disabled:opacity-50 active:scale-95"
                    >
                      {deletingId === r.id ? "Poistetaan..." : "Poista"}
                    </button>
                  </div>
                </div>
              ))}
              {receipts.length > RECENT_LIMIT && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setShowAllReceipts((v) => !v)}
                >
                  {showAllReceipts
                    ? "Näytä vähemmän"
                    : `Katso kaikki (${receipts.length})`}
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
                  {loadingMore
                    ? "Ladataan..."
                    : `Lataa lisää (${receipts.length} / ${receiptCount})`}
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
        <div className="fixed bottom-[calc(var(--app-tab-height)+var(--safe-bottom)+0.75rem)] left-1/2 -translate-x-1/2 z-[60] animate-in slide-in-from-bottom-8 fade-in duration-300">
          <div className="bg-charcoal text-white rounded-full px-4 py-3 flex items-center gap-4 shadow-xl border border-white/10">
            <span className="text-sm font-medium pl-2">{selectedIds.size} valittu</span>
            <div className="w-px h-4 bg-white/20" />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-sm px-3 py-1.5 rounded-full hover:bg-white/10 transition-colors active:scale-95"
              >
                Peruuta
              </button>
              <button
                type="button"
                onClick={() => setShowBulkConfirm(true)}
                disabled={bulkDeleting}
                className="text-sm font-medium px-4 py-1.5 rounded-full bg-danger text-white hover:bg-danger/90 transition-colors disabled:opacity-50 active:scale-95"
              >
                {bulkDeleting ? "Poistetaan..." : "Poista"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
