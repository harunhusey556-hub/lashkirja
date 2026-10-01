"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Landmark } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { ConnectionNotice } from "@/components/ScreenState";
import { Button } from "@/components/ui";
import { buttonClass } from "@/components/control-styles";
import { Icon, IconTile } from "@/components/ds";
import { Skeleton } from "@/components/ds/Skeleton";
import BankPickerSheet, { BankLogo } from "@/components/bank/BankPickerSheet";
import BankSetupSheet from "@/components/bank/BankSetupSheet";
import { useBankConnections } from "@/components/bank/useBankConnections";
import { calmBankError, consentReconnectCopy, consentWithdrawn } from "@/lib/bank-consent-copy";
import { consumeInterruptedBankAuth } from "@/lib/open-bank-auth";
import { accountOutcomeText, isSyncNotice, syncOutcomeMessage, type AccountSyncRow } from "@/lib/bank-sync-summary";
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
 * The Pankki row of the Kirjanpito hub (OWN-06). It opens the Pankki screen,
 * where every bank row, the accounts and the connection live. Not connected:
 * a filled "Yhdistä" pill still opens the bank list right here.
 */
export function BankConnectRow() {
  const { data, error } = useBankConnections();
  return <BankConnectRowView data={data} error={error} />;
}

/**
 * The row for a page that loads the connections itself (the Kirjanpito hub):
 * with `quietError` a failed load leaves the line blank, because the page's
 * one failure card says it (F34).
 */
