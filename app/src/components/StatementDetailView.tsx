"use client";

import { CustomSelect } from "@/components/CustomSelect";

import { useCallback, useState } from "react";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import {
  STATEMENT_TX_FILTERS,
  countStatementFilters,
  filterStatementTransactions,
  formatEur,
  formatMonth,
  receiptLabel,
  recomputeTotals,
  type MatchCandidate,
  type StatementData,
  type StatementTransaction,
  type StatementTxFilter,
} from "@/lib/statement-client";
import { formatDate, formatEurSigned, parseFinnishNumber } from "@/lib/format";
import { statementTitle } from "@/lib/display-titles";
import { STATEMENT_TX_STATUS, statementTxStatusKey } from "@/lib/status-labels";
import StatementSummaryCards from "@/components/StatementSummaryCards";
import ConfirmModal from "@/components/ConfirmModal";
import { Skeleton, SkeletonGroup } from "@/components/ds/Skeleton";
import { Button, controlClass } from "@/components/ui";
import { showToast } from "@/lib/toast";
import { hapticImpact } from "@/lib/haptics";
import { deleteRowDescription, deleteStatementDescription, type DeleteFacts } from "@/lib/statement-delete-copy";
import { ActionList, ActionPill, DetailHero, FilterChips, ListRow, MoreMenu, Section, StatusTag, type ActionItem } from "@/components/ds";
import { tintedButtonClass } from "@/components/control-styles";

const LABEL_CLASS = "mb-1.5 block text-caption font-normal text-ink-2";

interface Props {
  statement: StatementData;
  onStatementUpdated: (statement: StatementData) => void;
  onDeleted: () => void;
}

function typeLabel(type: string): string {
  if (type === "tulo") return "Tulo";
  if (type === "palkka") return "Palkka";
  if (type === "oma_siirto") return "Siirto";
  return "Meno";
}

/** What a delete takes along with the row: a waiting sale proposal, an invoice it paid. */
function deleteFacts(t: StatementTransaction | null): DeleteFacts {
  return {
    settlesInvoice: t?.settlesInvoice === true,
    pendingSale: t?.matchStatus === "suggested" && t.suggestedReceipt?.source === "auto_income",
  };
}

