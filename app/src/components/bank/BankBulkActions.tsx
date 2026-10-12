"use client";

import { useMemo, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import { Button } from "@/components/ui";
import { BulkBar } from "@/app/kuitit/BulkBar";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { linkedRowPatch, REJECTED_SUGGESTION_PATCH, type FeedRow } from "@/lib/bank-feed";
import { receiptLabel, type StatementTransaction } from "@/lib/statement-client";
import { formatEurSigned } from "@/lib/format";
import {
  approveSuggestionsLabel,
  bulkConfirmBody,
  bulkConfirmLabel,
  bulkConfirmTitle,
  bulkLabels,
  bulkOutcomeText,
  planBulk,
  runLimited,
  type BulkPlan,
} from "@/lib/bank-bulk";

export type BulkKind = "approve" | "reject" | "transfer" | "match";
export type RowPatches = Map<string, Partial<StatementTransaction>>;

/** `/api/receipts/batch-approve` takes at most 200 ids, `confirm-all` at most 500 pairs. */
const APPROVE_CHUNK = 200;
const PAIR_CHUNK = 500;
/** Per-row requests (reject, match, transfer) run a few at a time: quick, and kind to the server. */
const PARALLEL = 4;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function approvableCount(plan: BulkPlan): number {
  return plan.confirmPairs.length + plan.saleApprovals.length;
}

/**
 * The action buttons for the ticked rows. Only the actions that have something
 * to do appear, each with the number of rows it will touch.
 */
export function BankBulkBar({
  visible,
  count,
  plan,
  busy,
  onCancel,
  onRequest,
}: {
  visible: boolean;
  count: number;
  plan: BulkPlan;
  busy: BulkKind | null;
  onCancel: () => void;
  onRequest: (kind: BulkKind) => void;
}) {
  const approve = approvableCount(plan);
  const nothingToDo =
    approve === 0 && plan.proposals.length === 0 && plan.rejectable.length === 0 && plan.transferable.length === 0;
  return (
    <BulkBar
      visible={visible}
      count={count}
      busy={false}
      approveBusy={false}
      approvableCount={0}
      onCancel={onCancel}
      onApproveRequest={() => {}}
      onDeleteRequest={() => {}}
      label="Valitut pankkitapahtumat"
      actions={
        <>
          {approve > 0 && (
            <Button
              type="button"
              variant="secondary"
              busy={busy === "approve"}
              busyLabel="Hyväksytään…"
              disabled={busy !== null}
              onClick={() => onRequest("approve")}
            >
              {approveSuggestionsLabel(approve)}
            </Button>
          )}
          {plan.proposals.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => onRequest("match")}
            >
              {bulkLabels.match(plan.proposals.length)}
            </Button>
          )}
          {plan.rejectable.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              busy={busy === "reject"}
              busyLabel="Hylätään…"
              disabled={busy !== null}
              onClick={() => onRequest("reject")}
            >
              {bulkLabels.reject(plan.rejectable.length)}
            </Button>
          )}
          {plan.transferable.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              busy={busy === "transfer"}
              busyLabel="Merkitään…"
              disabled={busy !== null}
              onClick={() => onRequest("transfer")}
            >
              {bulkLabels.transfer(plan.transferable.length)}
            </Button>
          )}
          {nothingToDo && <span className="text-caption text-canvas/70">Valituille ei ole toimintoa.</span>}
        </>
      }
    />
  );
}

/** What the confirmation sheet counts, per action. */
export function confirmCount(kind: BulkKind, plan: BulkPlan): number {
  switch (kind) {
    case "approve":
      return approvableCount(plan);
    case "reject":
      return plan.rejectable.length;
    case "transfer":
      return plan.transferable.length;
    case "match":
      return plan.proposals.length;
  }
}

/**
 * Select mode of Pankki: the bar, the confirmations (each names its count) and
 * the "Kohdista valitut" sheet. It sends the requests and reports back which
 * rows changed, so the list can show the result at once; the rows that failed
 * stay selected.
 */
