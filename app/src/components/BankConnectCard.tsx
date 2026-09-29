"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Landmark } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { ConnectionNotice } from "@/components/ScreenState";
import { Button } from "@/components/ui";
import { Icon, IconTile, SlotSkeleton } from "@/components/ds";
import { Skeleton } from "@/components/ds/Skeleton";
import BankPickerSheet, { BankLogo } from "@/components/bank/BankPickerSheet";
import BankSetupSheet from "@/components/bank/BankSetupSheet";
import { useBankConnections } from "@/components/bank/useBankConnections";
import { consentReconnectCopy } from "@/lib/bank-consent-copy";
import { consumeInterruptedBankAuth } from "@/lib/open-bank-auth";
import { syncOutcomeMessage, type AccountSyncRow } from "@/lib/bank-sync-summary";
import { BANK_COPY, bankState, type BankAccountSummary, type BankConnectionSummary } from "@/lib/bank-status";
import { detailHref } from "@/lib/routes";
import { hapticNotify } from "@/lib/haptics";

const STATUS_LABEL: Record<string, string> = {
  pending: "Odottaa vahvistusta",
  authorizing: "Yhdistetään",
  active: "Yhdistetty",
  expired: "Vanhentunut",
  revoked: "Katkaistu",
  error: "Virhe",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "ei vielä";
  return new Date(iso).toLocaleString("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEur(value: number): string {
  return `${value.toLocaleString("fi-FI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

type PsuType = "business" | "personal";

/** Picker and "Mitä tarvitaan" sheets shared by every variant. */
function useConnectSheets() {
  const [picker, setPicker] = useState<{ open: boolean; psu?: PsuType }>({ open: false });
  const [setupOpen, setSetupOpen] = useState(false);
  return {
    picker,
    openPicker: (psu?: PsuType) => setPicker({ open: true, psu }),
    closePicker: () => setPicker((current) => ({ ...current, open: false })),
    setupOpen,
    openSetup: () => setSetupOpen(true),
    closeSetup: () => setSetupOpen(false),
  };
}

/**
 * Hub row (OWN-06): "Yhdistä pankki" one tap from the Kirjanpito tab, with
 * the state line. Not connected: a filled "Yhdistä" opens the bank list
 * right here. Not configured: opens "Mitä tarvitaan". Connected: goes to
 * the connection on Pankkitilit. Render it inside a ds `Section`.
 */
export function BankConnectRow() {
  const { data, error } = useBankConnections();
  const sheets = useConnectSheets();
  const state = data ? bankState(data) : null;
  const line = state ? state.line : error ? "Tilaa ei saatu haettua" : " ";
  const title = state?.kind === "connected" || state?.kind === "attention" ? "Pankkiyhteys" : "Yhdistä pankki";

  const body = (
    <>
      <IconTile>
        <Icon icon={Landmark} />
      </IconTile>
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink">{title}</span>
        <span className={`mt-0.5 block text-[13px] ${state?.kind === "attention" ? "text-warning" : "text-ink-2"}`}>
          {line}
        </span>
      </span>
    </>
  );
  const rowClass = "relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left";
  const pill =
    "active-press relative pointer-events-auto inline-flex min-h-9 shrink-0 items-center rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

  let row;
  if (state?.kind === "none") {
    row = (
      <div data-testid="bank-connect-row" className={rowClass}>
        <button type="button" aria-label="Yhdistä pankki" onClick={() => sheets.openPicker()} className="row-link active-press absolute inset-0" />
        {body}
        <span className="relative z-10 pointer-events-none">
          <button type="button" onClick={() => sheets.openPicker()} className={pill} tabIndex={-1} aria-hidden>
            Yhdistä
          </button>
        </span>
      </div>
    );
  } else if (state?.kind === "unconfigured") {
    row = (
      <div data-testid="bank-connect-row" className={rowClass}>
        <button
          type="button"
          aria-label="Yhdistä pankki, ei vielä käytössä. Mitä tarvitaan"
          onClick={sheets.openSetup}
          className="row-link active-press absolute inset-0"
        />
        {body}
        <span aria-hidden className="pointer-events-none -mr-1 flex text-ink-2/60">
          <Icon icon={ChevronRight} />
        </span>
      </div>
    );
  } else {
    row = (
      <div data-testid="bank-connect-row" className={rowClass}>
        <Link
          href="/kirjanpito/pankkitilit#pankkiyhteys"
          aria-label={typeof line === "string" ? `${title}, ${line}` : title}
          className="row-link active-press absolute inset-0"
        />
        {body}
        <span aria-hidden className="pointer-events-none -mr-1 flex text-ink-2/60">
          <Icon icon={ChevronRight} />
        </span>
      </div>
    );
  }

  return (
    <>
      {row}
      <BankPickerSheet isOpen={sheets.picker.open} onClose={sheets.closePicker} preferredPsu={sheets.picker.psu} />
      <BankSetupSheet isOpen={sheets.setupOpen} onClose={sheets.closeSetup} />
    </>
  );
}

/**
 * The bank connection card (OWN-06, BOOKS-01/03/04/06).
 *
 * - `full` (top of Pankkitilit): every state, including the connected banks
 *   with their account scope, "Synkronoi nyt" and "Katkaise".
 * - `compact` (Tapahtumat): only while nothing usable is connected; renders
 *   nothing once a bank is connected.
 *
 * Not configured is a real state, never hidden: plain Finnish, a tappable
 * "Yhdistä pankki" that explains what is missing, and the routes that work.
 */
export default function BankConnectCard({
  variant = "full",
  onAddManual,
}: {
  variant?: "full" | "compact";
  /** Full variant: the quiet "Lisää tili käsin" route. */
  onAddManual?: () => void;
}) {
  const bank = useBankConnections();
  const sheets = useConnectSheets();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"ok" | "err">("ok");
  const [syncAccounts, setSyncAccounts] = useState<AccountSyncRow[] | null>(null);
  const [statementHref, setStatementHref] = useState<string | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);

  useEffect(() => {
    if (variant !== "full") return;
    const showInterrupted = () => {
      if (!consumeInterruptedBankAuth()) return;
      setMessageTone("err");
      setMessage("Yhdistäminen keskeytyi tai pankin istunto vanheni. Voit yrittää uudelleen.");
    };
    showInterrupted();
    window.addEventListener("pageshow", showInterrupted);
    return () => window.removeEventListener("pageshow", showInterrupted);
  }, [variant]);

  const state = bank.data ? bankState(bank.data) : null;
  const connections = bank.data?.connections ?? [];

  if (variant === "compact" && (state?.kind === "connected" || (!state && !bank.loading))) return null;
  if (variant === "compact" && bank.loading) return null;

  async function toggleAccount(connectionId: string, account: BankAccountSummary) {
    const next = !account.inScope;
    const setScope = (value: boolean) =>
      bank.updateConnections((current) =>
        current.map((connection) =>
          connection.id === connectionId
            ? {
                ...connection,
                accounts: connection.accounts.map((item) => (item.id === account.id ? { ...item, inScope: value } : item)),
              }
            : connection
        )
      );
    setScope(next);
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: [{ id: account.id, inScope: next }] }),
      });
      const data = await readJson<{ connection: BankConnectionSummary }>(response, "Tilin valinta epäonnistui");
      if (data.connection) {
        bank.updateConnections((current) =>
          current.map((connection) => (connection.id === data.connection.id ? data.connection : connection))
        );
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setScope(account.inScope);
      setMessageTone("err");
      setMessage(errorMessage(error, "Tilin valinta epäonnistui"));
    }
  }

  async function syncConnection(connectionId: string) {
    if (busyId) return;
    setBusyId(connectionId);
    setMessage("");
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}/sync`, { method: "POST" });
      const data = await readJson<{ imported: number; statementId: string | null; accounts?: AccountSyncRow[] }>(
        response,
        "Synkronointi epäonnistui"
      );
      bank.reload();
      const accounts = data.accounts || [];
      const outcome = syncOutcomeMessage(accounts, data.imported);
      setSyncAccounts(accounts);
      setStatementHref(data.statementId ? detailHref("statement", data.statementId) : null);
      setMessageTone(outcome.tone);
      setMessage(outcome.text);
      void hapticNotify(outcome.tone === "ok" ? "success" : "warning");
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setSyncAccounts(null);
      setStatementHref(null);
      setMessageTone("err");
      setMessage(errorMessage(error, "Synkronointi epäonnistui"));
      void hapticNotify("error");
      bank.reload();
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(connectionId: string) {
    setBusyId(connectionId);
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}`, { method: "DELETE" });
      await readJson(response, "Yhteyden katkaisu epäonnistui");
      bank.updateConnections((current) => current.filter((connection) => connection.id !== connectionId));
      setMessageTone("ok");
      setMessage("Pankkiyhteys katkaistu. Jo haetut tiliotteet säilyvät.");
      setDisconnectId(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const text = errorMessage(error, "Yhteyden katkaisu epäonnistui");
      setMessageTone("err");
      setMessage(text);
      throw new Error(text);
    } finally {
      setBusyId(null);
    }
  }

  const title = state?.title ?? "Pankkiyhteys";
  const lead =
    state?.kind === "unconfigured"
      ? BANK_COPY.unconfiguredBody
      : state?.kind === "none"
        ? BANK_COPY.noneBody
        : state?.line ?? "";

  return (
    <section
      id="pankkiyhteys"
      data-testid="bank-connect-card"
      data-state={state?.kind ?? (bank.error ? "error" : "loading")}
      className="scroll-mt-20 rounded-card border border-line bg-surface"
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <IconTile>
          <Icon icon={Landmark} />
        </IconTile>
        <div className="min-w-0 flex-1">
          {state ? (
            <>
              <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
              <p className={`mt-0.5 text-[13px] leading-relaxed ${state.kind === "attention" ? "text-warning" : "text-ink-2"}`}>
                {lead}
              </p>
            </>
          ) : bank.error ? (
            <h2 className="text-[15px] font-semibold text-ink">Pankkiyhteys</h2>
          ) : (
            <div aria-hidden className="space-y-2 pt-0.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton tone="soft" className="h-3 w-4/5" />
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 px-4 pb-4">
        {!state && bank.error != null ? (
          <ConnectionNotice error={bank.error} fallback="Pankkiyhteyden haku epäonnistui" onRetry={bank.reload} compact />
        ) : !state ? (
          <Skeleton radius="card" className="h-12 w-full" />
        ) : state.kind === "unconfigured" ? (
          <>
            {/* Looks unavailable, stays tappable: the tap explains what is missing. */}
            <button
              type="button"
              onClick={sheets.openSetup}
              aria-describedby="bank-unconfigured-note"
              className="active-press flex min-h-12 w-full items-center justify-center rounded-card bg-ink/30 px-4 text-[15px] font-semibold text-canvas"
            >
              Yhdistä pankki
            </button>
            <p id="bank-unconfigured-note" className="text-center text-[13px] text-ink-2">
              <button type="button" onClick={sheets.openSetup} className="active-press min-h-11 font-medium text-accent">
                Mitä tarvitaan?
              </button>
            </p>
            {/* The routes that work today. "Lisää tili käsin" is in "Mitä tarvitaan"
                and quietly at the foot of Pankkitilit, never a second loud button here. */}
            {variant === "full" && (
              <div className="flex justify-center border-t border-line pt-1">
                <Link href="/pankki/tapahtumat" className="active-press inline-flex min-h-11 items-center text-[13px] font-medium text-ink-2">
                  Tuo tiliote tiedostona
                </Link>
              </div>
            )}
          </>
        ) : state.kind === "none" ? (
          <Button type="button" className="w-full" onClick={() => sheets.openPicker()}>
            Yhdistä pankki
          </Button>
        ) : variant === "compact" ? (
          <Link
            href="/kirjanpito/pankkitilit#pankkiyhteys"
            className="active-press flex min-h-12 w-full items-center justify-center rounded-card bg-ink px-4 text-[15px] font-semibold text-canvas"
          >
            Vahvista uudelleen
          </Link>
        ) : (
          <>
            {connections.map((connection) => (
              <ConnectionBlock
                key={connection.id}
                connection={connection}
                busyId={busyId}
                onSync={() => void syncConnection(connection.id)}
                onReconnect={() => sheets.openPicker(connection.psuType === "personal" ? "personal" : "business")}
                onDisconnect={() => setDisconnectId(connection.id)}
                onToggleAccount={(account) => void toggleAccount(connection.id, account)}
              />
            ))}
            <Button type="button" variant="secondary" className="w-full" onClick={() => sheets.openPicker()}>
              Yhdistä toinen pankki
            </Button>
          </>
        )}

        {variant === "full" && message && (
          <div className="space-y-2" role={messageTone === "err" ? "alert" : "status"}>
            <p className={`text-sm leading-relaxed ${messageTone === "err" ? "text-danger" : "text-success"}`}>{message}</p>
            {syncAccounts && syncAccounts.length > 0 && (
              <ul className="space-y-1">
                {syncAccounts.map((account) => (
                  <li key={account.accountId} className="text-sm leading-relaxed text-ink">
                    {account.name}:{" "}
                    {account.ok
                      ? account.imported > 0
                        ? `${account.imported} uutta tapahtumaa`
                        : "ei uusia tapahtumia"
                      : `epäonnistui. ${account.error || "Tapahtumien haku epäonnistui."}`}
                  </li>
                ))}
              </ul>
            )}
            {statementHref && (
              <Link href={statementHref} className="inline-flex min-h-11 items-center text-sm font-medium text-accent">
                Avaa tiliote
              </Link>
            )}
          </div>
        )}
      </div>

      <BankPickerSheet isOpen={sheets.picker.open} onClose={sheets.closePicker} preferredPsu={sheets.picker.psu} />
      <BankSetupSheet isOpen={sheets.setupOpen} onClose={sheets.closeSetup} onAddManual={onAddManual} />
      <ConfirmModal
        isOpen={disconnectId !== null}
        title="Katkaise pankkiyhteys?"
        description="Suostumus pankissa suljetaan. Jo haetut tiliotteet säilyvät."
        confirmLabel="Katkaise yhteys"
        onConfirm={() => (disconnectId ? disconnect(disconnectId) : Promise.resolve())}
        onCancel={() => setDisconnectId(null)}
      />
    </section>
  );
}

function ConnectionBlock({
  connection,
  busyId,
  onSync,
  onReconnect,
  onDisconnect,
  onToggleAccount,
}: {
  connection: BankConnectionSummary;
  busyId: string | null;
  onSync: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onToggleAccount: (account: BankAccountSummary) => void;
}) {
  const reconnect = consentReconnectCopy(connection);
  const canSync = connection.status === "active" && !reconnect;
  const hasScope = connection.accounts.some((account) => account.inScope);
  return (
    <div className="space-y-3 rounded-card border border-line p-3" data-testid="bank-connection">
      <div className="flex items-start gap-3">
        <BankLogo name={connection.aspspName} logo={connection.aspspLogo} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-ink">{connection.aspspName}</p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {STATUS_LABEL[connection.status] || "Tuntematon tila"} ·{" "}
            {connection.psuType === "business" ? "Yritystili" : "Henkilötili"}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2">Viimeisin onnistunut haku {formatWhen(connection.lastSuccessAt)}</p>
        </div>
      </div>

      {reconnect && (
        <div className="space-y-1 rounded-card bg-accent-soft px-3 py-3" role="status">
          <p className="text-sm font-medium text-ink">Yhteys pitää vahvistaa uudelleen</p>
          <p className="text-sm leading-relaxed text-ink">Syy: {reconnect.reason}</p>
          <p className="text-sm leading-relaxed text-ink">
            Tilit: {reconnect.accounts.length > 0 ? reconnect.accounts.join(", ") : "ei tilejä"}
          </p>
        </div>
      )}

      {connection.lastError && connection.status === "active" && !reconnect && (
        <p className="text-sm leading-relaxed text-danger" role="alert">
          {connection.lastError}
        </p>
      )}

      {connection.accounts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Valitse kirjanpitoon kuuluvat tilit. Uudet tilit eivät tule mukaan automaattisesti.
          </p>
          {connection.accounts.map((account) => (
            <label key={account.id} className="flex min-h-11 items-start gap-3 rounded-card bg-canvas px-3 py-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-accent"
                checked={account.inScope}
                onChange={() => onToggleAccount(account)}
              />
              <span className="min-w-0">
                <span className="block break-all text-sm font-medium text-ink">{account.iban}</span>
                <span className="mt-0.5 block text-[13px] text-ink-2">
                  {account.label || "Tili"}
                  {account.balance != null ? ` · ${formatEur(account.balance)}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {canSync && (
          <Button type="button" className="flex-1" onClick={onSync} disabled={busyId !== null || !hasScope} busy={busyId === connection.id} busyLabel="Haetaan…">
            Synkronoi nyt
          </Button>
        )}
        {reconnect && (
          <Button type="button" className="flex-1" onClick={onReconnect}>
            Vahvista uudelleen
          </Button>
        )}
        <Button type="button" variant="danger" onClick={onDisconnect} disabled={busyId !== null}>
          Katkaise
        </Button>
      </div>
      {canSync && !hasScope && <p className="text-[13px] text-ink-2">Valitse ainakin yksi tili ennen hakua.</p>}
    </div>
  );
}
