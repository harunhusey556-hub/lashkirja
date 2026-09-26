"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import ConfirmModal from "@/components/ConfirmModal";
import {
  BankAccountForm,
  type BankAccountFormPayload,
} from "@/components/bank/BankAccountForm";
import { BalanceTable, type MonthRow } from "@/components/bank/BalanceTable";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatEur, formatMonth } from "@/lib/format";
import { BANK_LINKS, WorkspaceLinks, linksWithActive } from "@/components/WorkspaceLinks";
import { maskIban } from "@/lib/iban";

import { readPageCache, writePageCache } from "@/lib/page-cache";
interface AccountSummary {
  id: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currency: string;
  openingBalance: number;
  openingDate: string;
  isDefault: boolean;
  archivedAt: string | null;
  currentBalance: number;
  lastReconciledMonth: string | null;
  mismatchCount: number;
  unreportedCount: number;
  statementCount: number;
  transactionCount: number;
}

interface Overview {
  accounts: AccountSummary[];
  totalBalance: number;
  totalAccounts: number;
  archivedCount?: number;
  excludedCurrencies: string[];
  needsAttention: number;
}

interface Rollforward {
  months: MonthRow[];
  currentBalance: number;
  excluded: {
    undatedTxCount: number;
    preOpeningTxCount: number;
    preOpeningAmount: number;
  };
}

