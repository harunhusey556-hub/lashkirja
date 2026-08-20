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
  unreported: "bg-warm-gray-light/30 text-warm-gray",
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

  function startEdit(row: MonthRow) {
    setEditing(row.month);
    setDraft(
      row.reportedClosing === null
        ? String(row.computedClosing).replace(".", ",")
        : String(row.reportedClosing).replace(".", ",")
    );
    setError(null);
  }

  async function commit(month: string) {
    const parsed = parseFinnishNumber(draft);
    if (parsed === null) {
      setError("Anna summa, esim. 1250,50.");
      return;
    }
    await onSave(month, parsed);
    setEditing(null);
    setError(null);
  }

  if (months.length === 0) {
    return (
      <p className="text-sm text-warm-gray">
        Ei vielä kuukausia. Lisää tiliote tai kirjaa kuukauden loppusaldo.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {months.map((row) => {
        const isEditing = editing === row.month;
        return (
          <li
            key={row.month}
            className="rounded-2xl border border-warm-gray-light/30 bg-white p-4 space-y-2"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-charcoal">
                  {formatMonthShort(row.month)}
                </p>
                <p className="text-xs text-warm-gray">
                  {row.txCount} tapahtumaa · alkusaldo {formatEur(row.opening)}
                </p>
              </div>
              <span
                className={`shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full ${STATUS_CLASS[row.status]}`}
              >
                {STATUS_LABEL[row.status]}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-warm-gray">Tulot</p>
                <p className="text-charcoal font-medium">{formatEur(row.income)}</p>
              </div>
              <div>
                <p className="text-warm-gray">Menot</p>
                <p className="text-charcoal font-medium">{formatEur(row.expense)}</p>
              </div>
              <div>
                <p className="text-warm-gray">Laskettu loppusaldo</p>
                <p className="text-charcoal font-medium">{formatEur(row.computedClosing)}</p>
              </div>
            </div>

            {isEditing ? (
              <div className="space-y-2">
                <label className="text-xs text-warm-gray" htmlFor={`bal-${row.month}`}>
                  Pankin ilmoittama loppusaldo (€)
                </label>
                <div className="flex gap-2">
                  <input
                    id={`bal-${row.month}`}
                    className="flex-1 px-3 py-2 rounded-xl border border-warm-gray-light/60 text-sm"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    inputMode="decimal"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => void commit(row.month)}
                    disabled={busyMonth === row.month}
                    className="px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
                  >
                    Tallenna
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setError(null);
                    }}
                    className="px-3 py-2 rounded-xl border border-warm-gray-light/60 text-sm"
                  >
                    Peru
                  </button>
                </div>
                {error && <p className="text-xs text-danger">{error}</p>}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="text-xs">
                  <span className="text-warm-gray">Pankin saldo: </span>
                  <span className="text-charcoal font-medium">
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
                    className="text-xs font-medium text-accent"
                  >
                    {row.reportedClosing === null ? "Kirjaa saldo" : "Muokkaa"}
                  </button>
                  {row.reportedClosing !== null && (
                    <button
                      type="button"
                      onClick={() => void onClear(row.month)}
                      disabled={busyMonth === row.month}
                      className="text-xs font-medium text-warm-gray disabled:opacity-50"
                    >
                      Poista
                    </button>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
