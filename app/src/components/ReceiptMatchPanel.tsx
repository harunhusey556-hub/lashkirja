"use client";

import { StatusTag } from "@/components/ds";
import { formatEur } from "@/lib/format";

export interface BankTxMatch {
  id: string;
  date: string | null;
  counterparty: string | null;
  amount: number;
  matchScore?: number | null;
  matchReasons?: string[] | null;
  score?: number;
  reasons?: string[];
  statement?: { periodMonth: string | null; fileName: string } | null;
}

export interface ReceiptMatchData {
  status: "linked" | "suggested" | "unlinked";
  suggestedTransaction?: BankTxMatch | null;
  matchCandidates?: BankTxMatch[];
  /** List GET does not score candidates. The open row loads them. */
  candidatesDeferred?: boolean;
}


function txLabel(tx: BankTxMatch): string {
  const parts = [tx.counterparty || "Pankkitapahtuma"];
  if (tx.date) parts.push(new Date(tx.date).toLocaleDateString("fi-FI"));
  parts.push(formatEur(tx.amount));
  return parts.join(" · ");
}

function reasonLabel(reasons: string[] | null | undefined): string {
  if (!reasons?.length) return "";
  const labels: Record<string, string> = {
    viite: "viite",
    amount: "summa",
    vendor: "myyjä",
    date: "päivä",
  };
  return reasons.map((r) => labels[r] || r).join(", ");
}

function isStrongMatch(
  score: number | null | undefined,
  reasons: string[] | null | undefined
): boolean {
  if (score != null && score >= 0.85) return true;
  return Boolean(reasons?.includes("viite") && reasons?.includes("amount"));
}

interface ReceiptMatchPanelProps {
  match: ReceiptMatchData;
  linkedTransaction?: BankTxMatch | null;
  /** True in the kuitit list row's expanded panel, which already supplies its own
   * padding; false in the receipt editor's "Pankkitapahtuma" Section, which needs
   * this panel to pad its own content. */
  compact?: boolean;
  busy?: boolean;
  onConfirm?: (transactionId: string) => void;
  onUnlink?: () => void;
}

export default function ReceiptMatchPanel({
  match,
  linkedTransaction,
  compact = false,
  busy = false,
  onConfirm,
  onUnlink,
}: ReceiptMatchPanelProps) {
  const linked = linkedTransaction ?? null;
  const pad = compact ? "" : "px-4 py-4";

  if (linked || match.status === "linked") {
    const tx = linked!;
    const strong = isStrongMatch(tx.matchScore, tx.matchReasons);
    return (
      <div className={`space-y-1.5 ${pad}`}>
        <StatusTag tone="success">
          {strong ? "Täsmää pankkitapahtumaan" : "Linkitetty pankkitapahtumaan"}
        </StatusTag>
        <p className={`text-[13px] text-ink ${compact ? "truncate" : ""}`}>
          {txLabel(tx)}
        </p>
        {tx.matchReasons && tx.matchReasons.length > 0 && !compact && (
          <p className="text-[13px] text-ink-2">
            Peruste: {reasonLabel(tx.matchReasons)}
          </p>
        )}
        {onUnlink && (
          <button
            type="button"
            onClick={onUnlink}
            disabled={busy}
            className="min-h-11 inline-flex items-center px-2 -mx-2 text-[13px] font-medium text-accent disabled:opacity-50"
          >
            Poista linkitys
          </button>
        )}
      </div>
    );
  }

  if (match.status === "suggested" && match.suggestedTransaction) {
    const tx = match.suggestedTransaction;
    const strong = isStrongMatch(tx.score ?? tx.matchScore, tx.reasons ?? tx.matchReasons);
    return (
      <div className={`space-y-2 ${pad}`}>
        <StatusTag tone="accent">
          {strong ? "Täsmää, ehdotettu tapahtuma" : "Ehdotettu pankkitapahtuma"}
        </StatusTag>
        {onConfirm ? (
          <button
            type="button"
            onClick={() => onConfirm(tx.id)}
            disabled={busy}
            className="active-press w-full text-left disabled:opacity-50"
          >
            <p className="text-[13px] text-ink">{txLabel(tx)}</p>
            {(tx.reasons ?? tx.matchReasons)?.length ? (
              <p className="mt-0.5 text-[13px] text-ink-2">
                {reasonLabel(tx.reasons ?? tx.matchReasons)} ·{" "}
                {Math.round((tx.score ?? tx.matchScore ?? 0) * 100)} %
              </p>
            ) : null}
            <p className="mt-1 text-[13px] font-medium text-success">Napauta linkittääksesi</p>
          </button>
        ) : (
          <p className="text-[13px] text-ink">{txLabel(tx)}</p>
        )}
      </div>
    );
  }

  const candidates = match.matchCandidates ?? [];
  if (match.candidatesDeferred && candidates.length === 0) {
    return <p className={`text-[13px] text-ink-2 ${pad}`}>Ladataan ehdotuksia…</p>;
  }
  if (candidates.length === 0) {
    return (
      <p className={`text-[13px] text-ink-2 ${pad}`}>
        Ei löytynyt pankkitapahtumaa, linkitä Tiliotteet-sivulla tai lisää
        tiliote.
      </p>
    );
  }

  return (
    <div className={pad}>
      <p className="pb-1.5 text-[13px] text-ink-2">Mahdolliset pankkitapahtumat:</p>
      <div className="divide-y divide-line">
        {candidates.map((tx) => {
          const strong = isStrongMatch(tx.score, tx.reasons);
          return onConfirm ? (
            <button
              key={tx.id}
              type="button"
              onClick={() => onConfirm(tx.id)}
              disabled={busy}
              className="active-press flex min-h-11 w-full items-center justify-between gap-3 py-2.5 text-left disabled:opacity-50"
            >
              <span className="min-w-0 truncate text-[13px] text-ink">{txLabel(tx)}</span>
              <span className={`shrink-0 text-[13px] ${strong ? "text-success" : "text-ink-2"}`}>
                {reasonLabel(tx.reasons)} · {Math.round((tx.score ?? 0) * 100)} %
              </span>
            </button>
          ) : (
            <div
              key={tx.id}
              className="flex items-center justify-between gap-3 py-2.5 text-[13px] text-ink"
            >
              {txLabel(tx)}
              <span className="text-ink-2"> · {Math.round((tx.score ?? 0) * 100)} %</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
