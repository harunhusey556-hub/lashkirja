"use client";

import { useCallback, useState, type ReactNode } from "react";
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
  needsReceipt,
  receiptLabel,
  recomputeTotals,
  type MatchCandidate,
  type StatementData,
  type StatementTransaction,
  type StatementTxFilter,
} from "@/lib/statement-client";
import { parseFinnishNumber } from "@/lib/format";
import StatementSummaryCards from "@/components/StatementSummaryCards";
import ConfirmModal from "@/components/ConfirmModal";

interface Props {
  statement: StatementData;
  onStatementUpdated: (statement: StatementData) => void;
  onDeleted: () => void;
}

function MatchBadge({ t }: { t: StatementTransaction }) {
  if (t.type === "palkka") {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-warm-gray-light/30 text-charcoal">
        Palkka
      </span>
    );
  }
  if (t.type === "oma_siirto") return null;
  const base =
    "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium";
  if (t.matchStatus === "confirmed")
    return (
      <span className={`${base} bg-success/10 text-success`}>
        Linkitetty
      </span>
    );
  if (t.matchStatus === "suggested")
    return (
      <span className={`${base} bg-accent/10 text-accent`}>Ehdotus</span>
    );
  if (t.matchStatus === "ignored")
    return (
      <span className={`${base} bg-warm-gray-light/30 text-warm-gray`}>
        Ei tarvita
      </span>
    );
  return (
    <span className={`${base} bg-warm-gray-light/20 text-warm-gray`}>
      Puuttuu
    </span>
  );
}

function typeLabel(type: string): string {
  if (type === "tulo") return "Tulo";
  if (type === "palkka") return "Palkka";
  if (type === "oma_siirto") return "Siirto";
  return "Meno";
}

