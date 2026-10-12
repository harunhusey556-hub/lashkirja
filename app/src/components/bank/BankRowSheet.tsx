"use client";

import { useState } from "react";
import Link from "next/link";
import BottomSheet from "@/components/BottomSheet";
import { Button, buttonClass } from "@/components/ui";
import { Icon, KeyValueList } from "@/components/ds";
import { Ban, Camera, Check, FileText, Landmark, Link2, ReceiptText, RotateCcw, Unlink, X } from "lucide-react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatDate, formatEur, formatEurSigned } from "@/lib/format";
import { linkedGapSuffix, receiptLabel, type StatementTransaction } from "@/lib/statement-client";
import { rowState, unlinkMessage, unlinkedRowPatch, type FeedRow } from "@/lib/bank-feed";
import { detailHref } from "@/lib/routes";
import { requestReceiptCapture } from "@/lib/capture-request";
import { hapticImpact, hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";

type Action =
  | { url: "/api/receipts/batch-approve"; body: { receiptIds: string[] } }
  | { url: "/api/matching/confirm" | "/api/matching/reject"; body: { transactionId: string; receiptId: string } }
  | { url: "/api/matching/ignore"; body: { transactionId: string; ignored: boolean } }
  | { url: "/api/matching/unlink"; body: { transactionId: string } };

/** What the unlink route says: the row's approved sale went back to waiting. */
interface UnlinkAnswer {
  restoredSale?: boolean;
}

const UNSUGGESTED: Partial<StatementTransaction> = {
  matchStatus: "unmatched",
  suggestedReceiptId: null,
  suggestedReceipt: null,
};

/** The row once its suggested kuitti (or recognised sale) is linked. */
function linkedPatch(row: FeedRow): Partial<StatementTransaction> {
  return {
    matchStatus: "confirmed",
    receiptId: row.suggestedReceiptId,
    receipt: row.suggestedReceipt,
    suggestedReceiptId: null,
    suggestedReceipt: null,
  };
}

// Secondary decisions: full width like the primary button above them, so a
// sheet's actions read as one stack instead of pills scattered around it.
const QUIET_LINK =
  "active-press flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink/5 px-4 text-body font-medium text-ink disabled:opacity-50";

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
  /**
   * After a change. `patch` is the row's new state, so the list can show it at
   * once (and fold the row out of "Vaatii toimia") before the reload lands.
   */
  onChanged: (rowId: string, patch?: Partial<StatementTransaction>) => void;
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

  async function run(
    key: string,
    action: Action,
    patch: Partial<StatementTransaction> | ((data: UnlinkAnswer) => Partial<StatementTransaction>),
    done?: string | ((data: UnlinkAnswer) => string)
  ): Promise<boolean> {
    if (!row || busy) return false;
    setBusy(key);
    setError("");
    try {
      const res = await apiFetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body),
      });
      const data = await readJson<UnlinkAnswer & { failedCount?: number; failed?: { error?: string }[] }>(
        res,
        "Muutos ei onnistunut"
      );
      if ((data.failedCount ?? 0) > 0) {
        throw new Error(data.failed?.[0]?.error || "Muutos ei onnistunut");
      }
      void hapticNotify("success");
      const text = typeof done === "function" ? done(data) : done;
      if (text) showToast({ tone: "success", text });
      onChanged(row.id, typeof patch === "function" ? patch(data) : patch);
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
    const ok = await run(
      "ignore",
      { url: "/api/matching/ignore", body: { transactionId: target.id, ignored: true } },
      { matchStatus: "ignored" }
    );
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
                    linkedPatch(row),
                    "Myynti hyväksytty."
                  )
                }
              >
                <Icon icon={Check} size="row" />
                Hyväksy
              </Button>
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "reject",
                    {
                      url: "/api/matching/reject",
                      body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                    },
                    UNSUGGESTED
                  )
                }
              >
                <Icon icon={Ban} size="row" />
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
                busyLabel="Kohdistetaan…"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "confirm",
                    {
                      url: "/api/matching/confirm",
                      body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                    },
                    linkedPatch(row),
                    "Kuitti kohdistettu."
                  )
                }
              >
                <Icon icon={Link2} size="row" />
                Kohdista kuitti
              </Button>
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "reject",
                    {
                      url: "/api/matching/reject",
                      body: { transactionId: row.id, receiptId: row.suggestedReceiptId! },
                    },
                    UNSUGGESTED
                  )
                }
              >
                <Icon icon={X} size="row" />
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
                            {
                              matchStatus: "confirmed",
                              receiptId: candidate.receipt.id,
                              receipt: candidate.receipt,
                            },
                            "Kuitti kohdistettu."
                          )
                        }
                        className="active-press flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left disabled:opacity-50"
                      >
                        <span className="min-w-0 text-body text-ink [overflow-wrap:anywhere]">
                          {receiptLabel(candidate.receipt)}
                        </span>
                        <span className="shrink-0 text-caption font-medium text-accent">Kohdista</span>
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
                  <Icon icon={Camera} size="row" />
                  Kuvaa kuitti
                </Button>
              )}
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() => void ignoreWithUndo(row)}
              >
                <Icon icon={Ban} size="row" />
                {income ? "Ei vaadi kuittia" : "Kuittia ei tarvita"}
              </button>
            </>
          )}

          {state === "invoice" && (
            <>
              <KeyValueList
                rows={[
                  {
                    label: "Maksu",
                    value: row.paidInvoice
                      ? `Laskulle ${row.paidInvoice.number}`
                      : row.settlesPurchase
                        ? "Ostolaskulle"
                        : "Laskulle",
                  },
                ]}
              />
              <p className="px-1 text-caption text-ink-2">
                Tapahtuma on jo kirjattu laskun maksuksi. Siitä ei tarvitse hyväksyä myyntiä eikä lisätä kuittia.
              </p>
              {row.paidInvoice ? (
                <Link
                  href={detailHref("invoice", row.paidInvoice.id)}
                  onClick={onClose}
                  className={buttonClass("secondary", "w-full")}
                >
                  <Icon icon={FileText} size="row" />
                  Avaa lasku
                </Link>
              ) : row.settlesPurchase ? (
                <Link href="/kirjanpito/ostolaskut" onClick={onClose} className={buttonClass("secondary", "w-full")}>
                  Avaa ostolaskut
                </Link>
              ) : null}
            </>
          )}

          {state === "linked" && (
            <>
              <KeyValueList
                rows={[{ label: "Kohdistettu", value: row.receipt ? receiptLabel(row.receipt) + linkedGapSuffix(row.amount, row.receipt) : "Kunnossa" }]}
              />
              {row.receipt && (
                <Link
                  href={detailHref("receipt", row.receipt.id)}
                  onClick={onClose}
                  className={buttonClass("secondary", "w-full")}
                >
                  <Icon icon={ReceiptText} size="row" />
                  Avaa kuitti
                </Link>
              )}
              <button
                type="button"
                className={QUIET_LINK}
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "unlink",
                    { url: "/api/matching/unlink", body: { transactionId: row.id } },
                    (answer) => unlinkedRowPatch(row.receipt, answer.restoredSale === true),
                    (answer) => unlinkMessage(answer.restoredSale === true)
                  )
                }
              >
                <Icon icon={Unlink} size="row" />
                Poista kohdistus
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
                  void run(
                    "restore",
                    { url: "/api/matching/ignore", body: { transactionId: row.id, ignored: false } },
                    { matchStatus: "unmatched" }
                  )
                }
              >
                <Icon icon={RotateCcw} size="row" />
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

          {/* Navigation, not a decision: a quiet link centred under the stack. */}
          <Link
            href={detailHref("statement", row.statementId)}
            onClick={onClose}
            className="active-press mx-auto flex min-h-11 w-fit items-center justify-center gap-1.5 px-3 text-caption font-medium text-accent"
          >
            <Icon icon={Landmark} size="row" />
            Avaa tiliote
          </Link>
        </div>
      ) : null}
    </BottomSheet>
  );
}
