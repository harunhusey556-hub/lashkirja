"use client";

import { useState } from "react";
import Link from "next/link";
import BottomSheet from "@/components/BottomSheet";
import { Button, buttonClass } from "@/components/ui";
import { KeyValueList } from "@/components/ds";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatDate, formatEur, formatEurSigned } from "@/lib/format";
import { receiptLabel } from "@/lib/statement-client";
import { rowState, type FeedRow } from "@/lib/bank-feed";
import { detailHref } from "@/lib/routes";
import { requestReceiptCapture } from "@/lib/capture-request";
import { hapticImpact, hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";

type Action =
  | { url: "/api/receipts/batch-approve"; body: { receiptIds: string[] } }
  | { url: "/api/matching/confirm" | "/api/matching/reject"; body: { transactionId: string; receiptId: string } }
  | { url: "/api/matching/ignore"; body: { transactionId: string; ignored: boolean } }
  | { url: "/api/matching/unlink"; body: { transactionId: string } };

const QUIET_LINK =
  "active-press mx-auto flex min-h-11 items-center px-3 text-caption text-ink-2 disabled:opacity-50";

/**
 * One bank row, one decision. The sheet shows only what this row needs:
 * a recognised sale gets "Hyväksy", a missing kuitti gets the camera, a
 * linked row can be unlinked. Editing or deleting the row itself lives on the
 * tiliote ("Avaa tiliote"), out of the everyday path.
 */
export function BankRowSheet({
  row,
  onClose,
  onChanged,
}: {
  row: FeedRow | null;
  onClose: () => void;
  /** After a change; `rowId` lets the list animate that row out. */
  onChanged: (rowId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // A fresh sheet for every row.
  const [prevRow, setPrevRow] = useState(row?.id ?? null);
  if (prevRow !== (row?.id ?? null)) {
    setPrevRow(row?.id ?? null);
    setBusy(null);
    setError("");
  }

  async function run(key: string, action: Action, done?: string): Promise<boolean> {
    if (!row || busy) return false;
    setBusy(key);
    setError("");
    try {
      const res = await apiFetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body),
      });
      const data = await readJson<{ failedCount?: number; failed?: { error?: string }[] }>(
        res,
        "Muutos ei onnistunut"
      );
      if ((data.failedCount ?? 0) > 0) {
        throw new Error(data.failed?.[0]?.error || "Muutos ei onnistunut");
      }
      void hapticNotify("success");
      if (done) showToast({ tone: "success", text: done });
      onChanged(row.id);
      onClose();
      return true;
    } catch (err: unknown) {
      if (isUnauthorized(err)) {
        redirectToLogin();
        return false;
      }
      void hapticNotify("error");
      setError(errorMessage(err, "Muutos ei onnistunut. Yritä uudelleen."));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function ignoreWithUndo(target: FeedRow) {
    void hapticImpact("light");
    const ok = await run("ignore", { url: "/api/matching/ignore", body: { transactionId: target.id, ignored: true } });
    if (!ok) return;
    showToast({
      tone: "success",
      text: "Merkitty: kuittia ei tarvita.",
      action: {
        label: "Kumoa",
        onAction: () => {
          void apiFetch("/api/matching/ignore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transactionId: target.id, ignored: false }),
          }).then(() => onChanged(target.id));
        },
      },
    });
  }

  const state = row ? rowState(row) : null;
  const income = row ? row.amount > 0 : false;

  return (
    <BottomSheet
      isOpen={row !== null}
      onClose={onClose}
      title={row?.counterparty || (income ? "Tulo" : "Meno")}
      subtitle={row ? [formatDate(row.date), row.accountName].filter(Boolean).join(" · ") : undefined}
      labelledBy="bank-row-sheet-title"
      heightClass="max-h-[85dvh]"
      dirty={false}
    >
      {row && state ? (
        <div className="space-y-4 px-4 py-2 sheet-safe-bottom">
          <p className={`px-1 text-[2rem] font-bold tabular-nums leading-tight ${income ? "text-success-dark" : "text-ink"}`}>
            {formatEurSigned(row.amount)}
          </p>

          {state === "sale" && row.suggestedReceipt && (
            <>
              <KeyValueList
                rows={[
                  { label: "Tunnistettu", value: "Myynti" },
                  {
                    label: "Summa",
                    value: row.suggestedReceipt.totalAmount == null ? "–" : formatEur(row.suggestedReceipt.totalAmount),
                  },
                ]}
              />
              <p className="px-1 text-caption text-ink-2">
                Hyväksy, jos tämä on myyntiä. Se kirjataan tuloksi ALV mukaan lukien.
              </p>
              <Button
                className="w-full"
                haptic="medium"
                busy={busy === "approve"}
                busyLabel="Hyväksytään…"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "approve",
                    { url: "/api/receipts/batch-approve", body: { receiptIds: [row.suggestedReceiptId!] } },
                    "Myynti hyväksytty."
                  )
                }
              >
                Hyväksy
              </Button>
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() =>
                  void run("reject", {
                    url: "/api/matching/reject",
                    body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                  })
                }
              >
                Ei ole myyntiä
              </button>
            </>
          )}

          {state === "suggested" && row.suggestedReceipt && (
            <>
              <KeyValueList rows={[{ label: "Ehdotettu kuitti", value: receiptLabel(row.suggestedReceipt) }]} />
              <Button
                className="w-full"
                busy={busy === "confirm"}
                busyLabel="Linkitetään…"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "confirm",
                    {
                      url: "/api/matching/confirm",
                      body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                    },
                    "Kuitti linkitetty."
                  )
                }
              >
                Linkitä kuitti
              </Button>
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() =>
                  void run("reject", {
                    url: "/api/matching/reject",
                    body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                  })
                }
              >
                Väärä kuitti
              </button>
            </>
          )}

          {state === "missing" && (
            <>
              {(row.matchCandidates?.length ?? 0) > 0 && (
                <div>
                  <p className="px-1 pb-1.5 text-caption text-ink-2">Sopiva kuitti?</p>
                  <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
                    {row.matchCandidates!.map((candidate) => (
                      <button
                        key={candidate.receipt.id}
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            `candidate:${candidate.receipt.id}`,
                            {
                              url: "/api/matching/confirm",
                              body: { transactionId: row.id, receiptId: candidate.receipt.id },
                            },
                            "Kuitti linkitetty."
                          )
                        }
                        className="active-press flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left disabled:opacity-50"
                      >
                        <span className="min-w-0 text-body text-ink [overflow-wrap:anywhere]">
                          {receiptLabel(candidate.receipt)}
                        </span>
                        <span className="shrink-0 text-caption font-medium text-accent">Linkitä</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!income && (
                <Button
                  className="w-full"
                  haptic="medium"
                  disabled={busy !== null}
                  onClick={() => {
                    onClose();
                    requestReceiptCapture({ transactionId: row.id, label: row.counterparty ?? undefined });
                  }}
                >
                  Ota kuva kuitista
                </Button>
              )}
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() => void ignoreWithUndo(row)}
              >
                {income ? "Ei vaadi tositetta" : "Kuittia ei tarvita"}
              </button>
            </>
          )}

          {state === "linked" && (
            <>
              <KeyValueList
                rows={[{ label: "Linkitetty", value: row.receipt ? receiptLabel(row.receipt) : "Kunnossa" }]}
              />
              {row.receipt && (
                <Link
                  href={detailHref("receipt", row.receipt.id)}
                  onClick={onClose}
                  className={buttonClass("secondary", "w-full")}
                >
                  Avaa kuitti
                </Link>
              )}
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() => void run("unlink", { url: "/api/matching/unlink", body: { transactionId: row.id } })}
              >
                Poista linkitys
              </button>
            </>
          )}

          {state === "ignored" && (
            <>
              <p className="px-1 text-body text-ink-2">Merkitty: kuittia ei tarvita.</p>
              <Button
                variant="secondary"
                className="w-full"
                busy={busy === "restore"}
                busyLabel="Palautetaan…"
                disabled={busy !== null}
                onClick={() =>
                  void run("restore", { url: "/api/matching/ignore", body: { transactionId: row.id, ignored: false } })
                }
              >
                Palauta
              </Button>
            </>
          )}

          {state === "transfer" && (
            <p className="px-1 text-body text-ink-2">
              {row.type === "palkka" ? "Palkka" : "Oma siirto"}. Tämä ei tarvitse kuittia.
            </p>
          )}

          {error && (
            <p className="rounded-card bg-danger/10 px-4 py-3 text-caption text-danger" role="alert">
              {error}
            </p>
          )}

          <Link
            href={detailHref("statement", row.statementId)}
            onClick={onClose}
            className="active-press mx-auto flex min-h-11 items-center px-3 text-caption text-ink-2"
          >
            Avaa tiliote
          </Link>
        </div>
      ) : null}
    </BottomSheet>
  );
}
