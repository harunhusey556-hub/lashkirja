"use client";

import { Disclosure } from "@/components/ds/Disclosure";
import { Button, controlClass } from "@/components/ui";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { FilterChips, Icon, SearchField } from "@/components/ds";
import { RECEIPT_CATEGORIES } from "@/lib/receipt-categories";
import {
  receiptTabChips,
  ZERO_RECEIPT_TAB_COUNTS,
  type ReceiptTabCounts,
  type ReceiptTabId,
} from "@/lib/receipt-tabs";

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
const selectLabel = "mb-1.5 block text-caption font-normal text-ink-2";

export function ReceiptFilters({
  monthFilter,
  onMonthChange,
  searchInput,
  onSearchChange,
  filtersOpen,
  onToggleFiltersOpen,
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
  filtersOpen: boolean;
  onToggleFiltersOpen: () => void;
  advanced: ReceiptAdvancedFilters;
  onAdvancedChange: (next: ReceiptAdvancedFilters) => void;
  advancedIsActive: boolean;
  onApplyAdvanced: () => void;
  onClearAdvanced: () => void;
  activeTab: ReceiptTabId;
  /** null while unknown: the chips then show no number rather than a false 0. */
  tabCounts: ReceiptTabCounts | null;
  onTabChange: (id: ReceiptTabId) => void;
  activeChips: { key: string; label: string; clear: () => void }[];
  onClearAll: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* VS-21, R25: one search field, the filters as a chip row directly below it. */}
      <SearchField label="Hae kuitteja" value={searchInput} onChange={onSearchChange} />

      <FilterChips
        label="Suodata kuitteja"
        items={receiptTabChips(tabCounts ?? ZERO_RECEIPT_TAB_COUNTS).map((chip) =>
          tabCounts ? chip : { ...chip, count: undefined }
        )}
        value={activeTab}
        onChange={onTabChange}
      />

      <div>
        <button
          type="button"
          onClick={onToggleFiltersOpen}
          aria-expanded={filtersOpen}
          aria-controls="receipt-filter-panel"
          className={`active-press flex w-full min-h-11 items-center justify-between gap-2 text-left text-caption font-medium ${
            advancedIsActive || monthFilter ? "text-ink" : "text-ink-2"
          }`}
        >
          <span className="flex items-center gap-2">
            <Icon icon={SlidersHorizontal} size="inline" />
            Kuukausi ja tarkemmat suodattimet
          </span>
          <Icon
            icon={ChevronDown}
            size="inline"
            className={`text-ink-2 transition-transform ${filtersOpen ? "rotate-180" : ""}`}
          />
        </button>

        <Disclosure open={filtersOpen}>
          <div id="receipt-filter-panel" className="space-y-3 pt-3">
            <div>
              <label htmlFor="receipt-month-filter" className={selectLabel}>Kuukausi</label>
              {/* lang="fi": the picker names the month in Finnish, whatever the page locale (VS-18). */}
              <input
                id="receipt-month-filter"
                type="month"
                lang="fi"
                value={monthFilter}
                onChange={(e) => onMonthChange(e.target.value)}
                className={field}
              />
            </div>

            <div className="space-y-3 border-t border-line pt-3">
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
          </div>
        </Disclosure>
      </div>

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.clear}
              aria-label={`Poista suodatin ${chip.label}`}
              className="active-press inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-caption text-ink-2"
            >
              {chip.label}
              <span aria-hidden>&times;</span>
            </button>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="active-press inline-flex min-h-11 items-center text-caption font-medium text-accent"
          >
            Tyhjennä kaikki
          </button>
        </div>
      )}
    </div>
  );
}
