"use client";

import { Button, controlClass } from "@/components/ui";
import { FilterChips } from "@/components/ds";
import { RECEIPT_CATEGORIES } from "@/lib/receipt-categories";
import { receiptTabChips, type ReceiptTabCounts, type ReceiptTabId } from "@/lib/receipt-tabs";

export interface ReceiptAdvancedFilters {
  type: string;
  category: string;
  source: string;
  minAmount: string;
  maxAmount: string;
  sort: string;
  linkedStatus: string;
}

const field = `${controlClass} min-h-12`;
const selectLabel = "mb-1 block text-[13px] text-ink-2";

export function ReceiptFilters({
  monthFilter,
  onMonthChange,
  searchInput,
  onSearchChange,
  isSearchOpen,
  onToggleSearchOpen,
  advancedOpen,
  onToggleAdvancedOpen,
  advanced,
  onAdvancedChange,
  advancedIsActive,
  onApplyAdvanced,
  onClearAdvanced,
  activeTab,
  tabCounts,
  onTabChange,
  activeChips,
  onClearAll,
}: {
  monthFilter: string;
  onMonthChange: (value: string) => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  isSearchOpen: boolean;
  onToggleSearchOpen: () => void;
  advancedOpen: boolean;
  onToggleAdvancedOpen: () => void;
  advanced: ReceiptAdvancedFilters;
  onAdvancedChange: (next: ReceiptAdvancedFilters) => void;
  advancedIsActive: boolean;
  onApplyAdvanced: () => void;
  onClearAdvanced: () => void;
  activeTab: ReceiptTabId;
  tabCounts: ReceiptTabCounts;
  onTabChange: (id: ReceiptTabId) => void;
  activeChips: { key: string; label: string; clear: () => void }[];
  onClearAll: () => void;
}) {
  return (
    <div className="space-y-3">
      <FilterChips
        label="Suodata kuitteja"
        items={receiptTabChips(tabCounts)}
        value={activeTab}
        onChange={onTabChange}
      />

      <div>
        <button
          type="button"
          onClick={onToggleSearchOpen}
          aria-expanded={isSearchOpen}
          aria-controls="kuitit-search-panel"
          className="active-press flex w-full min-h-11 items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
            </svg>
            Hae ja suodata kuitteja
          </span>
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
            className={`h-4 w-4 text-ink-2 transition-transform ${isSearchOpen ? "rotate-180" : ""}`}
          >
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
          </svg>
        </button>

        {isSearchOpen && (
          <div id="kuitit-search-panel" className="space-y-3 pt-3">
            <input
              aria-label="Hae kuitteja"
              type="search"
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Hae myyjää, tiedostoa tai kategoriaa"
              className={field}
            />

            <div className="flex items-center gap-2">
              <input
                type="month"
                value={monthFilter}
                onChange={(e) => onMonthChange(e.target.value)}
                className={`min-w-0 flex-1 ${field}`}
                aria-label="Kuukausi"
              />
              <button
                type="button"
                onClick={() => {
                  onAdvancedChange({ ...advanced });
                  onToggleAdvancedOpen();
                }}
                aria-expanded={advancedOpen}
                aria-controls="advanced-receipt-filters"
                className={`active-press min-h-12 shrink-0 whitespace-nowrap rounded-card border px-4 text-[15px] font-medium ${
                  advancedOpen || advancedIsActive ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"
                }`}
              >
                Edistyneet
              </button>
            </div>

            {advancedOpen && (
              <div id="advanced-receipt-filters" className="space-y-3 border-t border-line pt-3">
                <div className="field-grid">
                  <div>
                    <label htmlFor="receipt-type-filter" className={selectLabel}>Tyyppi</label>
                    <select
                      id="receipt-type-filter"
                      value={advanced.type}
                      onChange={(e) => onAdvancedChange({ ...advanced, type: e.target.value })}
                      className={field}
                    >
                      <option value="">Kaikki</option>
                      <option value="meno">Meno</option>
                      <option value="tulo">Tulo</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="receipt-category-filter" className={selectLabel}>Kategoria</label>
                    <select
                      id="receipt-category-filter"
                      value={advanced.category}
                      onChange={(e) => onAdvancedChange({ ...advanced, category: e.target.value })}
                      className={field}
                    >
                      <option value="">Kaikki</option>
                      {RECEIPT_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="field-grid">
                  <div>
                    <label htmlFor="receipt-source-filter" className={selectLabel}>Lähde</label>
                    <select
                      id="receipt-source-filter"
                      value={advanced.source}
                      onChange={(e) => onAdvancedChange({ ...advanced, source: e.target.value })}
                      className={field}
                    >
                      <option value="">Kaikki</option>
                      <option value="ai">AI</option>
                      <option value="ocr">OCR</option>
                      <option value="manual">Manuaalinen</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="receipt-sort-filter" className={selectLabel}>Järjestys</label>
                    <select
                      id="receipt-sort-filter"
                      value={advanced.sort}
                      onChange={(e) => onAdvancedChange({ ...advanced, sort: e.target.value })}
                      className={field}
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
                    <label htmlFor="receipt-min-amount" className={selectLabel}>Summa alkaen (€)</label>
                    <input
                      id="receipt-min-amount"
                      type="text"
                      inputMode="decimal"
                      value={advanced.minAmount}
                      onChange={(e) => onAdvancedChange({ ...advanced, minAmount: e.target.value })}
                      placeholder="0"
                      className={field}
                    />
                  </div>
                  <div>
                    <label htmlFor="receipt-max-amount" className={selectLabel}>Summa asti (€)</label>
                    <input
                      id="receipt-max-amount"
                      type="text"
                      inputMode="decimal"
                      value={advanced.maxAmount}
                      onChange={(e) => onAdvancedChange({ ...advanced, maxAmount: e.target.value })}
                      placeholder="Ei ylärajaa"
                      className={field}
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button type="button" variant="secondary" className="flex-1" onClick={onClearAdvanced}>
                    Tyhjennä
                  </Button>
                  <Button type="button" className="flex-1" onClick={onApplyAdvanced}>
                    Käytä suodattimia
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.clear}
              aria-label={`Poista suodatin ${chip.label}`}
              className="active-press inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[13px] text-ink-2"
            >
              {chip.label}
              <span aria-hidden>&times;</span>
            </button>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="active-press inline-flex min-h-11 items-center text-[13px] font-medium text-accent"
          >
            Tyhjennä kaikki
          </button>
        </div>
      )}
    </div>
  );
}
