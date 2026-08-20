"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import ConfirmModal from "@/components/ConfirmModal";
import ReviewQueue from "@/components/ReviewQueue";
import ReceiptMatchPanel, {
  type ReceiptMatchData,
  type BankTxMatch,
} from "@/components/ReceiptMatchPanel";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import {
  categoryLabel,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";

import { formatEur, formatMonth } from "@/lib/format";
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
  } | null>(null);
  const [monthFilter, setMonthFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState(emptyAdvanced);
  const [appliedAdvanced, setAppliedAdvanced] = useState(emptyAdvanced);
  const [receiptToDelete, setReceiptToDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAllReceipts, setShowAllReceipts] = useState(false);
  const [loadError, setLoadError] = useState<{ query: string; message: string } | null>(null);
  const [actionError, setActionError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [pendingReceipts, setPendingReceipts] = useState<SavedReceipt[]>([]);
  const [bulkReviewing, setBulkReviewing] = useState(false);
  const [loadingPending, setLoadingPending] = useState(true);
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

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/receipts${query ? `?${query}` : ""}`, {
      signal: controller.signal,
    })
      .then((response) =>
        readJson<{ receipts?: SavedReceipt[] }>(
          response,
          "Kuittien lataus epäonnistui"
        )
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoadError(null);
        setListResult({ query, receipts: data.receipts || [] });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError({
          query,
          message: errorMessage(error, "Kuittien lataus epäonnistui"),
        });
      });

    fetch(`/api/receipts?reviewStatus=pending`, { signal: controller.signal })
      .then((res) => readJson<{ receipts?: SavedReceipt[] }>(res, "Virhe"))
      .then((data) => {
        if (!controller.signal.aborted) {
          setPendingReceipts(data.receipts || []);
          setLoadingPending(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadingPending(false);
      });

    return () => controller.abort();
  }, [query, loadAttempt]);

  const receipts = listResult?.query === query ? listResult.receipts : [];
  const currentLoadError = loadError?.query === query ? loadError.message : "";
  const loadingList = listResult?.query !== query && !currentLoadError;

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
    setAppliedAdvanced({ ...advanced });
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
      const res = await fetch("/api/matching/confirm", {
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
    setReceiptToDelete(null);
    setDeletingId(id);
    setActionError("");
    try {
      const res = await fetch(`/api/receipts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        await readJson(res, "Kuitin poistaminen epäonnistui");
      }
      setListResult((previous) =>
        previous
          ? {
              ...previous,
              receipts: previous.receipts.filter((receipt) => receipt.id !== id),
            }
          : previous
      );
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kuitin poistaminen epäonnistui"));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleReview(id: string, status: "approved" | "rejected") {
    setActionError("");
    try {
      const res = await fetch(`/api/receipts/${id}/review`, {
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
      const res = await fetch("/api/receipts/batch-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: ids }),
      });
      if (!res.ok) {
        await readJson(res, "Kaikkien kuittein hyväksyntä epäonnistui");
      }
      setLoadAttempt((a) => a + 1);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kaikkien kuittein hyväksyntä epäonnistui"));
    } finally {
      setBulkReviewing(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    setActionError("");
    try {
      const res = await fetch("/api/receipts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds: Array.from(selectedIds) }),
      });
      if (!res.ok) await readJson(res, "Poisto epäonnistui");
      
      setListResult((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          receipts: prev.receipts.filter((r) => !selectedIds.has(r.id)),
        };
      });
      setSelectedIds(new Set());
      setShowBulkConfirm(false);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Poisto epäonnistui"));
    } finally {
      setBulkDeleting(false);
    }
  }

  const hasFilters = activeChips.length > 0;

  // Split the review queue by where the document came from.
  const emailPending = pendingReceipts.filter((r) => r.source === "email_sync");
  const otherPending = pendingReceipts.filter(
    (r) => r.source !== "email_sync" && r.source !== "auto_income"
  );

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2">
          <h2 className="text-xl font-medium text-charcoal tracking-tight">Kuitit & laskut</h2>
          <Link
            href="/kuitit/uusi"
            className="h-10 px-4 rounded-full bg-charcoal text-white text-sm font-medium hover:bg-charcoal/90 transition-all active:scale-95 inline-flex items-center gap-1.5 shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
            </svg>
            Lisää
          </Link>
        </div>

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

        <div className="animate-in fade-in slide-in-from-top-3 stagger-1">
          <div className="flex gap-2 p-1.5 bg-white border border-warm-gray-light/30 rounded-3xl overflow-x-auto scrollbar-none shadow-sm" role="tablist">
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "" }));
              }}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                !appliedAdvanced.type && !appliedAdvanced.linkedStatus ? "bg-charcoal text-white shadow-sm" : "text-charcoal hover:bg-cream/50"
              }`}
            >
              Kaikki
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "tulo", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "tulo", linkedStatus: "" }));
              }}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                appliedAdvanced.type === "tulo" ? "bg-charcoal text-white shadow-sm" : "text-charcoal hover:bg-cream/50"
              }`}
            >
              Myynnit
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "meno", linkedStatus: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "meno", linkedStatus: "" }));
              }}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                appliedAdvanced.type === "meno" ? "bg-charcoal text-white shadow-sm" : "text-charcoal hover:bg-cream/50"
              }`}
            >
              Ostot
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "linked" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "linked" }));
              }}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                appliedAdvanced.linkedStatus === "linked" ? "bg-charcoal text-white shadow-sm" : "text-charcoal hover:bg-cream/50"
              }`}
            >
              Linkitetty
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "", linkedStatus: "unlinked" }));
                setAppliedAdvanced((a) => ({ ...a, type: "", linkedStatus: "unlinked" }));
              }}
              className={`shrink-0 px-4 py-2 text-sm font-medium rounded-full transition-colors ${
                appliedAdvanced.linkedStatus === "unlinked" ? "bg-charcoal text-white shadow-sm" : "text-charcoal hover:bg-cream/50"
              }`}
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
                    className="w-full h-11 px-4 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                  />
                </div>

              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={monthFilter}
                  onChange={(e) => setMonthFilter(e.target.value)}
                  className="flex-1 h-11 px-4 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                  aria-label="Kuukausi"
                />
                <button
                  type="button"
                  onClick={() => {
                    setAdvanced({ ...appliedAdvanced });
                    setAdvancedOpen((v) => !v);
                  }}
                  className={`h-11 px-4 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap shadow-sm ${
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
              <div className="grid grid-cols-2 gap-3">
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
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
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
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
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

              <div className="grid grid-cols-2 gap-3">
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
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
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
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  >
                    <option value="date_desc">Päivä (uusin)</option>
                    <option value="date_asc">Päivä (vanhin)</option>
                    <option value="amount_desc">Summa (suurin)</option>
                    <option value="amount_asc">Summa (pienin)</option>
                    <option value="created_desc">Lisätty (uusin)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="receipt-min-amount" className="block text-xs text-warm-gray mb-1">
                    Summa alkaen (€)
                  </label>
                  <input
                    id="receipt-min-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={advanced.minAmount}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, minAmount: e.target.value })
                    }
                    placeholder="0"
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="receipt-max-amount" className="block text-xs text-warm-gray mb-1">
                    Summa asti (€)
                  </label>
                  <input
                    id="receipt-max-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={advanced.maxAmount}
                    onChange={(e) =>
                      setAdvanced({ ...advanced, maxAmount: e.target.value })
                    }
                    placeholder="—"
                    className="w-full px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdvanced(emptyAdvanced);
                    setAppliedAdvanced(emptyAdvanced);
                    setAdvancedOpen(false);
                  }}
                  className="flex-1 py-2 rounded-xl border border-warm-gray-light text-xs text-warm-gray hover:bg-cream"
                >
                  Tyhjennä
                </button>
                <button
                  type="button"
                  onClick={applyAdvanced}
                  className="flex-1 py-2 rounded-xl bg-accent text-white text-xs font-medium hover:bg-accent-dark"
                >
                  Käytä suodattimia
                </button>
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
            className="text-sm text-danger bg-danger/10 rounded-xl px-4 py-3"
            role="alert"
          >
            {actionError}
          </div>
        )}

        <div className="space-y-3 animate-in-delay-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {receipts.length > 0 && (
                <label className="relative flex items-center justify-center w-8 h-8 -ml-2 rounded-full hover:bg-cream/50 cursor-pointer transition-colors" title="Valitse kaikki">
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
                {loadingList
                  ? "Ladataan..."
                  : `${receipts.length} kuittia${hasFilters ? " (suodatettu)" : ""}`}
              </h3>
            </div>
          </div>

          {currentLoadError ? (
            <ErrorState
              message={currentLoadError}
              onRetry={() => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
              }}
              compact
            />
          ) : loadingList ? (
            <LoadingState label="Ladataan kuitteja..." compact />
          ) : receipts.length === 0 ? (
            <div className="text-center py-8 space-y-3">
              <p className="text-sm text-warm-gray">
                {hasFilters
                  ? "Ei kuitteja näillä suodattimilla"
                  : "Ei kuitteja vielä"}
              </p>
              {hasFilters ? (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="text-sm font-medium text-accent hover:text-accent-dark"
                >
                  Tyhjennä suodattimet
                </button>
              ) : (
                <Link
                  href="/kuitit/uusi"
                  className="min-h-11 text-sm font-medium text-accent hover:text-accent-dark inline-flex items-center"
                >
                  Lisää ensimmäinen kuitti
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {(showAllReceipts
                ? receipts
                : receipts.slice(0, RECENT_LIMIT)
              ).map((r, i) => (
                <div key={r.id} className={`bg-white border border-warm-gray-light/30 rounded-3xl shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 stagger-${(i % 5) + 1} relative`}>
                  <div className="absolute left-5 top-[22px] z-10 flex items-center justify-center">
                    <label className="relative flex items-center justify-center cursor-pointer">
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
                              ? "bg-[#e8f1ec] text-success"
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

                  <div className="px-5 py-3 border-t border-warm-gray-light/20 flex gap-4 bg-white/50">
                    <Link
                      href={`/kuitit/${r.id}`}
                      className="text-sm font-medium text-warm-gray hover:text-charcoal transition-colors active:scale-95"
                    >
                      Muokkaa
                    </Link>
                    <button
                      type="button"
                      onClick={() => setReceiptToDelete(r.id)}
                      disabled={deletingId === r.id}
                      className="text-sm font-medium text-danger/80 hover:text-danger transition-colors disabled:opacity-50 active:scale-95"
                    >
                      {deletingId === r.id ? "Poistetaan..." : "Poista"}
                    </button>
                  </div>
                </div>
              ))}
              {receipts.length > RECENT_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAllReceipts((v) => !v)}
                  className="w-full py-2 text-xs font-medium text-accent hover:text-accent-dark transition-colors"
                >
                  {showAllReceipts
                    ? "Näytä vähemmän"
                    : `Katso kaikki (${receipts.length})`}
                </button>
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
        <div className="fixed bottom-[calc(var(--app-tab-height)+env(safe-area-inset-bottom,0px)+0.75rem)] left-1/2 -translate-x-1/2 z-[60] animate-in slide-in-from-bottom-8 fade-in duration-300">
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
    </AppShell>
  );
}