export function BankBulkActions({
  rows,
  onCancel,
  onApplied,
}: {
  rows: FeedRow[];
  onCancel: () => void;
  /** The rows that changed. Rows not in `patches` (the failures) stay selected. */
  onApplied: (patches: RowPatches) => void;
}) {
  const plan = useMemo(() => planBulk(rows), [rows]);
  const [confirm, setConfirm] = useState<BulkKind | null>(null);
  const [busy, setBusy] = useState<BulkKind | null>(null);

  function fail(error: unknown, fallback: string) {
    if (isUnauthorized(error)) {
      redirectToLogin();
      return;
    }
    void hapticNotify("error");
    showToast({ tone: "error", text: errorMessage(error, fallback) });
  }

  function finish(verb: string, patches: RowPatches, failedIds: string[]) {
    void hapticNotify(failedIds.length === 0 ? "success" : "warning");
    showToast({
      tone: failedIds.length === 0 ? "success" : "info",
      text: bulkOutcomeText(verb, patches.size, failedIds.length),
    });
    onApplied(patches);
  }

  async function approve() {
    const patches: RowPatches = new Map();
    const failedIds: string[] = [];
    setBusy("approve");
    try {
      // Suggested kuitit: exactly the pairs the rows show. The server skips a pair that went stale.
      for (const chunk of chunks(plan.confirmPairs, PAIR_CHUNK)) {
        const data = await readJson<{ skippedPairs?: Array<{ transactionId: string }> }>(
          await apiFetch("/api/matching/confirm-all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pairs: chunk }),
          }),
          "Hyväksyntä epäonnistui"
        );
        const skipped = new Set((data.skippedPairs ?? []).map((pair) => pair.transactionId));
        for (const pair of chunk) {
          const row = rows.find((candidate) => candidate.id === pair.transactionId);
          if (!row) continue;
          if (skipped.has(pair.transactionId)) failedIds.push(row.id);
          else patches.set(row.id, linkedRowPatch(row));
        }
      }
      // Recognised sales are drafts: they are approved as receipts.
      for (const chunk of chunks(plan.saleApprovals, APPROVE_CHUNK)) {
        const data = await readJson<{ failed?: Array<{ id: string }> }>(
          await apiFetch("/api/receipts/batch-approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ receiptIds: chunk.map((item) => item.receiptId) }),
          }),
          "Hyväksyntä epäonnistui"
        );
        const refused = new Set((data.failed ?? []).map((item) => item.id));
        for (const item of chunk) {
          if (refused.has(item.receiptId)) failedIds.push(item.row.id);
          else patches.set(item.row.id, linkedRowPatch(item.row));
        }
      }
      finish("Hyväksyttiin", patches, failedIds);
    } catch (error: unknown) {
      // What was sent before the failure is real: show it, keep the rest selected.
      if (patches.size > 0) {
        const attempted = [...plan.confirmPairs.map((pair) => pair.transactionId), ...plan.saleApprovals.map((item) => item.row.id)];
        finish("Hyväksyttiin", patches, attempted.filter((id) => !patches.has(id)));
      }
      fail(error, "Hyväksyntä epäonnistui. Yritä uudelleen.");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function perRow<T extends { row: FeedRow }>(
    kind: BulkKind,
    items: readonly T[],
    send: (item: T) => Promise<void>,
    patchFor: (item: T) => Partial<StatementTransaction>,
    verb: string,
    fallback: string
  ) {
    setBusy(kind);
    try {
      const result = await runLimited(items, PARALLEL, send);
      const patches: RowPatches = new Map(result.done.map((item) => [item.row.id, patchFor(item)]));
      const firstError = result.failed[0]?.error;
      if (result.failed.length > 0 && result.done.length === 0 && firstError) {
        fail(firstError, fallback);
        return;
      }
      finish(verb, patches, result.failed.map((entry) => entry.item.row.id));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const post = async (url: string, body: unknown, method = "POST") =>
    readJson(
      await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      "Muutos ei onnistunut"
    );

  function reject() {
    return perRow(
      "reject",
      plan.rejectable,
      (item) => post("/api/matching/reject", { transactionId: item.row.id, receiptId: item.receiptId }).then(() => {}),
      () => REJECTED_SUGGESTION_PATCH,
      "Hylättiin",
      "Hylkääminen epäonnistui. Yritä uudelleen."
    );
  }

  function transfer() {
    return perRow(
      "transfer",
      plan.transferable.map((row) => ({ row })),
      (item) =>
        post(`/api/statements/${item.row.statementId}/transactions`, { transactionId: item.row.id, type: "oma_siirto" }, "PATCH").then(
          () => {}
        ),
      () => ({ type: "oma_siirto" }),
      "Merkittiin",
      "Merkitseminen epäonnistui. Yritä uudelleen."
    );
  }

  function match() {
    return perRow(
      "match",
      plan.proposals,
      (item) => post("/api/matching/confirm", { transactionId: item.row.id, receiptId: item.candidate.id }).then(() => {}),
      (item) => ({ matchStatus: "confirmed", receiptId: item.candidate.id, receipt: item.candidate }),
      "Kohdistettiin",
      "Kohdistus epäonnistui. Yritä uudelleen."
    );
  }

  async function runConfirmed() {
    if (confirm === "approve") await approve();
    else if (confirm === "reject") await reject();
    else if (confirm === "transfer") await transfer();
    else if (confirm === "match") await match();
  }

  return (
    <>
      <BankBulkBar
        visible={rows.length > 0}
        count={rows.length}
        plan={plan}
        busy={busy}
        onCancel={onCancel}
        onRequest={setConfirm}
      />

      {/* Match and the rest all name the count. Match shows what it will link first. */}
      <ConfirmModal
        isOpen={confirm !== null && confirm !== "match"}
        title={confirm && confirm !== "match" ? bulkConfirmTitle(confirm, confirmCount(confirm, plan)) : ""}
        description={confirm && confirm !== "match" ? bulkConfirmBody(confirm) : undefined}
        confirmLabel={confirm ? bulkConfirmLabel[confirm] : undefined}
        isDestructive={confirm === "reject"}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />

      <BottomSheet
        isOpen={confirm === "match"}
        onClose={() => (busy ? undefined : setConfirm(null))}
        title={bulkConfirmTitle("match", plan.proposals.length)}
        subtitle={bulkConfirmBody("match")}
        labelledBy="bank-match-sheet-title"
        heightClass="max-h-[85dvh]"
        dirty={false}
      >
        <div className="space-y-4 px-4 py-2 sheet-safe-bottom">
          <ul className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            {plan.proposals.map(({ row, candidate }) => (
              <li key={row.id} className="px-4 py-3">
                <p className="flex justify-between gap-3 text-body font-medium text-ink">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{row.counterparty || (row.amount > 0 ? "Tulo" : "Meno")}</span>
                  <span className="shrink-0 tabular-nums">{formatEurSigned(row.amount)}</span>
                </p>
                <p className="mt-0.5 text-caption text-ink-2 [overflow-wrap:anywhere]">{receiptLabel(candidate)}</p>
              </li>
            ))}
          </ul>
          <Button
            className="w-full"
            busy={busy === "match"}
            busyLabel="Kohdistetaan…"
            disabled={busy !== null || plan.proposals.length === 0}
            onClick={() => void runConfirmed()}
          >
            {bulkConfirmLabel.match} ({plan.proposals.length})
          </Button>
        </div>
      </BottomSheet>
    </>
  );
}