function ActionLink({
  children,
  onClick,
  disabled,
  tone = "neutral",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "neutral" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 inline-flex items-center px-2 -mx-2 text-sm font-medium transition-colors disabled:opacity-40 ${
        tone === "danger"
          ? "text-danger hover:text-danger/80"
          : "text-warm-gray hover:text-charcoal"
      }`}
    >
      {children}
    </button>
  );
}

export default function StatementDetailView({
  statement,
  onStatementUpdated,
  onDeleted,
}: Props) {
  const [activeFilter, setActiveFilter] = useState<StatementTxFilter>("all");
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
  const [toolsOpen, setToolsOpen] = useState(false);

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
        setStatusMsg(`${data.confirmed} kuittia linkitetty`);
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
      }>(res, "Kuittien etsintä epäonnistui");
      await reloadStatement();
      const parts: string[] = [];
      if ((data.autoConfirmed ?? 0) > 0) {
        parts.push(`${data.autoConfirmed} linkitetty automaattisesti`);
      }
      if ((data.suggested ?? 0) > 0) {
        parts.push(`${data.suggested} ehdotusta odottaa`);
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
  ) {
    setMatchBusyTxId(txId);
    setActionError("");
    try {
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        await readJson(res, "Kuittilinkityksen päivitys epäonnistui");
      }
      await reloadStatement();
      setCandidatesFor(null);
      setCandidates([]);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(
        errorMessage(error, "Kuittilinkityksen päivitys epäonnistui")
      );
    } finally {
      setMatchBusyTxId(null);
    }
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

  // Only the genuinely actionable bulk step stays on screen.
  
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
      if (!res.ok) await readJson(res, "Myyntien hyväksyntä epäonnistui");
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

  return (
    <div className="space-y-6 pb-4">
      {/* Header */}
      <section className="bg-white rounded-3xl shadow-sm border border-warm-gray-light/20 p-6 space-y-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-charcoal leading-snug break-words">
            {statement.fileName}
          </h2>
          <p className="text-sm text-warm-gray leading-relaxed">
            {formatMonth(periodValue() || statement.periodMonth)}
            {relevantCount > 0 &&
              ` · ${linkedCount}/${relevantCount} kuittia linkitetty`}
            {periodDirty() && " · tallentamaton"}
          </p>
        </div>

        <StatementSummaryCards totals={statement.totals} />

        {statement.totals.transfers !== 0 && (
          <p className="text-sm text-warm-gray">
            Omat siirrot {formatEur(statement.totals.transfers)} — eivät sisälly
            nettoon
          </p>
        )}

        <div className="pt-4 border-t border-warm-gray-light/25 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="flex-1 min-w-0">
              <label
                htmlFor={`statement-${statement.id}-period`}
                className="block text-sm text-charcoal mb-2"
              >
                Kohdekuukausi
              </label>
              <input
                id={`statement-${statement.id}-period`}
                type="month"
                value={periodValue()}
                onChange={(e) => setDraftPeriod(e.target.value)}
                className="w-full sm:max-w-xs min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm"
              />
              <p className="text-xs text-warm-gray mt-2 leading-relaxed">
                Määrittää millä kuukaudella etusivu näyttää tämän tiliotteen.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting}
              className="shrink-0 self-start sm:self-auto px-4 py-2.5 rounded-xl text-sm font-medium text-danger border border-danger/20 hover:bg-danger/5 transition-colors disabled:opacity-50"
            >
              {deleting ? "Poistetaan..." : "Poista tiliote"}
            </button>
          </div>

          {periodDirty() && (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={cancelPeriodMonth}
                className="flex-1 py-2.5 text-sm rounded-xl border border-warm-gray-light text-warm-gray hover:bg-cream transition-colors"
              >
                Peruuta
              </button>
              <button
                type="button"
                onClick={() => void savePeriodMonth()}
                disabled={savingPeriod || !periodValue()}
                className="flex-1 py-2.5 text-sm rounded-xl bg-accent text-white hover:bg-accent-dark disabled:opacity-50"
              >
                {savingPeriod ? "Tallennetaan..." : "Tallenna kuukausi"}
              </button>
            </div>
          )}
        </div>
      </section>

      {actionError && (
        <div
          className="text-sm text-danger bg-danger/10 rounded-2xl px-5 py-4 border border-danger/10"
          role="alert"
        >
          {actionError}
        </div>
      )}

      {statusMsg && (
        <p className="text-sm text-success px-1" role="status" aria-live="polite">
          {statusMsg}
        </p>
      )}

      {/* Filters */}
      <section className="sticky top-12 z-10 -mx-1 px-1">
        <div className="bg-white/95 backdrop-blur-md rounded-2xl border border-warm-gray-light/25 shadow-sm p-2">
          <div
            className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none"
            role="tablist"
            aria-label="Suodata tapahtumia"
          >
            {STATEMENT_TX_FILTERS.map((f) => {
              const active = activeFilter === f.id;
              const count = filterCounts[f.id];
              if (f.id !== "all" && count === 0) return null;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveFilter(f.id)}
                  className={`shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    active
                      ? "bg-charcoal text-white shadow-sm"
                      : "bg-cream/80 text-charcoal hover:bg-cream"
                  }`}
                >
                  <span>{f.shortLabel ?? f.label}</span>
                  <span
                    className={`tabular-nums text-xs px-2 py-0.5 rounded-full ${
                      active
                        ? "bg-white/15 text-white"
                        : "bg-white text-warm-gray"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {incomeDraftCount > 0 && (
        <section className="rounded-3xl p-5 space-y-4 border border-success/30 bg-success/5 shadow-sm">
          <div>
            <div className="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-success">
                <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
              </svg>
              <h3 className="text-base font-medium text-success-dark">Tunnistetut myynnit</h3>
            </div>
            <p className="text-sm text-charcoal/80 mt-2 leading-relaxed">
              Tunnistimme tiliotteelta {incomeDraftCount} myyntitapahtumaa (esim. MobilePay-tilitystä).
              Hyväksymällä lisäät ne automaattisesti kirjanpitoon tuloina, alv mukaan lukien.
            </p>
          </div>
          <button
            type="button"
            onClick={handleApproveAllIncomes}
            disabled={bulkBusy}
            className="w-full py-3 px-4 rounded-2xl bg-success text-white text-sm font-medium hover:bg-success-dark disabled:opacity-50 transition-colors"
          >
            {bulkBusy ? "Hyväksytään..." : `Hyväksy kaikki ${incomeDraftCount} kpl`}
          </button>
        </section>
      )}

      {regularSuggestedCount > 0 && (
        <section className="rounded-3xl p-5 space-y-4 border border-accent/10 bg-white shadow-sm">
          <div>
            <p className="text-base font-medium text-charcoal">Kuittien linkitys</p>
            <p className="text-sm text-warm-gray mt-1 leading-relaxed">
              {regularSuggestedCount} valmista ehdotusta
              {missingCount > 0 && ` · ${missingCount} tapahtumaa odottaa kuittia`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void confirmAllSuggested()}
            disabled={bulkBusy}
            className="w-full py-3 px-4 rounded-2xl bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-50 transition-colors"
          >
            {bulkBusy ? "Linkitetään..." : `Linkitä kaikki (${regularSuggestedCount})`}
          </button>
        </section>
      )}

      <section className="rounded-3xl border border-warm-gray-light/20 bg-white/60">
        <button
          type="button"
          onClick={() => setToolsOpen((prev) => !prev)}
          className="w-full flex items-center justify-between gap-3 p-4 text-left"
          aria-expanded={toolsOpen}
        >
          <span className="text-sm font-medium text-charcoal">Työkalut</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
            className={`w-5 h-5 shrink-0 text-warm-gray transition-transform duration-300 ${
              toolsOpen ? "rotate-180" : ""
            }`}
          >
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {toolsOpen && (
          <div className="px-4 pb-4 space-y-3">
            <div>
              <button
                type="button"
                onClick={() => void rerunMatching()}
                disabled={bulkBusy}
                className="w-full py-2.5 px-4 rounded-2xl border border-warm-gray-light/60 bg-cream/50 text-charcoal text-sm font-medium hover:bg-cream disabled:opacity-50 transition-colors"
              >
                {bulkBusy ? "Haetaan..." : "Etsi kuitteja uudelleen"}
              </button>
              <p className="text-xs text-warm-gray mt-2 leading-relaxed">
                Etsii kuiteille vastaavat tapahtumat uudelleen.
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={() => void reinferTransferTypes()}
                disabled={bulkBusy}
                className="w-full py-2.5 px-4 rounded-2xl border border-warm-gray-light/60 bg-cream/50 text-charcoal text-sm font-medium hover:bg-cream disabled:opacity-50 transition-colors"
              >
                {bulkBusy ? "Päivitetään..." : "Tunnista palkat uudelleen"}
              </button>
              <p className="text-xs text-warm-gray mt-2 leading-relaxed">
                Tunnistaa uudelleen &quot;Palkka&quot;-viestillä maksetut siirrot
                (näytetään Palkka-kategoriana, ei vaadi kuittia).
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Transactions */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between px-1">
          <h3 className="text-sm font-medium text-warm-gray uppercase tracking-wide">
            Tapahtumat
          </h3>
          <span className="text-sm text-warm-gray tabular-nums">
            {filteredTransactions.length} / {statement.transactions.length}
          </span>
        </div>

        {statement.transactions.length === 0 ? (
          <p className="text-center py-12 text-sm text-warm-gray">
            Ei tapahtumia
          </p>
        ) : filteredTransactions.length === 0 ? (
          <p className="text-center py-12 text-sm text-warm-gray leading-relaxed">
            {activeFilter === "missing"
              ? "Kaikilla tapahtumilla on kuitti tai merkintä"
              : "Ei tapahtumia tässä suodattimessa"}
          </p>
        ) : (
          <div className="space-y-3">
            {filteredTransactions.map((t) => (
              <article
                key={t.id}
                className="bg-white rounded-3xl border border-warm-gray-light/25 shadow-sm p-5 space-y-4"
              >
                {editingTx?.id === t.id ? (
                  <div className="space-y-4 bg-cream/40 rounded-2xl p-4">
                    <label
                      htmlFor={`transaction-${t.id}-counterparty`}
                      className="block text-xs font-medium text-warm-gray mb-1.5"
                    >
                      Vastapuoli
                    </label>
                    <input
                      id={`transaction-${t.id}-counterparty`}
                      type="text"
                      value={txForm.counterparty}
                      onChange={(e) =>
                        setTxForm({
                          ...txForm,
                          counterparty: e.target.value,
                        })
                      }
                      className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm"
                    />
                    <div className="field-dates">
                      <div>
                        <label
                          htmlFor={`transaction-${t.id}-date`}
                          className="block text-xs font-medium text-warm-gray mb-1.5"
                        >
                          Päivämäärä
                        </label>
                        <input
                          id={`transaction-${t.id}-date`}
                          type="date"
                          value={txForm.date}
                          onChange={(e) =>
                            setTxForm({
                              ...txForm,
                              date: e.target.value,
                            })
                          }
                          className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`transaction-${t.id}-amount`}
                          className="block text-xs font-medium text-warm-gray mb-1.5"
                        >
                          Summa
                        </label>
                        <input
                          id={`transaction-${t.id}-amount`}
                          type="text"
                          inputMode="decimal"
                          value={txForm.amount}
                          onChange={(e) =>
                            setTxForm({
                              ...txForm,
                              amount: e.target.value,
                            })
                          }
                          className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm tabular-nums"
                        />
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor={`transaction-${t.id}-type`}
                        className="block text-xs font-medium text-warm-gray mb-1.5"
                      >
                        Tyyppi
                      </label>
                      <select
                        id={`transaction-${t.id}-type`}
                        value={txForm.type}
                        onChange={(e) =>
                          setTxForm({
                            ...txForm,
                            type: e.target.value,
                          })
                        }
                        className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm"
                      >
                        <option value="meno">Meno</option>
                        <option value="tulo">Tulo</option>
                        <option value="palkka">Palkka</option>
                        <option value="oma_siirto">Oma siirto</option>
                      </select>
                    </div>
                    <div className="flex gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => setEditingTx(null)}
                        className="flex-1 py-2.5 text-sm rounded-xl border border-warm-gray-light text-warm-gray hover:bg-white transition-colors"
                      >
                        Peruuta
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveTxEdit()}
                        disabled={savingTx}
                        className="flex-1 py-2.5 text-sm rounded-xl bg-accent text-white disabled:opacity-50"
                      >
                        {savingTx ? "Tallennetaan..." : "Tallenna"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-2 flex-1">
                        <p className="text-base font-medium text-charcoal leading-snug break-words">
                          {t.counterparty || t.message || "–"}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-sm text-warm-gray">
                          <span>
                            {t.date
                              ? new Date(t.date).toLocaleDateString("fi-FI")
                              : "–"}
                          </span>
                          <span aria-hidden>·</span>
                          <span>{typeLabel(t.type)}</span>
                          {t.reference && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="truncate">{t.reference}</span>
                            </>
                          )}
                        </div>
                        <MatchBadge t={t} />
                      </div>
                      <p
                        className={`text-lg font-semibold tabular-nums whitespace-nowrap shrink-0 ${
                          t.amount >= 0 ? "text-success" : "text-accent"
                        }`}
                      >
                        {t.amount >= 0 ? "+" : ""}
                        {formatEur(t.amount)}
                      </p>
                    </div>

                    {t.matchStatus === "suggested" && t.suggestedReceipt && (
                      t.suggestedReceipt.source === "auto_income" ? (
                        <div className="bg-success/5 border border-success/20 rounded-2xl p-4 space-y-3">
                          <div>
                            <p className="text-sm font-medium text-success-dark">
                              Tunnistettu myyntitilitys
                            </p>
                            <p className="text-sm text-charcoal/80 mt-1 leading-relaxed">
                              {t.suggestedReceipt.vendor || "Myyjä"} · {t.suggestedReceipt.totalAmount != null ? formatEur(t.suggestedReceipt.totalAmount) : ""}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={matchBusyTxId === t.id}
                              onClick={() =>
                                matchAction(t.id, "/api/matching/reject", {
                                  transactionId: t.id,
                                  receiptId: t.suggestedReceiptId,
                                })
                              }
                              className="flex-1 min-h-11 py-2 px-3 text-xs font-medium text-danger border border-danger/20 rounded-xl hover:bg-danger/5 transition-colors disabled:opacity-50"
                            >
                              Ei myyntiä
                            </button>
                            <button
                              type="button"
                              disabled={matchBusyTxId === t.id}
                              onClick={() =>
                                matchAction(t.id, "/api/receipts/batch-approve", {
                                  receiptIds: [t.suggestedReceiptId],
                                })
                              }
                              className="flex-1 min-h-11 py-2 px-3 text-xs font-medium text-white bg-success hover:bg-success-dark rounded-xl transition-colors disabled:opacity-50"
                            >
                              Hyväksy
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            matchAction(t.id, "/api/matching/confirm", {
                              transactionId: t.id,
                              receiptId: t.suggestedReceiptId,
                            })
                          }
                          disabled={matchBusyTxId === t.id}
                          className="w-full text-left bg-success/8 border border-success/20 rounded-2xl p-4 hover:bg-success/12 transition-colors disabled:opacity-50"
                        >
                          <p className="text-sm font-medium text-success">
                            Linkitä ehdotettu kuitti
                          </p>
                          <p className="text-sm text-charcoal mt-1.5 leading-relaxed">
                            {receiptLabel(t.suggestedReceipt)}
                          </p>
                        </button>
                      )
                    )}

                    {t.matchStatus === "confirmed" && t.receipt && (
                      <div className="bg-success/5 border border-success/15 rounded-2xl p-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-success/80">
                            Linkitetty kuitti
                          </p>
                          <p className="text-sm text-charcoal mt-1 leading-relaxed">
                            {receiptLabel(t.receipt)}
                          </p>
                        </div>
                        <ActionLink
                          tone="danger"
                          disabled={matchBusyTxId === t.id}
                          onClick={() =>
                            matchAction(t.id, "/api/matching/unlink", {
                              transactionId: t.id,
                            })
                          }
                        >
                          Poista
                        </ActionLink>
                      </div>
                    )}

                    {t.matchStatus === "unmatched" &&
                      (t.matchCandidates?.length ?? 0) > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-warm-gray uppercase tracking-wide">
                            Ehdotetut kuitit
                          </p>
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
                              className="w-full text-left text-sm px-4 py-3 rounded-2xl bg-cream/60 border border-warm-gray-light/40 hover:border-accent/40 transition-colors disabled:opacity-50"
                            >
                              {receiptLabel(c.receipt)}
                              <span className="text-warm-gray">
                                {" "}
                                · {Math.round(c.score * 100)} %
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 border-t border-warm-gray-light/20">
                      <ActionLink onClick={() => startEditTx(t)}>
                        Muokkaa
                      </ActionLink>
                      <ActionLink
                        tone="danger"
                        disabled={deletingTxId === t.id}
                        onClick={() => setConfirmingTxDelete(t.id)}
                      >
                        {deletingTxId === t.id ? "Poistetaan..." : "Poista"}
                      </ActionLink>
                      {t.matchStatus === "suggested" && t.suggestedReceiptId && (
                        <ActionLink
                          disabled={matchBusyTxId === t.id}
                          onClick={() =>
                            matchAction(t.id, "/api/matching/reject", {
                              transactionId: t.id,
                              receiptId: t.suggestedReceiptId,
                            })
                          }
                        >
                          Väärä ehdotus
                        </ActionLink>
                      )}
                      {t.type !== "oma_siirto" &&
                        t.type !== "palkka" &&
                        t.matchStatus === "unmatched" &&
                        (t.matchCandidates?.length ?? 0) === 0 && (
                          <ActionLink onClick={() => void openCandidates(t.id)}>
                            {candidatesFor === t.id ? "Sulje haku" : "Etsi lisää"}
                          </ActionLink>
                        )}
                      {t.type !== "oma_siirto" &&
                        t.type !== "palkka" &&
                        t.matchStatus === "unmatched" && (
                          <ActionLink
                            disabled={matchBusyTxId === t.id}
                            onClick={() =>
                              matchAction(t.id, "/api/matching/ignore", {
                                transactionId: t.id,
                                ignored: true,
                              })
                            }
                          >
                            Ei kuittia tarvita
                          </ActionLink>
                        )}
                      {t.matchStatus === "ignored" && (
                        <ActionLink
                          disabled={matchBusyTxId === t.id}
                          onClick={() =>
                            matchAction(t.id, "/api/matching/ignore", {
                              transactionId: t.id,
                              ignored: false,
                            })
                          }
                        >
                          Palauta
                        </ActionLink>
                      )}
                    </div>

                    {candidatesFor === t.id && (
                      <div className="bg-cream/50 border border-warm-gray-light/30 rounded-2xl p-4 space-y-2">
                        {loadingCandidates ? (
                          <p className="text-sm text-warm-gray">
                            Haetaan kuitteja...
                          </p>
                        ) : candidates.length === 0 ? (
                          <p className="text-sm text-warm-gray leading-relaxed">
                            Ei sopivia kuitteja. Lisää kuitti ensin
                            Kuitit-sivulla.
                          </p>
                        ) : (
                          candidates.map((c) => (
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
                              className="w-full text-left text-sm px-4 py-3 rounded-xl bg-white border border-warm-gray-light/40 hover:border-accent/40 transition-colors disabled:opacity-50"
                            >
                              {receiptLabel(c.receipt)}
                              <span className="text-warm-gray">
                                {" "}
                                · {Math.round(c.score * 100)} %
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <ConfirmModal
        isOpen={confirmingDelete}
        title="Poistetaanko tiliote?"
        description={`"${statement.fileName}" ja kaikki sen tapahtumat poistetaan pysyvästi. Tätä ei voi perua.`}
        confirmLabel="Poista tiliote"
        onConfirm={() => handleDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmingTxDelete !== null}
        title="Poistetaanko tapahtuma?"
        description="Tapahtuma poistetaan tästä tiliotteesta pysyvästi."
        confirmLabel="Poista"
        onConfirm={() =>
          confirmingTxDelete ? deleteTransaction(confirmingTxDelete) : Promise.resolve()
        }
        onCancel={() => setConfirmingTxDelete(null)}
      />
    </div>
  );
}