export function BankConnectRowView({
  data,
  error,
  quietError = false,
}: {
  data: ReturnType<typeof useBankConnections>["data"];
  error: unknown;
  quietError?: boolean;
}) {
  const sheets = useConnectSheets();
  const state = data ? bankState(data) : null;
  const line = state ? state.line : error && !quietError ? "Tilaa ei saatu haettua" : " ";
  const title = "Pankki";

  const pill =
    "active-press relative z-10 inline-flex min-h-9 shrink-0 items-center rounded-full bg-ink px-3.5 text-caption font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

  return (
    <>
      <div data-testid="bank-connect-row" className="relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left">
        <Link
          href="/pankki/tapahtumat"
          aria-label={typeof line === "string" && line.trim() ? `${title}, ${line}` : title}
          className="row-link active-press absolute inset-0"
        />
        <IconTile>
          <Icon icon={Landmark} />
        </IconTile>
        <span className="pointer-events-none min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink">{title}</span>
          <span className={`mt-0.5 block text-caption ${state?.kind === "attention" ? "text-warning" : "text-ink-2"}`}>
            {line}
          </span>
        </span>
        {state?.kind === "none" ? (
          <button type="button" onClick={() => sheets.openPicker()} className={pill}>
            Yhdistä
          </button>
        ) : (
          <span aria-hidden className="pointer-events-none -mr-1 flex text-ink-2/60">
            <Icon icon={ChevronRight} />
          </span>
        )}
      </div>
      <BankPickerSheet isOpen={sheets.picker.open} onClose={sheets.closePicker} preferredPsu={sheets.picker.psu} />
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
  quietError = false,
}: {
  variant?: "full" | "compact";
  /** The page already shows its own failure card: do not add a second one (VS-31). */
  quietError?: boolean;
  /** Full variant: the quiet "Lisää tili käsin" route. */
  onAddManual?: () => void;
}) {
  const bank = useBankConnections();
  const sheets = useConnectSheets();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"ok" | "note" | "err">("ok");
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
      const data = await readJson<{
        imported: number;
        statementId: string | null;
        accounts?: AccountSyncRow[];
        notice?: string | null;
      }>(
        response,
        "Synkronointi epäonnistui"
      );
      bank.reload();
      const accounts = data.accounts || [];
      const outcome = syncOutcomeMessage(accounts, data.imported, data.notice ?? null);
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

  // A failed lookup is the shared failure card in the place of this card, never a card inside it (VS-31).
  if (!state && bank.error != null) {
    if (quietError) return null;
    return (
      <div id="pankkiyhteys" data-testid="bank-connect-card" data-state="error" className="scroll-mt-20">
        <ConnectionNotice error={bank.error} fallback="Pankkiyhteyden haku epäonnistui" onRetry={bank.reload} />
      </div>
    );
  }

  return (
    <section
      id="pankkiyhteys"
      data-testid="bank-connect-card"
      data-state={state?.kind ?? "loading"}
      className="scroll-mt-20 rounded-card border border-line bg-surface"
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <IconTile>
          <Icon icon={Landmark} />
        </IconTile>
        <div className="min-w-0 flex-1">
          {state ? (
            <>
              <h2 className="text-body font-semibold text-ink">{title}</h2>
              <p className={`mt-0.5 text-caption leading-relaxed ${state.kind === "attention" ? "text-warning" : "text-ink-2"}`}>
                {lead}
              </p>
            </>
          ) : (
            <div aria-hidden className="space-y-2 pt-0.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton tone="soft" className="h-3 w-4/5" />
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 px-4 pb-4">
        {!state ? (
          <Skeleton radius="card" className="h-12 w-full" />
        ) : state.kind === "unconfigured" ? (
          <>
            {/* Not the dark primary, because it cannot connect yet, but fully legible
                and still tappable: the tap says what works today. */}
            <button
              type="button"
              onClick={sheets.openSetup}
              aria-disabled="true"
              aria-describedby="bank-unconfigured-note"
              className={buttonClass("secondary", "w-full")}
            >
              Yhdistä pankki
            </button>
            <p id="bank-unconfigured-note" className="text-center text-caption text-ink-2">
              <button type="button" onClick={sheets.openSetup} className="active-press min-h-11 font-medium text-accent">
                {BANK_COPY.setupLink}
              </button>
            </p>
            {/* The routes that work today. "Lisää tili käsin" is in "Mitä tarvitaan"
                and quietly at the foot of Pankkitilit, never a second loud button here. */}
            {variant === "full" && (
              <div className="flex justify-center border-t border-line pt-1">
                <Link href="/kirjanpito/pankkitilit#tiliotteet" className="active-press inline-flex min-h-11 items-center text-caption font-medium text-ink-2">
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
            className="active-press flex min-h-12 w-full items-center justify-center rounded-card bg-ink px-4 text-body font-semibold text-canvas"
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
                shownMessage={message}
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
            <p
              className={`text-sm leading-relaxed ${
                messageTone === "err" ? "text-danger" : messageTone === "note" ? "text-ink" : "text-success"
              }`}
            >
              {message}
            </p>
            {syncAccounts && syncAccounts.length > 0 && (
              <ul className="space-y-1">
                {syncAccounts.map((account) => (
                  <li key={account.accountId} className="text-sm leading-relaxed text-ink">
                    {account.name}:{" "}
                    {account.ok
                      ? accountOutcomeText(account)
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
  shownMessage,
  onSync,
  onReconnect,
  onDisconnect,
  onToggleAccount,
}: {
  connection: BankConnectionSummary;
  busyId: string | null;
  /** The sync message already on screen; the stored note is not repeated under it. */
  shownMessage: string;
  onSync: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onToggleAccount: (account: BankAccountSummary) => void;
}) {
  const reconnect = consentReconnectCopy(connection);
  const withdrawn = consentWithdrawn(connection);
  const canSync = connection.status === "active" && !reconnect;
  const hasScope = connection.accounts.some((account) => account.inScope);
  // Older rows can still hold text written for the server's operator.
  const shownError = calmBankError(connection.lastError);
  return (
    <div className="space-y-3 rounded-card border border-line p-3" data-testid="bank-connection">
      <div className="flex items-start gap-3">
        <BankLogo name={connection.aspspName} logo={connection.aspspLogo} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-ink">{connection.aspspName}</p>
          <p className="mt-0.5 text-caption text-ink-2">
            {withdrawn ? "Lupa peruttu" : STATUS_LABEL[connection.status] || "Tuntematon tila"} ·{" "}
            {connection.psuType === "business" ? "Yritystili" : "Henkilötili"}
          </p>
          <p className="mt-0.5 text-caption text-ink-2">Viimeisin onnistunut haku {formatWhen(connection.lastSuccessAt)}</p>
        </div>
      </div>

      {reconnect && (
        <div className="space-y-1 rounded-card bg-accent-soft px-3 py-3" role="status">
          <p className="text-sm font-medium text-ink">
            {withdrawn ? "Pankki on peruuttanut luvan" : "Yhteys pitää vahvistaa uudelleen"}
          </p>
          <p className="text-sm leading-relaxed text-ink">
            {withdrawn ? "Vahvista yhteys uudelleen, niin tapahtumat haetaan taas." : `Syy: ${reconnect.reason}`}
          </p>
          <p className="text-sm leading-relaxed text-ink">
            Tilit: {reconnect.accounts.length > 0 ? reconnect.accounts.join(", ") : "ei tilejä"}
          </p>
        </div>
      )}

      {shownError && connection.status === "active" && !reconnect && shownError !== shownMessage && (
        // A notice (something waits, something is older than asked for) is a calm
        // note; only a failure is an alarm.
        isSyncNotice(shownError) ? (
          <p className="text-sm leading-relaxed text-ink-2" role="status">
            {shownError}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-danger" role="alert">
            {shownError}
          </p>
        )
      )}

      {connection.accounts.length > 0 && (
        <div className="space-y-2">
          <p className="text-caption leading-relaxed text-ink-2">
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
                <span className="mt-0.5 block text-caption text-ink-2">
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
      {canSync && !hasScope && <p className="text-caption text-ink-2">Valitse ainakin yksi tili ennen hakua.</p>}
    </div>
  );
}