export default function BankAccountsPage() {
  const cached = readPageCache<Overview>("bank-overview");
  const [overview, setOverview] = useState<Overview | null>(cached);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  function showError(text: string) {
    setMessage(text);
    setMessageIsError(true);
  }
  function showSuccess(text: string) {
    setMessage(text);
    setMessageIsError(false);
  }
  const [formMode, setFormMode] = useState<"hidden" | "create" | { edit: AccountSummary }>("hidden");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rollforward, setRollforward] = useState<Rollforward | null>(null);
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/bank-accounts${showArchived ? "?includeArchived=1" : ""}`,
        { credentials: "include" }
      );
      const data = await readJson<Overview>(response, "Pankkitilien haku epäonnistui");
      writePageCache("bank-overview", data);
      setOverview(data);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showError(errorMessage(error, "Pankkitilien haku epäonnistui"));
      setStatus("error");
    }
  }, [showArchived]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  const loadRollforward = useCallback(async (accountId: string) => {
    setRollforward(null);
    try {
      const response = await apiFetch(`/api/bank-accounts/${accountId}`, {
        credentials: "include",
      });
      setRollforward(await readJson<Rollforward>(response, "Saldojen haku epäonnistui"));
    } catch (error) {
      showError(errorMessage(error, "Saldojen haku epäonnistui"));
    }
  }, []);

  function toggleAccount(account: AccountSummary) {
    if (expanded === account.id) {
      setExpanded(null);
      setRollforward(null);
      return;
    }
    setExpanded(account.id);
    void loadRollforward(account.id);
  }

  async function submitAccount(payload: BankAccountFormPayload) {
    setBusy(true);
    setMessage(null);
    try {
      const editing = typeof formMode === "object" ? formMode.edit : null;
      const response = await apiFetch(
        editing ? `/api/bank-accounts/${editing.id}` : "/api/bank-accounts",
        {
          method: editing ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      await readJson(response, "Tallennus epäonnistui");
      setFormMode("hidden");
      await load();
      if (editing && expanded === editing.id) await loadRollforward(editing.id);
    } catch (error) {
      showError(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function saveBalance(accountId: string, month: string, closingBalance: number) {
    setBusyMonth(month);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/bank-accounts/${accountId}/balances`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, closingBalance }),
      });
      await readJson(response, "Saldon tallennus epäonnistui");
      await Promise.all([loadRollforward(accountId), load()]);
    } catch (error) {
      showError(errorMessage(error, "Saldon tallennus epäonnistui"));
    } finally {
      setBusyMonth(null);
    }
  }

  async function clearBalance(accountId: string, month: string) {
    setBusyMonth(month);
    try {
      const response = await apiFetch(
        `/api/bank-accounts/${accountId}/balances?month=${month}`,
        { method: "DELETE", credentials: "include" }
      );
      await readJson(response, "Saldon poisto epäonnistui");
      await Promise.all([loadRollforward(accountId), load()]);
    } catch (error) {
      showError(errorMessage(error, "Saldon poisto epäonnistui"));
    } finally {
      setBusyMonth(null);
    }
  }

  async function removeAccount(account: AccountSummary) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/bank-accounts/${account.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await readJson<{ archived: boolean; statementCount: number }>(
        response,
        "Poisto epäonnistui"
      );
      showSuccess(
        result.archived
          ? `Tilillä on ${result.statementCount} tiliotetta, joten se arkistoitiin poiston sijaan.`
          : "Pankkitili poistettiin."
      );
      setConfirmRemove(null);
      setExpanded(null);
      await load();
    } catch (error) {
      showError(errorMessage(error, "Poisto epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(account: AccountSummary) {
    try {
      const response = await apiFetch(`/api/bank-accounts/${account.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      await readJson(response, "Oletustilin vaihto epäonnistui");
      await load();
    } catch (error) {
      showError(errorMessage(error, "Oletustilin vaihto epäonnistui"));
    }
  }

  return (
    <>
      <div className="space-y-6 pb-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-2 min-w-0">
            <p className="text-sm text-warm-gray leading-relaxed">
              Lisää jokainen pankkitili ja seuraa kuukausien loppusaldoja.
            </p>
            <WorkspaceLinks items={linksWithActive(BANK_LINKS, "/pankkitilit")} />
          </div>
          {formMode === "hidden" && status === "ready" && (overview?.accounts.length ?? 0) > 0 && (
            // Adding an account is a once-a-year action; it does not deserve a
            // full-width button competing with the balances.
            <button
              type="button"
              onClick={() => setFormMode("create")}
              aria-label="Lisää pankkitili"
              className="shrink-0 mt-1 px-3.5 py-2 rounded-xl border border-accent/40 text-accent-dark text-sm font-medium active-press hover:bg-blush/40 transition-colors"
            >
              + Lisää
            </button>
          )}
        </header>

        {status === "loading" && <LoadingState label="Haetaan pankkitilejä…" />}
        {status === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {status === "ready" && overview && (
          <>
            {overview.accounts.length > 0 ? (
              <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
                <p className="text-sm text-warm-gray">Yhteenlaskettu saldo</p>
                <p className="text-3xl font-semibold text-charcoal tracking-tight">
                  {formatEur(overview.totalBalance)}
                </p>
                <p className="text-xs text-warm-gray">
                  {overview.totalAccounts} tiliä
                  {overview.needsAttention > 0 && (
                    <span className="text-danger"> · {overview.needsAttention} vaatii täsmäytystä</span>
                  )}
                </p>
                {overview.excludedCurrencies.length > 0 && (
                  <p className="text-xs text-warning">
                    Summasta puuttuvat muut valuutat: {overview.excludedCurrencies.join(", ")}
                  </p>
                )}
              </section>
            ) : formMode === "hidden" ? (
              <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-8 text-center space-y-3">
                <p className="text-base font-medium text-charcoal">Ei vielä pankkitilejä</p>
                <p className="text-sm text-warm-gray leading-relaxed">
                  Saldo ja täsmäytys näkyvät tässä, kun ensimmäinen tili on lisätty.
                </p>
                <button
                  type="button"
                  onClick={() => setFormMode("create")}
                  className="active-press inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-white"
                >
                  Lisää ensimmäinen pankkitili
                </button>
              </section>
            ) : null}

            {message && (
              <p
                className={
                  messageIsError
                    ? "text-sm text-danger bg-danger/10 rounded-2xl px-4 py-3"
                    : "text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3"
                }
                role={messageIsError ? "alert" : "status"}
              >
                {message}
              </p>
            )}

            {formMode !== "hidden" && (
              <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
                <p className="text-base font-medium text-charcoal">
                  {formMode === "create" ? "Uusi pankkitili" : "Muokkaa tiliä"}
                </p>
                <BankAccountForm
                  submitLabel={formMode === "create" ? "Lisää tili" : "Tallenna"}
                  busy={busy}
                  initial={
                    typeof formMode === "object"
                      ? {
                          name: formMode.edit.name,
                          bankName: formMode.edit.bankName ?? "",
                          iban: formMode.edit.iban ?? "",
                          bic: formMode.edit.bic ?? "",
                          currency: formMode.edit.currency,
                          openingBalance: String(formMode.edit.openingBalance).replace(".", ","),
                          openingDate: formMode.edit.openingDate,
                        }
                      : undefined
                  }
                  onSubmit={submitAccount}
                  onCancel={() => setFormMode("hidden")}
                />
              </section>
            )}

            <ul className="space-y-3">
              {overview.accounts.map((account) => (
                <li
                  key={account.id}
                  className={`bg-white rounded-3xl border shadow-sm overflow-hidden ${
                    account.mismatchCount > 0
                      ? "border-danger/30"
                      : "border-warm-gray-light/20"
                  } ${account.archivedAt ? "opacity-60" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleAccount(account)}
                    className="w-full text-left p-5 space-y-2"
                    aria-expanded={expanded === account.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-medium text-charcoal truncate">
                          {account.name}
                        </p>
                        <p className="text-xs text-warm-gray truncate">
                          {[account.bankName, account.iban ? maskIban(account.iban) : null]
                            .filter(Boolean)
                            .join(" · ") || "Ei IBANia"}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-semibold text-charcoal">
                          {formatEur(account.currentBalance)}
                        </p>
                        <p className="text-[11px] text-warm-gray">{account.currency}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {account.isDefault && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-blush text-accent-dark">
                          Oletustili
                        </span>
                      )}
                      {account.archivedAt && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-warm-gray-light/40 text-warm-gray">
                          Arkistoitu
                        </span>
                      )}
                      {account.mismatchCount > 0 && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-danger/10 text-danger">
                          {account.mismatchCount} kk ei täsmää
                        </span>
                      )}
                      {account.lastReconciledMonth && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-success/10 text-success">
                          Täsmätty {formatMonth(account.lastReconciledMonth)}
                        </span>
                      )}
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-warm-gray-light/25 text-warm-gray">
                        {account.statementCount} tiliotetta
                      </span>
                    </div>
                  </button>

                  {expanded === account.id && (
                    <div className="border-t border-warm-gray-light/25 p-5 space-y-4 bg-cream/40">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setFormMode({ edit: account })}
                          className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                        >
                          Muokkaa
                        </button>
                        {!account.isDefault && !account.archivedAt && (
                          <button
                            type="button"
                            onClick={() => void setDefault(account)}
                            className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                          >
                            Aseta oletukseksi
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(account)}
                          className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-danger/40 text-danger"
                        >
                          Poista
                        </button>
                      </div>

                      {rollforward === null ? (
                        <LoadingState label="Haetaan saldoja…" />
                      ) : (
                        <>
                          {(rollforward.excluded.undatedTxCount > 0 ||
                            rollforward.excluded.preOpeningTxCount > 0) && (
                            <p className="text-xs text-warning leading-relaxed">
                              {rollforward.excluded.preOpeningTxCount > 0 && (
                                <>
                                  {rollforward.excluded.preOpeningTxCount} tapahtumaa on ennen
                                  avauspäivää ({formatEur(rollforward.excluded.preOpeningAmount)})
                                  eikä niitä lasketa mukaan.{" "}
                                </>
                              )}
                              {rollforward.excluded.undatedTxCount > 0 && (
                                <>
                                  {rollforward.excluded.undatedTxCount} tapahtumalta puuttuu päivä.
                                </>
                              )}
                            </p>
                          )}
                          <BalanceTable
                            months={rollforward.months}
                            busyMonth={busyMonth}
                            onSave={(month, value) => saveBalance(account.id, month, value)}
                            onClear={(month) => clearBalance(account.id, month)}
                          />
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {(showArchived || (overview.archivedCount ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => setShowArchived((value) => !value)}
                className="w-full min-h-11 text-xs text-warm-gray py-2"
              >
                {showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut"}
              </button>
            )}
          </>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmRemove !== null}
        title="Poistetaanko pankkitili?"
        description={
          confirmRemove
            ? `${confirmRemove.name}${
                confirmRemove.statementCount > 0
                  ? ` – tilillä on ${confirmRemove.statementCount} tiliotetta, joten se arkistoidaan poiston sijaan.`
                  : ""
              }`
            : ""
        }
        confirmLabel="Poista"
        onConfirm={() => confirmRemove && void removeAccount(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
