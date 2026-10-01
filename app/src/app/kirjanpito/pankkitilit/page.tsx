"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice, EmptySection, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import {
  BankAccountForm,
  type BankAccountFormPayload,
} from "@/components/bank/BankAccountForm";
import { BalanceTable, type MonthRow } from "@/components/bank/BalanceTable";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatEur, formatMonth } from "@/lib/format";
import { formatIban, maskIban } from "@/lib/iban";
import { CopyButton } from "@/components/ds/CopyButton";
import BankConnectCard from "@/components/BankConnectCard";
import { StatementFilesSection } from "@/components/bank/StatementFilesSection";
import { Button } from "@/components/ui";
import { Sparkline } from "@/components/ds/charts";
import { TREND_MIN_POINTS, trendAriaLabel, trendCaption } from "@/lib/bank-trend";
import { Card, ListRow, PageTitle, Section, Skeleton, SkeletonGroup, useSkeletonFade } from "@/components/ds";

import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { usePersistedState } from "@/lib/list-ui-state";
import { tintedButtonClass } from "@/components/control-styles";

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
  /** Closing balances (euros) of the last up to 6 months; empty when there are fewer than 3. */
  balanceTrend?: number[];
}

interface Overview {
  accounts: AccountSummary[];
  totalBalance: number;
  totalAccounts: number;
  archivedCount?: number;
  excludedCurrencies: string[];
  needsAttention: number;
  /** OWN-18: accounts of a bank consent that no ledger account covers (additive; absent in an old cache). */
  connected?: { accountCount: number };
  /** OWN-18: ledger plus connected accounts, each IBAN once. */
  combined?: { accountCount: number; totalBalance: number; excludedCurrencies: string[] };
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

/** Final-size placeholder for the account list (L1): the section heading and two rows. */
function AccountsSkeleton() {
  return (
    <SkeletonGroup label="Ladataan pankkitilejä" className="space-y-3">
      <Skeleton className="mx-1 h-3 w-28" />
      <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {[0, 1].map((row) => (
          <div key={row} className="flex min-h-16 items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton tone="soft" className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
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
 * "Nordea · FI21 •••• 0785 · USD · Oletus · Täsmätty elokuu 2026 · 3 tiliotetta"
 * (whichever pieces are known). Plain text, not a trailing badge: even though
 * `ListRow`'s `trailing` wrapper is now `pointer-events-none` by default (a
 * purely decorative badge there no longer blocks the row's own click - see
 * ListRow.tsx), a handful of short status words read more calmly as one
 * secondary line than as a row of small pills competing with the amount for
 * space on a 390px screen, so this keeps them here rather than moving them
 * back to `StatusTag`s.
 */
function accountSecondary(account: AccountSummary): string {
  const parts = [
    account.bankName,
    account.iban ? maskIban(account.iban) : null,
    account.currency !== "EUR" ? account.currency : null,
  ].filter(Boolean);
  const base = parts.join(" · ") || "Ei IBANia";
  const flags: string[] = [];
  if (account.isDefault) flags.push("Oletus");
  if (account.archivedAt) flags.push("Arkistoitu");
  if (account.mismatchCount > 0) flags.push(`${account.mismatchCount} kk ei täsmää`);
  if (account.lastReconciledMonth) flags.push(`Saldo täsmää ${formatMonth(account.lastReconciledMonth)}`);
  flags.push(account.statementCount === 1 ? "1 tiliote" : `${account.statementCount} tiliotetta`);
  return flags.length > 0 ? `${base} · ${flags.join(" · ")}` : base;
}

/** The "6 kk saldo" line under an account row; nothing under three months of data. */
function AccountTrend({ account }: { account: AccountSummary }) {
  const points = account.balanceTrend ?? [];
  if (points.length < TREND_MIN_POINTS) return null;
  const rose = points[points.length - 1] >= points[0];
  return (
    <span className="flex items-center gap-3">
      <span className="shrink-0 text-caption text-ink-2">{trendCaption(points.length)}</span>
      <Sparkline
        points={points}
        tone={rose ? "success" : "neutral"}
        height={24}
        className="max-w-36"
        animateKey={`bank-trend-${account.id}`}
        ariaLabel={trendAriaLabel(points, account.currency, formatEur)}
      />
    </span>
  );
}

export default function BankAccountsPage() {
  const cached = readPageCache<Overview>("bank-overview");
  const [fetchedOverview, setOverview] = useState<Overview | null>(cached);
  // Cold launch: the cache is hydrated after this page mounted, so the copy
  // from the last session paints once it is readable instead of the skeleton (N3).
  const lateOverview = useCacheAfterBoot<Overview>("bank-overview");
  const overview = fetchedOverview ?? lateOverview;
  const [loadStatus, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  const status = overview ? "ready" : loadStatus;
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

  // `message` is shared page state (also read by the create/edit sheet's own banner) - it
  // must never carry an old sheet's leftover error/success text into a sheet that opens
  // next, so every sheet transition clears it first.
  function openDetail(account: AccountSummary) {
    setMessage(null);
    setDetailAccount(account);
    void loadRollforward(account.id);
  }

  function closeDetail() {
    setMessage(null);
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
      const saved = await readJson<{ restored?: boolean; account?: { name?: string } }>(response, "Tallennus epäonnistui");
      setFormMode("hidden");
      if (saved.restored) {
        // The IBAN belonged to an archived account: it is back, as it was.
        showSuccess(`Tämä IBAN kuului arkistoituun tiliin${saved.account?.name ? ` "${saved.account.name}"` : ""}. Tili palautettiin käyttöön entisillä tiedoillaan.`);
      }
      await load();
      if (editing && detailAccount?.id === editing.id) await loadRollforward(editing.id);
    } catch (error) {
      showError(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  // Rethrows on failure (rather than showing a page/sheet-level banner): `BalanceTable`
  // itself catches this, keeps the editor open with the typed draft, and shows the
  // message as a role="alert" right under that month's own input - the only place
  // guaranteed to still be in the viewport (a banner at the sheet's top can easily be
  // scrolled out of view once the user has scrolled down to a specific month).
  async function saveBalance(accountId: string, month: string, closingBalance: number) {
    setBusyMonth(month);
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
      throw new Error(errorMessage(error, "Saldon tallennus epäonnistui"));
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
      throw new Error(errorMessage(error, "Saldon poisto epäonnistui"));
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

  async function restoreAccount(account: AccountSummary) {
    try {
      const response = await apiFetch(`/api/bank-accounts/${account.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      await readJson(response, "Tilin palautus epäonnistui");
      showSuccess("Tili on taas käytössä.");
      await load();
      setDetailAccount((current) => (current ? { ...current, archivedAt: null } : current));
    } catch (error) {
      showError(errorMessage(error, "Tilin palautus epäonnistui"));
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

  function openManualForm() {
    setMessage(null);
    setFormMode("create");
  }

  const archivedCount = overview?.archivedCount ?? 0;
  // OWN-18: the total counts the connected bank accounts too (one IBAN once).
  const total = overview?.combined ?? (overview
    ? { accountCount: overview.totalAccounts, totalBalance: overview.totalBalance, excludedCurrencies: overview.excludedCurrencies }
    : null);
  const connectedCount = overview?.connected?.accountCount ?? 0;
  const fade = useSkeletonFade(status === "loading");

  return (
    <>
      <div className="space-y-6">
        <PageTitle title="Pankkiyhteys ja tilit" subtitle="Yhdistetyt pankit, tilit ja tiliotteet." />

        {/* Connect first (OWN-06, BOOKS-01): the bank connection leads the page and
            never waits for the profile (BOOKS-07). Manual entry is the quiet link below. */}
        <BankConnectCard onAddManual={openManualForm} quietError={status === "error"} />

        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("bank-overview")} onRetry={() => void load()} />
        )}
        {status === "loading" && <AccountsSkeleton />}
        {status === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback="Pankkitilien haku epäonnistui"
            onRetry={() => void load()}
            compact
          />
        )}

        {status === "ready" && overview && (
          <div className={`space-y-3 ${fade}`}>
            {total && total.accountCount > 0 && (
              <Card className="space-y-1">
                <p className="text-caption text-ink-2">Yhteenlaskettu saldo</p>
                <p className="text-title-2 font-bold tracking-[-0.02em] tabular-nums text-ink">
                  {formatEur(total.totalBalance)}
                </p>
                <p className="text-caption text-ink-2">
                  {total.accountCount === 1 ? "1 tili" : `${total.accountCount} tiliä`}
                  {overview.needsAttention > 0 && (
                    <span className="text-danger"> · {overview.needsAttention} vaatii saldon tarkistusta</span>
                  )}
                </p>
                {total.excludedCurrencies.length > 0 && (
                  <p className="text-caption text-warning">
                    Summasta puuttuvat muut valuutat: {total.excludedCurrencies.join(", ")}
                  </p>
                )}
              </Card>
            )}

            {/* Only shown here while neither sheet is open - an action moved into the
                add/edit or detail sheet below renders this same message inside that
                sheet instead, since a page-level banner sits behind the overlay. */}
            {formMode === "hidden" && detailAccount === null && (
              <MessageBanner message={message} isError={messageIsError} />
            )}

            {overview.accounts.length === 0 ? (
              <EmptySection title="Kirjanpidon tilit">
                {connectedCount > 0
                  ? "Pankkiyhteyden tilit näkyvät yllä. Tiliä ei tarvitse lisätä käsin."
                  : archivedCount > 0
                    ? `Ei käytössä olevia tilejä. Arkistoituja tilejä on ${archivedCount}.`
                    : "Ei vielä tilejä. Yhdistä pankki yllä tai tuo tiliote tiedostona."}
              </EmptySection>
            ) : (
            <Section title="Kirjanpidon tilit">
              {overview.accounts.length > 0 ? (
                overview.accounts.map((account) => (
                  // The dimming wrapper is a plain div, not a ListRow prop (ListRow has no
                  // className escape hatch) - it still works as a Section child for the
                  // divide-y styling, which only cares about direct children, not their tag.
                  <div key={account.id} className={account.archivedAt ? "opacity-60" : undefined}>
                    <ListRow
                      onClick={() => openDetail(account)}
                      title={account.name}
                      amount={formatEur(account.currentBalance)}
                      secondary={accountSecondary(account)}
                      footer={<AccountTrend account={account} />}
                    />
                  </div>
                ))
              ) : null}
            </Section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-x-4 px-1">
              <button
                type="button"
                onClick={openManualForm}
                className={tintedButtonClass("accent")}
              >
                Lisää tili käsin
              </button>
              {(showArchived || archivedCount > 0) && (
                <button
                  type="button"
                  onClick={() => setShowArchived((value) => !value)}
                  className={tintedButtonClass("neutral")}
                >
                  {showArchived ? "Piilota arkistoidut" : `Näytä arkistoidut (${archivedCount})`}
                </button>
              )}
            </div>
          </div>
        )}
        {/* Tiliote files moved here from the Pankki screen, whose list is the rows themselves. */}
        <StatementFilesSection />
      </div>

      <BottomSheet
        isOpen={formMode !== "hidden"}
        onClose={() => {
          setMessage(null);
          setFormMode("hidden");
        }}
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
            onCancel={() => {
              setMessage(null);
              setFormMode("hidden");
            }}
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
            <p className="text-caption text-ink-2">{accountSecondary(detailAccount)}</p>
            {detailAccount.iban ? (
              // AX-07, R25: the row shows the IBAN masked; the full number can be copied here.
              <div className="flex justify-start">
                <CopyButton text={formatIban(detailAccount.iban)} what="IBAN" />
              </div>
            ) : null}

            <MessageBanner message={message} isError={messageIsError} />

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setMessage(null);
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
              {detailAccount.archivedAt && (
                <Button type="button" onClick={() => void restoreAccount(detailAccount)}>
                  Palauta käyttöön
                </Button>
              )}
              {/* An account with tiliotteet can only be archived, and it already is. */}
              {!(detailAccount.archivedAt && detailAccount.statementCount > 0) && (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => {
                    setMessage(null);
                    setDetailAccount(null);
                    setConfirmRemove(detailAccount);
                  }}
                >
                  Poista
                </Button>
              )}
            </div>

            {rollforward === null ? (
              <LoadingState label="Ladataan saldoja" rows={2} />
            ) : (
              <>
                {(rollforward.excluded.undatedTxCount > 0 ||
                  rollforward.excluded.preOpeningTxCount > 0) && (
                  <p className="text-caption text-warning leading-relaxed">
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
                  <p className="mb-2 px-1 text-caption text-ink-2">Kuukausien saldot</p>
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