function txSecondary(t: StatementTransaction): string {
  return [formatDate(t.date), typeLabel(t.type), t.reference || null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** The actions of one bank line, listed in its own panel (VS-23): never a per-row "···". */
function RowActionList({ items }: { items: ActionItem[] }) {
  return <ActionList items={items} />;
}

export default function StatementDetailView({
  statement,
  onStatementUpdated,
  onDeleted,
}: Props) {
  const [activeFilter, setActiveFilter] = useState<StatementTxFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTx, setEditingTx] = useState<StatementTransaction | null>(
    null
  );
  const [txForm, setTxForm] = useState({
    counterparty: "",
    date: "",
    amount: "",
    type: "meno",
    message: "",
  });
  const [savingTx, setSavingTx] = useState(false);
  const [deletingTxId, setDeletingTxId] = useState<string | null>(null);
  const [draftPeriod, setDraftPeriod] = useState<string | null>(null);
  const [savingPeriod, setSavingPeriod] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [matchBusyTxId, setMatchBusyTxId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [candidatesFor, setCandidatesFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [actionError, setActionError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  // Native window.confirm() is suppressed in Capacitor's WKWebView and in many
  // in-app browsers, where it returns false immediately — which silently killed
  // both delete actions. Everything else in the app already uses ConfirmModal.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingTxDelete, setConfirmingTxDelete] = useState<string | null>(null);

  const reloadStatement = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/statements/${statement.id}`);
      const data = await readJson<{ statement?: StatementData }>(
        res,
        "Tiliotteen lataus epäonnistui"
      );
      if (data.statement) {
        onStatementUpdated(data.statement);
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(error, "Tietojen päivitys epäonnistui")
      );
    }
  }, [statement.id, onStatementUpdated]);

  function periodValue(): string {
    return draftPeriod ?? statement.periodMonth ?? "";
  }

  function periodDirty(): boolean {
    return (
      draftPeriod !== null && draftPeriod !== (statement.periodMonth || "")
    );
  }

  function applyTxUpdate(
    transactionId: string,
    next: StatementTransaction | null
  ) {
    const transactions = next
      ? statement.transactions.map((t) =>
          t.id === transactionId ? next : t
        )
      : statement.transactions.filter((t) => t.id !== transactionId);
    onStatementUpdated({
      ...statement,
      transactions,
      totals: recomputeTotals(transactions),
    });
  }

  function startEditTx(t: StatementTransaction) {
    setEditingTx(t);
    setExpandedId(t.id);
    setTxForm({
      counterparty: t.counterparty || "",
      date: t.date ? t.date.slice(0, 10) : "",
      amount: String(t.amount).replace(".", ","),
      type: t.type,
      message: t.message || "",
    });
  }

  async function saveTxEdit() {
    if (!editingTx) return;
    setSavingTx(true);
    setActionError("");
    try {
      const amount = parseFinnishNumber(txForm.amount);
      if (amount === null || !Number.isFinite(amount)) {
        throw new Error("Anna tapahtumalle kelvollinen summa");
      }
      const normalizedAmount =
        txForm.type === "tulo"
          ? Math.abs(amount)
          : txForm.type === "meno" || txForm.type === "palkka"
            ? -Math.abs(amount)
            : amount;
      const res = await apiFetch(
        `/api/statements/${statement.id}/transactions`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId: editingTx.id,
            counterparty: txForm.counterparty || null,
            date: txForm.date || null,
            amount: normalizedAmount,
            type: txForm.type,
            message: txForm.message || null,
          }),
        }
      );
      const data = await readJson<{ transaction: StatementTransaction }>(
        res,
        "Tapahtuman tallennus epäonnistui"
      );
      if (!data.transaction) {
        throw new Error("Palvelin palautti virheellisen tapahtuman");
      }
      applyTxUpdate(editingTx.id, data.transaction);
      setEditingTx(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(error, "Tapahtuman tallennus epäonnistui")
      );
    } finally {
      setSavingTx(false);
    }
  }

  async function savePeriodMonth() {
    const periodMonth = periodValue();
    if (!periodMonth) return;
    setSavingPeriod(true);
    setActionError("");
    try {
      const res = await apiFetch(`/api/statements/${statement.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodMonth }),
      });
      if (!res.ok) {
        await readJson(res, "Kohdekuukauden tallennus epäonnistui");
      }
      onStatementUpdated({ ...statement, periodMonth });
      setDraftPeriod(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(error, "Kohdekuukauden tallennus epäonnistui")
      );
    } finally {
      setSavingPeriod(false);
    }
  }

  function cancelPeriodMonth() {
    setDraftPeriod(null);
  }

  async function handleDelete() {
    setDeleting(true);
    setActionError("");
    try {
      const res = await apiFetch(`/api/statements/${statement.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        await readJson(res, "Tiliotteen poistaminen epäonnistui");
      }
      setConfirmingDelete(false);
      onDeleted();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(error, "Tiliotteen poistaminen epäonnistui");
      setActionError(message);
      throw new Error(message);
    } finally {
      setDeleting(false);
    }
  }

  async function confirmAllSuggested() {
    setBulkBusy(true);
    setActionError("");
    try {
      const res = await apiFetch("/api/matching/confirm-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementId: statement.id }),
      });
      const data = await readJson<{ confirmed?: number }>(
        res,
        "Ehdotusten hyväksyntä epäonnistui"
      );
      await reloadStatement();
      if ((data.confirmed ?? 0) > 0) {
        setStatusMsg(`${data.confirmed} kuittia kohdistettu`);
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(error, "Ehdotusten hyväksyntä epäonnistui")
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function rerunMatching() {
    setBulkBusy(true);
    setActionError("");
    try {
      const res = await apiFetch("/api/matching/run", { method: "POST" });
      const data = await readJson<{
        autoConfirmed?: number;
        suggested?: number;
        draftsCreated?: number;
      }>(res, "Kuittien etsintä epäonnistui");
      await reloadStatement();
      const parts: string[] = [];
      if ((data.autoConfirmed ?? 0) > 0) {
        parts.push(`${data.autoConfirmed} kohdistettu automaattisesti`);
      }
      if ((data.suggested ?? 0) > 0) {
        parts.push(`${data.suggested} ehdotusta odottaa`);
      }
      if ((data.draftsCreated ?? 0) > 0) {
        parts.push(data.draftsCreated === 1 ? "1 uusi myyntiehdotus odottaa" : `${data.draftsCreated} uutta myyntiehdotusta odottaa`);
      }
      if (parts.length > 0) setStatusMsg(parts.join(" · "));
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kuittien etsintä epäonnistui"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function matchAction(
    txId: string,
    url: string,
    body: Record<string, unknown>
  ): Promise<boolean> {
    setMatchBusyTxId(txId);
    setActionError("");
    try {
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<{
        failedCount?: number;
        updatedCount?: number;
        failed?: { error?: string }[];
      }>(res, "Kuittien kohdistuksen päivitys epäonnistui");
      if (url.includes("batch-approve") && (data.failedCount ?? 0) > 0) {
        setActionError(
          data.failed?.[0]?.error ||
            `Hyväksyttiin ${data.updatedCount ?? 0}, epäonnistui ${data.failedCount}.`
        );
      }
      await reloadStatement();
      setCandidatesFor(null);
      setCandidates([]);
      return true;
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return false;
      }
      setActionError(
        errorMessage(error, "Kuittien kohdistuksen päivitys epäonnistui")
      );
      return false;
    } finally {
      setMatchBusyTxId(null);
    }
  }

  /** One tap marks "no receipt needed"; the toast offers "Kumoa" (BOOKS-23, T4). */
  async function ignoreWithUndo(txId: string) {
    void hapticImpact("light");
    const done = await matchAction(txId, "/api/matching/ignore", { transactionId: txId, ignored: true });
    if (!done) return;
    showToast({
      tone: "success",
      text: "Merkitty: kuittia ei tarvita.",
      action: {
        label: "Kumoa",
        onAction: () => void matchAction(txId, "/api/matching/ignore", { transactionId: txId, ignored: false }),
      },
    });
  }

  async function openCandidates(txId: string) {
    if (candidatesFor === txId) {
      setCandidatesFor(null);
      setCandidates([]);
      return;
    }
    setCandidatesFor(txId);
    setCandidates([]);
    setLoadingCandidates(true);
    setActionError("");
    try {
      const res = await apiFetch(
        `/api/matching/candidates?transactionId=${txId}`
      );
      const data = await readJson<{ candidates?: MatchCandidate[] }>(
        res,
        "Kuittien haku epäonnistui"
      );
      setCandidates(data.candidates || []);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Kuittien haku epäonnistui"));
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function reinferTransferTypes() {
    setBulkBusy(true);
    setActionError("");
    setStatusMsg("");
    try {
      const res = await apiFetch(
        `/api/statements/${statement.id}/reinfer-types`,
        { method: "POST" }
      );
      const data = await readJson<{ updated?: number; statement?: StatementData }>(
        res,
        "Tyyppien päivitys epäonnistui"
      );
      if (data.statement) onStatementUpdated(data.statement);
      if ((data.updated ?? 0) > 0) {
        setStatusMsg(`${data.updated} tapahtuman tyyppi päivitetty`);
      } else {
        setStatusMsg("Tyypit olivat jo ajan tasalla");
      }
    } catch (reinferError: unknown) {
      if (isUnauthorized(reinferError)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(reinferError, "Tyyppien päivitys epäonnistui")
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteTransaction(transactionId: string) {
    setDeletingTxId(transactionId);
    setActionError("");
    try {
      const res = await apiFetch(
        `/api/statements/${statement.id}/transactions`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId }),
        }
      );
      if (!res.ok) {
        await readJson(res, "Tapahtuman poistaminen epäonnistui");
      }
      applyTxUpdate(transactionId, null);
      if (editingTx?.id === transactionId) setEditingTx(null);
      setConfirmingTxDelete(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(error, "Tapahtuman poistaminen epäonnistui");
      setActionError(message);
      throw new Error(message);
    } finally {
      setDeletingTxId(null);
    }
  }

  const filterCounts = countStatementFilters(statement.transactions);
  const filteredTransactions = filterStatementTransactions(
    statement.transactions,
    activeFilter
  );
  const suggestedCount = filterCounts.suggested;
  const missingCount = filterCounts.missing;

  const relevantCount = statement.transactions.filter(
    (t) => t.type !== "oma_siirto" && t.type !== "palkka"
  ).length;
  const linkedCount = statement.transactions.filter(
    (t) => t.matchStatus === "confirmed"
  ).length;

  const incomeDrafts = statement.transactions.filter(
    (t) => t.matchStatus === "suggested" && t.suggestedReceipt?.source === "auto_income"
  );
  const incomeDraftCount = incomeDrafts.length;
  const regularSuggestedCount = suggestedCount - incomeDraftCount;

  const handleApproveAllIncomes = async () => {
    setBulkBusy(true);
    setActionError("");
    try {
      const receiptIds = incomeDrafts.map((t) => t.suggestedReceiptId!);
      const res = await apiFetch("/api/receipts/batch-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptIds }),
      });
      const data = await readJson<{
        updatedCount?: number;
        failedCount?: number;
        failed?: { id: string; error?: string }[];
      }>(res, "Myyntien hyväksyntä epäonnistui");
      const failedCount = data.failedCount ?? data.failed?.length ?? 0;
      const updatedCount = data.updatedCount ?? Math.max(0, receiptIds.length - failedCount);
      if (failedCount > 0) {
        setActionError(`Hyväksyttiin ${updatedCount}, epäonnistui ${failedCount}.`);
      }
      await reloadStatement();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Myyntien hyväksyntä epäonnistui"));
    } finally {
      setBulkBusy(false);
    }
  };

  const filterChipItems = STATEMENT_TX_FILTERS.filter(
    (f) => f.id === "all" || filterCounts[f.id] > 0
  ).map((f) => ({ id: f.id, label: f.shortLabel ?? f.label, count: filterCounts[f.id] }));

  return (
    <div className="space-y-6 pb-4">
      <DetailHero
        amount={formatEurSigned(statement.totals.net)}
        amountTone={statement.totals.net >= 0 ? "positive" : "default"}
        title={statementTitle(statement)}
        meta={
          <>
            <span className="block">{formatMonth(periodValue() || statement.periodMonth)}</span>
            <span className="block">{statement.bankAccount ? statement.bankAccount.name : "Ei pankkitiliä"}</span>
            {relevantCount > 0 && (
              <span className="block">
                {linkedCount}/{relevantCount} kuittia kohdistettu
                {periodDirty() && " · tallentamaton"}
              </span>
            )}
          </>
        }
        menu={
          <MoreMenu
            items={[
              {
                label: "Etsi kuitteja uudelleen",
                onSelect: () => void rerunMatching(),
                disabled: bulkBusy,
              },
              {
                label: "Tunnista palkat uudelleen",
                onSelect: () => void reinferTransferTypes(),
                disabled: bulkBusy,
              },
              {
                label: "Poista tiliote",
                onSelect: () => setConfirmingDelete(true),
                tone: "danger",
                disabled: deleting,
              },
            ]}
          />
        }
      />

      <StatementSummaryCards totals={statement.totals} />

      {statement.totals.transfers !== 0 && (
        <p className="px-1 text-caption text-ink-2">
          Omat siirrot {formatEur(statement.totals.transfers)}, eivät sisälly
          nettoon
        </p>
      )}

      <Section title="Kuukausi Kotona">
        <div className="space-y-3 px-4 py-4">
          <div>
            <label htmlFor={`statement-${statement.id}-period`} className={LABEL_CLASS}>
              Kohdekuukausi
            </label>
            <input
              id={`statement-${statement.id}-period`}
              type="month"
              lang="fi"
              value={periodValue()}
              onChange={(e) => setDraftPeriod(e.target.value)}
              className={controlClass}
            />
            <p className="mt-1.5 text-caption text-ink-2">
              Valitse, minkä kuukauden luvuissa tämä tiliote näkyy Kodissa.
            </p>
          </div>

          {periodDirty() && (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={cancelPeriodMonth}>
                Peruuta
              </Button>
              <Button
                type="button"
                className="flex-1"
                busy={savingPeriod}
                busyLabel="Tallennetaan…"
                disabled={!periodValue()}
                onClick={() => void savePeriodMonth()}
              >
                Tallenna kuukausi
              </Button>
            </div>
          )}
        </div>
      </Section>

      {actionError && (
        <p className="rounded-card bg-danger/10 px-4 py-3 text-caption text-danger" role="alert">
          {actionError}
        </p>
      )}

      {statusMsg && (
        <p className="px-1 text-caption text-success" role="status" aria-live="polite">
          {statusMsg}
        </p>
      )}

      {filterChipItems.length > 1 && (
        <FilterChips label="Suodata tapahtumia" items={filterChipItems} value={activeFilter} onChange={setActiveFilter} />
      )}

      {incomeDraftCount > 0 && (
        <div className="space-y-3 rounded-card border border-success/20 bg-success/10 p-4">
          <div>
            <h3 className="text-body font-semibold text-success">Tunnistetut myynnit</h3>
            <p className="mt-1 text-caption text-ink">
              Tunnistimme tiliotteelta {incomeDraftCount} myyntitapahtumaa (esim. MobilePay-tilitystä).
              Hyväksymällä lisäät ne automaattisesti kirjanpitoon tuloina, alv mukaan lukien.
            </p>
          </div>
          <Button
            type="button"
            className="w-full"
            busy={bulkBusy}
            busyLabel="Hyväksytään…"
            onClick={() => void handleApproveAllIncomes()}
          >
            Hyväksy kaikki {incomeDraftCount} kpl
          </Button>
        </div>
      )}

      {regularSuggestedCount > 0 && (
        <div className="space-y-3 rounded-card border border-line bg-surface p-4">
          <div>
            <p className="text-body font-medium text-ink">Kuittien kohdistus</p>
            <p className="mt-1 text-caption text-ink-2">
              {regularSuggestedCount} valmista ehdotusta
              {missingCount > 0 && ` · ${missingCount} tapahtumaa odottaa kuittia`}
            </p>
          </div>
          <Button
            type="button"
            className="w-full"
            busy={bulkBusy}
            busyLabel="Kohdistetaan…"
            onClick={() => void confirmAllSuggested()}
          >
            Kohdista kaikki ({regularSuggestedCount})
          </Button>
        </div>
      )}

      <Section
        title="Tapahtumat"
        action={
          <span className="tabular-nums">
            {filteredTransactions.length} / {statement.transactions.length}
          </span>
        }
      >
        {statement.transactions.length === 0 ? (
          <p className="px-4 py-8 text-center text-body text-ink-2">Ei tapahtumia</p>
        ) : filteredTransactions.length === 0 ? (
          <p className="px-4 py-8 text-center text-body text-ink-2">
            {activeFilter === "missing"
              ? "Kaikilla tapahtumilla on kuitti tai merkintä"
              : "Ei tapahtumia tässä suodattimessa"}
          </p>
        ) : (
          filteredTransactions.map((t) => {
            const statusKey = statementTxStatusKey(t);
            const status = statusKey ? STATEMENT_TX_STATUS[statusKey] : null;
            const canQuickLink = t.matchStatus === "suggested" && t.suggestedReceipt?.source !== "auto_income";
            const canQuickIgnore = t.type !== "oma_siirto" && t.type !== "palkka" && t.matchStatus === "unmatched";
            const canSearchMore =
              t.type !== "oma_siirto" &&
              t.type !== "palkka" &&
              t.matchStatus === "unmatched" &&
              (t.matchCandidates?.length ?? 0) === 0;
            const rowLabel = `${t.counterparty || t.message || "Tapahtuma"}, ${txSecondary(t)}, ${formatEurSigned(t.amount)}`;

            return (
              <div key={t.id}>
                <ListRow
                  onClick={() => setExpandedId((id) => (id === t.id ? null : t.id))}
                  title={t.counterparty || t.message || "–"}
                  secondary={txSecondary(t)}
                  amount={formatEurSigned(t.amount)}
                  amountTone={t.amount >= 0 ? "positive" : "default"}
                  ariaLabel={rowLabel}
                  // Record row (type B, VS-22/23): the trailing affordance is exactly one of an action pill or
                  // a status tag. Every other action lives in the row's own panel below.
                  trailing={
                    canQuickLink ? (
                      <ActionPill
                        ariaLabel={`Kohdista: ${rowLabel}`}
                        disabled={matchBusyTxId === t.id}
                        onClick={() =>
                          matchAction(t.id, "/api/matching/confirm", {
                            transactionId: t.id,
                            receiptId: t.suggestedReceiptId,
                          })
                        }
                      >
                        Kohdista
                      </ActionPill>
                    ) : status ? (
                      <StatusTag tone={status.tone}>{status.label}</StatusTag>
                    ) : undefined
                  }
                />

                {expandedId === t.id && (
                  <div className="space-y-3 border-t border-line px-4 pb-4 pt-3">
                    {editingTx?.id === t.id ? (
                      <div className="space-y-3">
                        <div>
                          <label htmlFor={`transaction-${t.id}-counterparty`} className={LABEL_CLASS}>
                            Vastapuoli
                          </label>
                          <input
                            id={`transaction-${t.id}-counterparty`}
                            type="text"
                            autoCapitalize="words"
                            autoComplete="off"
                            enterKeyHint="next"
                            value={txForm.counterparty}
                            onChange={(e) =>
                              setTxForm({ ...txForm, counterparty: e.target.value })
                            }
                            className={controlClass}
                          />
                        </div>
                        <div className="field-dates">
                          <div>
                            <label htmlFor={`transaction-${t.id}-date`} className={LABEL_CLASS}>
                              Päivämäärä
                            </label>
                            <input
                              id={`transaction-${t.id}-date`}
                              type="date"
                              lang="fi"
                              value={txForm.date}
                              onChange={(e) => setTxForm({ ...txForm, date: e.target.value })}
                              className={controlClass}
                            />
                          </div>
                          <div>
                            <label htmlFor={`transaction-${t.id}-amount`} className={LABEL_CLASS}>
                              Summa
                            </label>
                            <input
                              id={`transaction-${t.id}-amount`}
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              enterKeyHint="done"
                              value={txForm.amount}
                              onChange={(e) => setTxForm({ ...txForm, amount: e.target.value })}
                              className={`${controlClass} tabular-nums`}
                            />
                          </div>
                        </div>
                        <div>
                          <label htmlFor={`transaction-${t.id}-type`} className={LABEL_CLASS}>
                            Tyyppi
                          </label>
                          <CustomSelect
                            id={`transaction-${t.id}-type`}
                            value={txForm.type}
                            onChange={(e) => setTxForm({ ...txForm, type: e.target.value })}
                            className={controlClass}
                          >
                            <option value="meno">Meno</option>
                            <option value="tulo">Tulo</option>
                            <option value="palkka">Palkka</option>
                            <option value="oma_siirto">Oma siirto</option>
                          </CustomSelect>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            className="flex-1"
                            onClick={() => setEditingTx(null)}
                          >
                            Peruuta
                          </Button>
                          <Button
                            type="button"
                            className="flex-1"
                            busy={savingTx}
                            busyLabel="Tallennetaan…"
                            onClick={() => void saveTxEdit()}
                          >
                            Tallenna
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {t.matchStatus === "suggested" &&
                          t.suggestedReceipt &&
                          (t.suggestedReceipt.source === "auto_income" ? (
                            <div className="space-y-3">
                              <div>
                                <p className="text-caption font-semibold text-success">
                                  Tunnistettu myyntitilitys
                                </p>
                                <p className="mt-1 text-caption text-ink">
                                  {t.suggestedReceipt.vendor || "Myyjä"}
                                  {t.suggestedReceipt.totalAmount != null
                                    ? ` · ${formatEur(t.suggestedReceipt.totalAmount)}`
                                    : ""}
                                </p>
                              </div>
                              <Button
                                type="button"
                                className="w-full"
                                disabled={matchBusyTxId === t.id}
                                onClick={() =>
                                  matchAction(t.id, "/api/receipts/batch-approve", {
                                    receiptIds: [t.suggestedReceiptId],
                                  })
                                }
                              >
                                Hyväksy
                              </Button>
                              <button
                                type="button"
                                className={tintedButtonClass("neutral", "mx-auto")}
                                disabled={matchBusyTxId === t.id}
                                onClick={() =>
                                  matchAction(t.id, "/api/matching/reject", {
                                    transactionId: t.id,
                                    receiptId: t.suggestedReceiptId,
                                  })
                                }
                              >
                                Ei ole myyntiä
                              </button>
                            </div>
                          ) : (
                            <p className="text-caption text-ink-2">
                              Ehdotettu kuitti: {receiptLabel(t.suggestedReceipt)}
                            </p>
                          ))}

                        {t.matchStatus === "confirmed" && t.receipt && (
                          <p className="text-caption text-ink-2">
                            Kohdistettu kuitti: {receiptLabel(t.receipt)}
                          </p>
                        )}

                        {t.matchStatus === "unmatched" &&
                          (t.matchCandidates?.length ?? 0) > 0 && (
                            <div>
                              <p className="pb-1.5 text-caption text-ink-2">Ehdotetut kuitit</p>
                              <div className="divide-y divide-line">
                                {t.matchCandidates!.map((c) => (
                                  <button
                                    key={c.receipt.id}
                                    type="button"
                                    onClick={() =>
                                      matchAction(t.id, "/api/matching/confirm", {
                                        transactionId: t.id,
                                        receiptId: c.receipt.id,
                                      })
                                    }
                                    disabled={matchBusyTxId === t.id}
                                    className="active-press flex min-h-11 w-full items-center justify-between gap-3 py-2.5 text-left disabled:opacity-50"
                                  >
                                    <span className="min-w-0 line-clamp-2 text-caption text-ink [overflow-wrap:anywhere]">
                                      {receiptLabel(c.receipt)}
                                    </span>
                                    <span className="shrink-0 text-caption text-ink-2">
                                      {Math.round(c.score * 100)} %
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                        {candidatesFor === t.id && (
                          <div>
                            {loadingCandidates ? (
                              <SkeletonGroup label="Ladataan kuitteja" className="space-y-2">
                                <Skeleton className="h-3.5 w-3/5" />
                                <Skeleton tone="soft" className="h-3 w-2/5" />
                              </SkeletonGroup>
                            ) : candidates.length === 0 ? (
                              <p className="text-caption text-ink-2">
                                Ei sopivia kuitteja. Lisää ensin uusi kuitti Kuitit-näkymässä.
                              </p>
                            ) : (
                              <div className="divide-y divide-line">
                                {candidates.map((c) => (
                                  <button
                                    key={c.receipt.id}
                                    type="button"
                                    onClick={() =>
                                      matchAction(t.id, "/api/matching/confirm", {
                                        transactionId: t.id,
                                        receiptId: c.receipt.id,
                                      })
                                    }
                                    disabled={matchBusyTxId === t.id}
                                    className="active-press flex min-h-11 w-full items-center justify-between gap-3 py-2.5 text-left disabled:opacity-50"
                                  >
                                    <span className="min-w-0 line-clamp-2 text-caption text-ink [overflow-wrap:anywhere]">
                                      {receiptLabel(c.receipt)}
                                    </span>
                                    <span className="shrink-0 text-caption text-ink-2">
                                      {Math.round(c.score * 100)} %
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {/* A recognised sale has one decision (Hyväksy / Ei ole
                            myyntiä); more row actions here read as three
                            competing choices. They return once it is decided. */}
                        {!(
                          t.matchStatus === "suggested" &&
                          t.suggestedReceipt?.source === "auto_income"
                        ) && (
                        <RowActionList
                          items={[
                            { label: "Muokkaa", onSelect: () => startEditTx(t) },
                            ...(canQuickIgnore
                              ? [
                                  {
                                    label: "Ei kuittia tarvita",
                                    onSelect: () => void ignoreWithUndo(t.id),
                                    disabled: matchBusyTxId === t.id,
                                  },
                                ]
                              : []),
                            ...(t.matchStatus === "suggested" && t.suggestedReceiptId
                              ? [
                                  {
                                    label: "Väärä ehdotus",
                                    onSelect: () =>
                                      matchAction(t.id, "/api/matching/reject", {
                                        transactionId: t.id,
                                        receiptId: t.suggestedReceiptId,
                                      }),
                                    disabled: matchBusyTxId === t.id,
                                  },
                                ]
                              : []),
                            ...(canSearchMore
                              ? [
                                  {
                                    label: candidatesFor === t.id ? "Sulje haku" : "Etsi lisää",
                                    onSelect: () => void openCandidates(t.id),
                                  },
                                ]
                              : []),
                            ...(t.matchStatus === "confirmed"
                              ? [
                                  {
                                    label: "Poista kohdistus",
                                    onSelect: () =>
                                      matchAction(t.id, "/api/matching/unlink", {
                                        transactionId: t.id,
                                      }),
                                    tone: "danger" as const,
                                    disabled: matchBusyTxId === t.id,
                                  },
                                ]
                              : []),
                            ...(t.matchStatus === "ignored"
                              ? [
                                  {
                                    label: "Palauta",
                                    onSelect: () =>
                                      matchAction(t.id, "/api/matching/ignore", {
                                        transactionId: t.id,
                                        ignored: false,
                                      }),
                                    disabled: matchBusyTxId === t.id,
                                  },
                                ]
                              : []),
                            {
                              label: deletingTxId === t.id ? "Poistetaan…" : "Poista",
                              onSelect: () => setConfirmingTxDelete(t.id),
                              tone: "danger" as const,
                              disabled: deletingTxId === t.id,
                            },
                          ]}
                        />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>

      <ConfirmModal
        isOpen={confirmingDelete}
        title="Poistetaanko tiliote?"
        description={deleteStatementDescription(statementTitle(statement), statement.transactions.map(deleteFacts))}
        confirmLabel="Poista tiliote"
        onConfirm={() => handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmingTxDelete !== null}
        title="Poistetaanko tapahtuma?"
        description={deleteRowDescription(
          deleteFacts(statement.transactions.find((t) => t.id === confirmingTxDelete) ?? null)
        )}
        confirmLabel="Poista"
        onConfirm={() =>
          confirmingTxDelete ? deleteTransaction(confirmingTxDelete) : Promise.resolve()
        }
        onCancel={() => setConfirmingTxDelete(null)}
      />
    </div>
  );
}
