"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { Button } from "@/components/ui";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import type { ChatMatchBatch, MatchCard } from "@/lib/chat-match-batch";

interface ConfirmResult {
  confirmed: number;
  skipped: number;
  alreadyConfirmed: number;
  skippedPairs: Array<{ transactionId: string; receiptId: string }>;
}

type RowState = "confirmed" | "rejected" | "failed";

const rowButton =
  "active-press inline-flex min-h-11 items-center justify-center rounded-full px-3.5 text-caption font-medium disabled:opacity-60";

const euro = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR" });

function money(cents: number): string {
  return euro.format(Math.abs(cents) / 100);
}

function day(iso: string | null): string {
  return iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("fi-FI", { timeZone: "UTC" }) : "";
}

/** "5 kohdistusehdotusta · 3 varmaa · 2 epäselvää" (singular where Finnish needs it). */
export function batchHeader(batch: Pick<ChatMatchBatch, "confident" | "ambiguous">): string {
  const total = batch.confident + batch.ambiguous;
  return [
    `${total} ${total === 1 ? "kohdistusehdotus" : "kohdistusehdotusta"}`,
    `${batch.confident} ${batch.confident === 1 ? "varma" : "varmaa"}`,
    `${batch.ambiguous} ${batch.ambiguous === 1 ? "epäselvä" : "epäselvää"}`,
  ].join(" · ");
}

export function batchButtonLabel(pending: number): string {
  return `Hyväksy kaikki varmat (${pending})`;
}

/** What the last accept-all did: "Hyväksytty 3 · epäonnistui 1 · aiemmin hyväksytty 2". */
export function batchResultText(result: Pick<ConfirmResult, "confirmed" | "skipped" | "alreadyConfirmed">): string {
  const parts = [`Hyväksytty ${result.confirmed}`, `epäonnistui ${result.skipped}`];
  if (result.alreadyConfirmed > 0) parts.push(`aiemmin hyväksytty ${result.alreadyConfirmed}`);
  return parts.join(" · ");
}

async function post<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(response, fallback);
}

/**
 * The chat's list of match proposals: confident pairs are accepted in one tap
 * (the exact pairs shown go to /api/matching/confirm-all), ambiguous rows need
 * a per-row choice and are never part of that tap.
 */
