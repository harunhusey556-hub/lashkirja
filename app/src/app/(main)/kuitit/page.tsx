"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
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
};

function formatEur(n: number): string {
  return n.toLocaleString("fi-FI", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
}

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
  const [loadingPending, setLoadingPending] = useState(true);
  const [isPendingOpen, setIsPendingOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

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

  const hasFilters = activeChips.length > 0;

  return (
    <>
    <div className="space-y-6">
        <Link
          href="/kuitit/uusi"
          className="pressable flex min-h-12 w-full items-center justify-center rounded-2xl bg-charcoal text-sm font-medium text-white animate-in"
        >
          + Lisää
        </Link>

        {pendingReceipts.length > 0 && (
          <div className="bg-warning/10 border border-warning/20 rounded-2xl p-4 shadow-sm transition-all duration-300">
            <button
              type="button"
              onClick={() => setIsPendingOpen(prev => !prev)}
              className="pressable flex min-h-12 w-full items-center justify-between text-left"
            >
              <div>
                <h3 className="text-sm font-medium text-warning-dark">
                  Tarkastettavat sähköpostikuitit ({pendingReceipts.length})
                </h3>
                <p className="text-xs text-charcoal/80 mt-1">
                  Sähköpostista tuodut kuitit odottavat hyväksyntää ennen kirjanpitoon siirtymistä.
                </p>
              </div>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-5 h-5 text-warning-dark transition-transform duration-300 ${isPendingOpen ? 'rotate-180' : ''}`}
              >
                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
              </svg>
            </button>
            
            {isPendingOpen && (
              <div className="space-y-2 mt-4 animate-in fade-in slide-in-from-top-4 duration-300">
                {pendingReceipts.map(r => (
                  <div key={r.id} className="bg-white rounded-xl p-3 shadow-sm flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-charcoal truncate">{r.vendor || "Tuntematon myyjä"}</p>
                      <p className="text-xs text-warm-gray truncate">
                        {r.date ? new Date(r.date).toLocaleDateString("fi-FI") : "–"} · {r.totalAmount != null ? formatEur(r.totalAmount) : "–"} · {r.fileName}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleReview(r.id, "rejected")}
                        className="pressable min-h-11 rounded-xl border border-danger/30 px-3 text-sm font-medium text-danger"
                      >
                        Hylkää (Yksityinen)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReview(r.id, "approved")}
                        className="pressable min-h-11 rounded-xl bg-success px-3 text-sm font-medium text-white"
                      >
                        Hyväksy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="bg-white/95 backdrop-blur-md rounded-2xl border border-warm-gray-light/25 shadow-sm p-2 animate-in-delay-1">
          <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none" role="tablist">
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "" }));
                setAppliedAdvanced((a) => ({ ...a, type: "" }));
              }}
              className={`pressable flex min-h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${
                !appliedAdvanced.type ? "bg-charcoal text-white shadow-sm" : "bg-cream/80 text-charcoal"
              }`}
            >
              Kaikki kuitit
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "tulo" }));
                setAppliedAdvanced((a) => ({ ...a, type: "tulo" }));
              }}
              className={`pressable flex min-h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${
                appliedAdvanced.type === "tulo" ? "bg-charcoal text-white shadow-sm" : "bg-cream/80 text-charcoal"
              }`}
            >
              Myynnit
            </button>
            <button
              type="button"
              onClick={() => {
                setAdvanced((a) => ({ ...a, type: "meno" }));
                setAppliedAdvanced((a) => ({ ...a, type: "meno" }));
              }}
              className={`pressable flex min-h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${
                appliedAdvanced.type === "meno" ? "bg-charcoal text-white shadow-sm" : "bg-cream/80 text-charcoal"
              }`}
            >
              Ostot
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3 animate-in-delay-1">
          <button
            type="button"
            onClick={() => setIsSearchOpen((v) => !v)}
            className="pressable flex min-h-12 w-full items-center justify-between text-left"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-warm-gray" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
              </svg>
              <span className="text-sm font-medium text-charcoal">Hae ja suodata kuitteja</span>
            </div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-5 h-5 text-warm-gray transition-transform duration-300 ${isSearchOpen ? "rotate-180" : ""}`}
            >
              <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </button>

          {isSearchOpen && (
            <div className="space-y-3 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="relative">
                <input
                  aria-label="Hae kuitteja"
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Hae myyjää, tiedostoa tai kategoriaa..."
                  className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={monthFilter}
                  onChange={(e) => setMonthFilter(e.target.value)}
                  className="min-w-0 flex-1 px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  aria-label="Kuukausi"
                />
                <button
                  type="button"
                  onClick={() => {
                    setAdvanced({ ...appliedAdvanced });
                    setAdvancedOpen((v) => !v);
                  }}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap ${
                    advancedOpen ||
                    appliedAdvanced.type ||
                    appliedAdvanced.category ||
                    appliedAdvanced.source ||
                    appliedAdvanced.minAmount ||
                    appliedAdvanced.maxAmount ||
                    appliedAdvanced.sort !== "date_desc"
                      ? "bg-blush/50 border-accent/30 text-accent-dark"
                      : "bg-white border-warm-gray-light text-charcoal hover:bg-cream"
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
              <div className="form-split">
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

              <div className="form-split">
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

              <div className="form-split">
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
          )}

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
            <h3 className="text-sm font-medium text-charcoal">
              {loadingList
                ? "Ladataan..."
                : `${receipts.length} kuittia${hasFilters ? " (suodatettu)" : ""}`}
            </h3>
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
              ).map((r) => (
                <div key={r.id} className="bg-white rounded-xl p-4 shadow-sm space-y-3 hover-lift transition-all border border-transparent hover:border-slate-100">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId((id) => (id === r.id ? null : r.id))
                    }
                    className="w-full text-left"
                    aria-expanded={expandedId === r.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-charcoal truncate">
                          {r.vendor || "Tuntematon"}
                        </p>
                        <p className="text-xs text-warm-gray">
                          {r.date
                            ? new Date(r.date).toLocaleDateString("fi-FI")
                            : "–"}{" "}
                          · {r.category ? categoryLabel(r.category) : "–"}
                          {r.reference ? ` · viite ${r.reference}` : ""}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`text-sm font-medium ${
                            r.type === "tulo" ? "text-success" : "text-accent"
                          }`}
                        >
                          {r.type === "tulo" ? "+" : "−"}
                          {r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                        </p>
                        <p className="text-[10px] text-warm-gray">
                          {r.match.status === "linked"
                            ? "Linkitetty"
                            : r.match.status === "suggested"
                              ? "Ehdotus"
                              : r.match.matchCandidates?.length
                                ? "Ehdotuksia"
                                : "Ei linkitystä"}
                        </p>
                      </div>
                    </div>
                  </button>

                  {expandedId === r.id && (
                    <div className="space-y-3 border-t border-warm-gray-light/20 pt-3">
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <div>
                          <dt className="text-warm-gray">Tiedosto</dt>
                          <dd className="text-charcoal truncate">{r.fileName}</dd>
                        </div>
                        <div>
                          <dt className="text-warm-gray">Lähde</dt>
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
                            <dt className="text-warm-gray">Laskun nro</dt>
                            <dd className="text-charcoal">{r.invoiceNumber}</dd>
                          </div>
                        )}
                        {r.reference && (
                          <div>
                            <dt className="text-warm-gray">Viite</dt>
                            <dd className="text-charcoal">{r.reference}</dd>
                          </div>
                        )}
                      </dl>

                      <ReceiptMatchPanel
                        match={r.match}
                        linkedTransaction={r.linkedTransaction}
                        compact
                        busy={matchBusyId === r.id}
                        onConfirm={(txId) => handleMatchConfirm(r.id, txId)}
                      />
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Link
                      href={`/kuitit/${r.id}`}
                      className="flex-1 min-h-11 text-xs font-medium rounded-lg border border-warm-gray-light text-charcoal hover:bg-cream transition-colors inline-flex items-center justify-center"
                    >
                      Muokkaa
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedId((id) => (id === r.id ? null : r.id))
                      }
                      className="flex-1 min-h-11 text-xs font-medium rounded-lg border border-warm-gray-light text-charcoal hover:bg-cream transition-colors"
                    >
                      {expandedId === r.id ? "Piilota" : "Tiedot"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReceiptToDelete(r.id)}
                      disabled={deletingId === r.id}
                      className="min-h-11 px-3 text-xs font-medium rounded-lg border border-danger/30 text-danger hover:bg-danger/10 transition-colors disabled:opacity-50"
                    >
                      {deletingId === r.id ? "..." : "Poista"}
                    </button>
                  </div>
                </div>
              ))}
              {receipts.length > RECENT_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAllReceipts((v) => !v)}
                  className="pressable min-h-12 w-full text-sm font-medium text-accent"
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
    </>
  );
}
