"use client";

import { useState } from "react";
import { formatEur, formatEurSigned, formatMonthShort, parseFinnishNumber } from "@/lib/format";

export interface MonthRow {
  month: string;
  opening: number;
  openingSource: "opening_balance" | "reported" | "computed";
  income: number;
  expense: number;
  net: number;
  txCount: number;
  computedClosing: number;
  reportedClosing: number | null;
  difference: number | null;
  status: "reconciled" | "mismatch" | "unreported";
}

const STATUS_LABEL: Record<MonthRow["status"], string> = {
  reconciled: "Täsmää",
  mismatch: "Ero",
  unreported: "Ei saldoa",
};

const STATUS_CLASS: Record<MonthRow["status"], string> = {
  reconciled: "bg-success/10 text-success",
  mismatch: "bg-danger/10 text-danger",
  unreported: "bg-canvas text-ink-2",
};

interface Props {
  months: MonthRow[];
  busyMonth: string | null;
  onSave: (month: string, closingBalance: number) => Promise<void> | void;
  onClear: (month: string) => Promise<void> | void;
}

export function BalanceTable({ months, busyMonth, onSave, onClear }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Keyed separately from `error` (the editor's own validation/save error): "Poista" acts
  // on a row that isn't in edit mode, so it needs its own slot, tagged with which month it
  // failed for (only one row's "Poista" can be in flight at a time - `busyMonth` already
  // enforces that upstream).
  const [clearError, setClearError] = useState<{ month: string; text: string } | null>(null);

  function startEdit(row: MonthRow) {
    setEditing(row.month);
    setDraft(
      row.reportedClosing === null
        ? String(row.computedClosing).replace(".", ",")
        : String(row.reportedClosing).replace(".", ",")
    );
    setError(null);
  }

  // `onSave` rethrows on a server failure (see saveBalance in the Pankkitilit page): this
  // keeps the editor open with whatever the user typed and shows the message right here,
  // under that row's own input - not a banner elsewhere that a scrolled-down sheet can hide.
  async function commit(month: string) {
    const parsed = parseFinnishNumber(draft);
    if (parsed === null) {
      setError("Anna summa, esim. 1250,50.");
      return;
    }
    setError(null);
    try {
      await onSave(month, parsed);
      setEditing(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saldon tallennus epäonnistui.");
    }
  }

  async function handleClear(month: string) {
    setClearError(null);
    try {
      await onClear(month);
    } catch (err) {
      setClearError({
        month,
        text: err instanceof Error ? err.message : "Saldon poisto epäonnistui.",
      });
    }
  }

  if (months.length === 0) {
    return (
      <p className="text-[15px] text-ink-2">
        Ei vielä kuukausia. Lisää tiliote tai kirjaa kuukauden loppusaldo.
      </p>
    );
  }

  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
      {months.map((row) => {
        const isEditing = editing === row.month;
        return (
          <li key={row.month} className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[15px] font-medium text-ink">
                  {formatMonthShort(row.month)}
                </p>
                <p className="text-[13px] text-ink-2">
                  {row.txCount} tapahtumaa · alkusaldo {formatEur(row.opening)}
                </p>
              </div>
              <span
                className={`shrink-0 text-[13px] font-semibold px-2.5 py-1 rounded-full ${STATUS_CLASS[row.status]}`}
              >
                {STATUS_LABEL[row.status]}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-ink-2">Tulot</p>
                <p className="text-ink font-medium">{formatEur(row.income)}</p>
              </div>
              <div>
                <p className="text-ink-2">Menot</p>
                <p className="text-ink font-medium">{formatEur(row.expense)}</p>
              </div>
              <div>
                <p className="text-ink-2">Laskettu loppusaldo</p>
                <p className="text-ink font-medium">{formatEur(row.computedClosing)}</p>
              </div>
            </div>

            {isEditing ? (
              <div className="space-y-2">
                <label className="text-xs text-ink-2" htmlFor={`bal-${row.month}`}>
                  Pankin ilmoittama loppusaldo (€)
                </label>
                <div className="flex gap-2">
                  <input
                    id={`bal-${row.month}`}
                    className="flex-1 px-3 py-2 rounded-card border border-line bg-surface text-sm text-ink"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    inputMode="decimal"
                    autoFocus
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error ? `bal-${row.month}-error` : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => void commit(row.month)}
                    disabled={busyMonth === row.month}
                    className="active-press min-h-11 px-4 py-2 rounded-card bg-ink text-canvas text-sm font-semibold disabled:opacity-50"
                  >
                    Tallenna
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setError(null);
                    }}
                    className="active-press min-h-11 px-3 py-2 rounded-card border border-line text-sm text-ink"
                  >
                    Peru
                  </button>
                </div>
                {error && (
                  <p id={`bal-${row.month}-error`} className="text-xs text-danger" role="alert">
                    {error}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <div className="text-xs">
                    <span className="text-ink-2">Pankin saldo: </span>
                    <span className="text-ink font-medium">
                      {row.reportedClosing === null ? "–" : formatEur(row.reportedClosing)}
                    </span>
                    {row.difference !== null && row.difference !== 0 && (
                      <span className="text-danger font-medium">
                        {" "}
                        (ero {formatEurSigned(row.difference)})
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      className="active-press min-h-11 inline-flex items-center px-2 -mx-2 text-xs font-medium text-accent"
                    >
                      {row.reportedClosing === null ? "Kirjaa saldo" : "Muokkaa"}
                    </button>
                    {row.reportedClosing !== null && (
                      <button
                        type="button"
                        onClick={() => void handleClear(row.month)}
                        disabled={busyMonth === row.month}
                        className="active-press min-h-11 inline-flex items-center px-2 -mx-2 text-xs font-medium text-ink-2 disabled:opacity-50"
                      >
                        Poista
                      </button>
                    )}
                  </div>
                </div>
                {clearError?.month === row.month && (
                  <p className="text-xs text-danger" role="alert">
                    {clearError.text}
                  </p>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
