"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import {
  BankAccountForm,
  type BankAccountFormPayload,
} from "@/components/bank/BankAccountForm";
import { BalanceTable, type MonthRow } from "@/components/bank/BalanceTable";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatEur } from "@/lib/format";
import { maskIban } from "@/lib/iban";
import BankConnectCard from "@/components/BankConnectCard";
import { useProfile } from "@/app/asetukset/useProfile";
import { Button } from "@/components/ui";
import { Card, ListRow, PageTitle, Section } from "@/components/ds";

import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState } from "@/lib/list-ui-state";

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

function MessageBanner({ message, isError }: { message: string | null; isError: boolean }) {
  if (!message) return null;
  return (
    <p
      className={
        isError
          ? "rounded-card bg-danger/10 px-4 py-3 text-sm text-danger"
          : "rounded-card bg-accent-soft px-4 py-3 text-sm text-ink"
      }
      role={isError ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

/**
 * "Nordea · FI21 •••• 0785 · Oletus" (whichever pieces are known, plus any
 * status flags). Plain text, not a trailing badge: a `ListRow` `trailing`
 * sits in its own stacking layer above the row's own click target (so a
 * genuinely interactive trailing control, e.g. a MoreMenu, still works over
 * an `onClick`/`href` row) - for a purely decorative flag with nothing to
 * click, that layer only carves out a dead zone where the row itself stops
 * responding to taps.
 */
function accountSecondary(account: AccountSummary): string {
  const base =
    [account.bankName, account.iban ? maskIban(account.iban) : null].filter(Boolean).join(" · ") ||
    "Ei IBANia";
  const flags: string[] = [];
  if (account.isDefault) flags.push("Oletus");
  if (account.archivedAt) flags.push("Arkistoitu");
  if (account.mismatchCount > 0) flags.push(`${account.mismatchCount} kk ei täsmää`);
  return flags.length > 0 ? `${base} · ${flags.join(" · ")}` : base;
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
  const [detailAccount, setDetailAccount] = useState<AccountSummary | null>(null);
  const [rollforward, setRollforward] = useState<Rollforward | null>(null);
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(null);
  const [showArchived, setShowArchived] = usePersistedState("pankkitilit.showArchived", false);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/bank-accounts${showArchived ? "?includeArchived=1" : ""}`,
        { credentials: "include" }
      );
      const data = await readJson<Overview>(response, "Pankkitilien haku epäonnistui");
      writePageCache("bank-overview", data);
      setOverview(data);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setStatus((current) => (current === "ready" ? "ready" : "error"));
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

  function openDetail(account: AccountSummary) {
    setDetailAccount(account);
    void loadRollforward(account.id);
  }

  function closeDetail() {
    setDetailAccount(null);
    setRollforward(null);
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
      if (editing && detailAccount?.id === editing.id) await loadRollforward(editing.id);
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
      closeDetail();
      await load();
    } catch (error) {
      const message = errorMessage(error, "Poisto epäonnistui");
      showError(message);
      throw new Error(message);
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
      setDetailAccount((current) => (current ? { ...current, isDefault: true } : current));
    } catch (error) {
      showError(errorMessage(error, "Oletustilin vaihto epäonnistui"));
    }
  }

  const { profile, loadError: profileLoadError, retry: retryProfile } = useProfile();

  return (
    <>
      <div className="space-y-6 pb-6">
        <PageTitle
          title="Pankkitilit"
          subtitle="Kirjanpidon tilit, kuukausien loppusaldot ja pankkiyhteys."
          action={
            formMode === "hidden" && status === "ready" ? (
              <button
                type="button"
                onClick={() => setFormMode("create")}
                className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
              >
                <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                  <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                </svg>
                Lisää pankkitili
              </button>
            ) : undefined
          }
        />

        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("bank-overview")} onRetry={() => void load()} />
        )}
        {status === "loading" && <LoadingState label="Haetaan pankkitilejä…" />}
        {status === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback="Pankkitilien haku epäonnistui"
            onRetry={() => void load()}
          />
        )}

        {status === "ready" && overview && (
          <>
            {overview.accounts.length > 0 ? (
              <Card className="space-y-1">
                <p className="text-[13px] text-ink-2">Yhteenlaskettu saldo</p>
                <p className="text-[28px] font-bold tracking-[-0.02em] tabular-nums text-ink">
                  {formatEur(overview.totalBalance)}
                </p>
                <p className="text-[13px] text-ink-2">
                  {overview.totalAccounts} tiliä
                  {overview.needsAttention > 0 && (
                    <span className="text-danger"> · {overview.needsAttention} vaatii täsmäytystä</span>
                  )}
                </p>
                {overview.excludedCurrencies.length > 0 && (
                  <p className="text-[13px] text-warning">
                    Summasta puuttuvat muut valuutat: {overview.excludedCurrencies.join(", ")}
                  </p>
                )}
              </Card>
            ) : (
              <Card className="space-y-1 text-center">
                <p className="text-[15px] font-medium text-ink">Ei vielä kirjanpidon tilejä</p>
                <p className="text-[13px] text-ink-2 leading-relaxed">
                  Yhdistä pankki, jos tapahtumat haetaan suoraan. Käsin seurattava tili lisätään
                  yllä olevasta &ldquo;Lisää pankkitili&rdquo; -painikkeesta.
                </p>
              </Card>
            )}

            {/* Only shown here while neither sheet is open - an action moved into the
                add/edit or detail sheet below renders this same message inside that
                sheet instead, since a page-level banner sits behind the overlay. */}
            {formMode === "hidden" && detailAccount === null && (
              <MessageBanner message={message} isError={messageIsError} />
            )}

            <Section>
              {overview.accounts.map((account) => (
                <ListRow
                  key={account.id}
                  onClick={() => openDetail(account)}
                  title={account.name}
                  amount={formatEur(account.currentBalance)}
                  secondary={accountSecondary(account)}
                />
              ))}
            </Section>

            {(showArchived || (overview.archivedCount ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => setShowArchived((value) => !value)}
                className="active-press w-full min-h-11 text-[13px] text-ink-2 py-2"
              >
                {showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut"}
              </button>
            )}
          </>
        )}
        {profileLoadError ? (
          <ConnectionNotice
            error={new Error(profileLoadError)}
            fallback={profileLoadError}
            onRetry={retryProfile}
          />
        ) : profile ? (
          <BankConnectCard entityType={profile.entityType} />
        ) : (
          <div className="h-40 animate-pulse rounded-card bg-canvas" aria-hidden />
        )}
      </div>

      <BottomSheet
        isOpen={formMode !== "hidden"}
        onClose={() => setFormMode("hidden")}
        title={formMode === "create" ? "Uusi pankkitili" : "Muokkaa tiliä"}
        labelledBy="ba-sheet-title"
        heightClass="max-h-[94dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 space-y-4 sheet-safe-bottom">
          <MessageBanner message={message} isError={messageIsError} />
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
        </div>
      </BottomSheet>

      <BottomSheet
        isOpen={detailAccount !== null}
        onClose={closeDetail}
        title={detailAccount?.name}
        labelledBy="ba-detail-title"
        heightClass="max-h-[94dvh]"
      >
        {detailAccount && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 space-y-4 sheet-safe-bottom">
            <p className="text-[13px] text-ink-2">{accountSecondary(detailAccount)}</p>

            <MessageBanner message={message} isError={messageIsError} />

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDetailAccount(null);
                  setFormMode({ edit: detailAccount });
                }}
              >
                Muokkaa
              </Button>
              {!detailAccount.isDefault && !detailAccount.archivedAt && (
                <Button type="button" variant="secondary" onClick={() => void setDefault(detailAccount)}>
                  Aseta oletukseksi
                </Button>
              )}
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setDetailAccount(null);
                  setConfirmRemove(detailAccount);
                }}
              >
                Poista
              </Button>
            </div>

            {rollforward === null ? (
              <LoadingState label="Haetaan saldoja…" compact />
            ) : (
              <>
                {(rollforward.excluded.undatedTxCount > 0 ||
                  rollforward.excluded.preOpeningTxCount > 0) && (
                  <p className="text-[13px] text-warning leading-relaxed">
                    {rollforward.excluded.preOpeningTxCount > 0 && (
                      <>
                        {rollforward.excluded.preOpeningTxCount} tapahtumaa on ennen avauspäivää (
                        {formatEur(rollforward.excluded.preOpeningAmount)}) eikä niitä lasketa mukaan.{" "}
                      </>
                    )}
                    {rollforward.excluded.undatedTxCount > 0 && (
                      <>{rollforward.excluded.undatedTxCount} tapahtumalta puuttuu päivä.</>
                    )}
                  </p>
                )}
                <div>
                  <p className="mb-2 px-1 text-[13px] text-ink-2">Kuukausien saldot</p>
                  <BalanceTable
                    months={rollforward.months}
                    busyMonth={busyMonth}
                    onSave={(month, value) => saveBalance(detailAccount.id, month, value)}
                    onClear={(month) => clearBalance(detailAccount.id, month)}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </BottomSheet>

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
        onConfirm={() => (confirmRemove ? removeAccount(confirmRemove) : Promise.resolve())}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