export function MatchBatchCard({ batch }: { batch: ChatMatchBatch }) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [result, setResult] = useState<Pick<ConfirmResult, "confirmed" | "skipped" | "alreadyConfirmed"> | null>(null);
  const [error, setError] = useState("");

  const pending = batch.pairs.filter((pair) => !rows[pair.transactionId]);

  function fail(cause: unknown, fallback: string) {
    if (isUnauthorized(cause)) {
      redirectToLogin();
      return;
    }
    setError(errorMessage(cause, fallback));
  }

  async function confirmAll() {
    if (pending.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setError("");
    try {
      const data = await post<ConfirmResult>("/api/matching/confirm-all", { pairs: pending }, "Kohdistusten hyväksyntä epäonnistui");
      const skipped = new Set((data.skippedPairs ?? []).map((pair) => pair.transactionId));
      setRows((prev) => {
        const next = { ...prev };
        for (const pair of pending) next[pair.transactionId] = skipped.has(pair.transactionId) ? "failed" : "confirmed";
        return next;
      });
      setResult((prev) => ({
        confirmed: (prev?.confirmed ?? 0) + data.confirmed,
        skipped: (prev?.skipped ?? 0) + data.skipped,
        alreadyConfirmed: (prev?.alreadyConfirmed ?? 0) + (data.alreadyConfirmed ?? 0),
      }));
    } catch (cause) {
      fail(cause, "Kohdistusten hyväksyntä epäonnistui");
    } finally {
      setBulkBusy(false);
    }
  }

  async function acceptRow(card: MatchCard) {
    if (!card.receiptId) return;
    setBusyRow(card.transactionId);
    setError("");
    try {
      const data = await post<ConfirmResult>(
        "/api/matching/confirm-all",
        { pairs: [{ transactionId: card.transactionId, receiptId: card.receiptId }] },
        "Kohdistus epäonnistui"
      );
      setRows((prev) => ({ ...prev, [card.transactionId]: data.skipped > 0 ? "failed" : "confirmed" }));
    } catch (cause) {
      fail(cause, "Kohdistus epäonnistui");
    } finally {
      setBusyRow(null);
    }
  }

  async function rejectRow(card: MatchCard) {
    if (!card.receiptId) return;
    setBusyRow(card.transactionId);
    setError("");
    try {
      await post("/api/matching/reject", { transactionId: card.transactionId, receiptId: card.receiptId }, "Hylkäyksen tallennus epäonnistui");
      setRows((prev) => ({ ...prev, [card.transactionId]: "rejected" }));
    } catch (cause) {
      fail(cause, "Hylkäyksen tallennus epäonnistui");
    } finally {
      setBusyRow(null);
    }
  }

  /** An ambiguous row has no stored suggestion: the owner's pick is a manual confirm. */
  async function chooseOption(card: MatchCard, receiptId: string) {
    setBusyRow(card.transactionId);
    setError("");
    try {
      await post("/api/matching/confirm", { transactionId: card.transactionId, receiptId }, "Kohdistus epäonnistui");
      setRows((prev) => ({ ...prev, [card.transactionId]: "confirmed" }));
    } catch (cause) {
      fail(cause, "Kohdistus epäonnistui");
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <div className="mt-1 w-full max-w-[95%] space-y-3 rounded-card border border-line bg-surface p-4">
      <p className="flex items-center gap-2 text-caption font-semibold text-accent">
        <Icon icon={Link2} size="inline" />
        {batchHeader(batch)}
      </p>
      <Button
        busy={bulkBusy}
        busyLabel="Yhdistetään…"
        disabled={pending.length === 0}
        className="w-full"
        onClick={() => void confirmAll()}
      >
        {batchButtonLabel(pending.length)}
      </Button>
      {batch.truncated && (
        <p className="text-caption text-ink-2">
          Lista näyttää vain osan ehdotuksista. Painike hyväksyy kaikki {batch.confident} varmaa; loput löytyvät kysymällä uudelleen.
        </p>
      )}
      <div role="status" aria-live="polite">
        {result && <p className="text-caption font-medium text-success">{batchResultText(result)}</p>}
        {error && <p className="text-caption font-medium text-danger">{error}</p>}
      </div>
      <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
        {batch.cards.map((card) => {
          const state = rows[card.transactionId];
          const busy = busyRow === card.transactionId;
          return (
            <li key={`${card.transactionId}:${card.receiptId ?? "?"}`} className="rounded-card bg-ink/5 p-3 text-caption leading-relaxed text-ink">
              {card.ambiguous ? (
                <>
                  <p className="font-semibold">
                    {card.bankRow.counterparty ?? "Tuntematon siirto"} · {money(card.bankRow.amountCents)} · {day(card.bankRow.date)}
                  </p>
                  <p className="text-ink-2">Epäselvä: kaksi yhtä hyvää kuittia, valitse itse.</p>
                  {state === "confirmed" ? (
                    <p className="flex items-center gap-1.5 font-medium text-success">
                      <Icon icon={Check} size="inline" />
                      Hyväksytty
                    </p>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {card.options?.map((option) => (
                        <button
                          key={option.receiptId}
                          type="button"
                          disabled={busy}
                          className={`${rowButton} bg-accent-soft text-accent`}
                          onClick={() => void chooseOption(card, option.receiptId)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="font-semibold">
                    {card.receipt?.label} → {card.bankRow.counterparty ?? "Tuntematon siirto"}
                  </p>
                  <p>
                    {money(card.bankRow.amountCents)} · {day(card.bankRow.date)}
                    {card.confidence != null ? ` · ${Math.round(card.confidence * 100)} %` : ""}
                  </p>
                  {card.reasons.length > 0 && <p className="text-ink-2">{card.reasons.join(" · ")}</p>}
                  {state === "confirmed" && (
                    <p className="flex items-center gap-1.5 font-medium text-success">
                      <Icon icon={Check} size="inline" />
                      Hyväksytty
                    </p>
                  )}
                  {state === "rejected" && <p className="text-ink-2">Hylätty</p>}
                  {state === "failed" && <p className="font-medium text-danger">Ei onnistunut: ehdotus ei ole enää voimassa</p>}
                  {!state && (
                    <div className="mt-1 flex gap-2">
                      <button type="button" disabled={busy || bulkBusy} className={`${rowButton} bg-accent-soft text-accent`} onClick={() => void acceptRow(card)}>
                        Hyväksy
                      </button>
                      <button type="button" disabled={busy || bulkBusy} className={`${rowButton} bg-ink/5 text-ink-2`} onClick={() => void rejectRow(card)}>
                        Hylkää
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
