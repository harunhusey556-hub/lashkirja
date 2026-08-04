"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAllReceipts, setShowAllReceipts] = useState(false);
  const [loadError, setLoadError] = useState<{ query: string; message: string } | null>(null);
  const [actionError, setActionError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

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

  async function handleDeleteReceipt(id: string) {
    if (!confirm("Poistetaanko tämä kuitti?")) return;
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

  const hasFilters = activeChips.length > 0;

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-light text-charcoal">Kuitit & laskut</h2>
          <Link
            href="/kuitit/uusi"
            className="min-h-11 px-4 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors inline-flex items-center"
          >
            + Lisää
          </Link>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-warm-gray"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"
              />
            </svg>
            <input
              aria-label="Hae kuitteja"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Hae myyjää, tiedostoa tai kategoriaa..."
              className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="month"
              value={monthFilter}
              onChange={(e) => setMonthFilter(e.target.value)}
              className="flex-1 px-3 py-2 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
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

        <div className="space-y-3">
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
                <div key={r.id} className="bg-white rounded-xl p-4 shadow-sm space-y-3">
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
                      onClick={() => handleDeleteReceipt(r.id)}
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
    </AppShell>
  );
}
