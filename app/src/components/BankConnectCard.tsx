"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ConfirmModal from "@/components/ConfirmModal";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { consentReconnectCopy } from "@/lib/bank-consent-copy";
import { consumeInterruptedBankAuth, leaveForBank } from "@/lib/open-bank-auth";
import { syncOutcomeMessage, type AccountSyncRow } from "@/lib/bank-sync-summary";
import { detailHref } from "@/lib/routes";
import { IS_MOBILE_BUILD } from "@/lib/build-target";

interface BankAccount {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  inScope: boolean;
  balance: number | null;
}

interface BankConnection {
  id: string;
  aspspName: string;
  aspspCountry: string;
  aspspLogo: string | null;
  psuType: string;
  status: string;
  validUntil: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  accounts: BankAccount[];
}

interface Aspsp {
  name: string;
  country: string;
  logo: string | null;
  psuTypes: string[];
  beta: boolean;
}

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
  return `${value.toLocaleString("fi-FI", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export default function BankConnectCard({ entityType }: { entityType: string }) {
  const defaultPsu = entityType === "kevytyrittaja" ? "personal" : "business";
  const [psuType, setPsuType] = useState<"personal" | "business">(defaultPsu);
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [setupMessage, setSetupMessage] = useState("");
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [aspsps, setAspsps] = useState<Aspsp[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [banksLoading, setBanksLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"ok" | "err">("ok");
  const [syncAccounts, setSyncAccounts] = useState<AccountSyncRow[] | null>(null);
  const [statementHref, setStatementHref] = useState<string | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const response = await apiFetch("/api/bank/connections");
    const data = await readJson<{
      enabled: boolean;
      ready: boolean;
      message?: string;
      connections: BankConnection[];
    }>(response, "Pankkiyhteyksien lataus epäonnistui");
    setEnabled(data.enabled);
    setReady(data.ready);
    setSetupMessage(data.message || "");
    setConnections(data.connections || []);
    setShowPicker((data.connections || []).length === 0);
  }, []);

  const loadBanks = useCallback(async (type: "personal" | "business") => {
    setBanksLoading(true);
    try {
      const response = await apiFetch(`/api/bank/aspsps?country=FI&psuType=${type}`);
      const data = await readJson<{ aspsps?: Aspsp[] }>(
        response,
        "Pankkilistan lataus epäonnistui"
      );
      setAspsps(data.aspsps || []);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setAspsps([]);
      setMessageTone("err");
      setMessage(errorMessage(error, "Pankkilistan lataus epäonnistui"));
    } finally {
      setBanksLoading(false);
    }
  }, []);

  useEffect(() => {
    const showInterrupted = () => {
      if (!consumeInterruptedBankAuth()) return;
      setMessageTone("err");
      setMessage("Yhdistäminen keskeytyi tai pankin istunto vanheni. Voit yrittää uudelleen.");
    };
    showInterrupted();
    window.addEventListener("pageshow", showInterrupted);
    return () => window.removeEventListener("pageshow", showInterrupted);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/bank/connections", { signal: controller.signal })
      .then((response) =>
        readJson<{
          enabled: boolean;
          ready: boolean;
          message?: string;
          connections: BankConnection[];
        }>(response, "Pankkiyhteyksien lataus epäonnistui")
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        setEnabled(data.enabled);
        setReady(data.ready);
        setSetupMessage(data.message || "");
        const rows = data.connections || [];
        setConnections(rows);
        setShowPicker(rows.length === 0);
        if (data.ready && rows.length === 0) void loadBanks(defaultPsu);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadFailed(true);
        setMessageTone("err");
        setMessage(errorMessage(error, "Pankkiyhteyksien lataus epäonnistui"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [defaultPsu, loadBanks]);

  const visibleBanks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("fi");
    if (!needle) return aspsps;
    return aspsps.filter((bank) => bank.name.toLocaleLowerCase("fi").includes(needle));
  }, [aspsps, query]);

  async function connectBank(bank: Aspsp) {
    if (busyId) return;
    setBusyId(bank.name);
    setMessage("");
    try {
      const response = await apiFetch("/api/bank/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aspspName: bank.name,
          aspspCountry: bank.country,
          psuType,
          // Tells the server to prefix the auth state with "app1." so the
          // bank's redirect can be routed back into the app instead of the
          // web callback flow (bank-return.ts, enablebanking/consent.ts).
          ...(IS_MOBILE_BUILD ? { client: "app" as const } : {}),
        }),
      });
      const data = await readJson<{ url: string }>(response, "Yhdistäminen epäonnistui");
      leaveForBank(data.url);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setBusyId(null);
      setMessageTone("err");
      setMessage(errorMessage(error, "Yhdistäminen epäonnistui"));
    }
  }

  async function toggleAccount(connectionId: string, account: BankAccount) {
    const next = !account.inScope;
    setConnections((current) =>
      current.map((connection) =>
        connection.id === connectionId
          ? {
              ...connection,
              accounts: connection.accounts.map((item) =>
                item.id === account.id ? { ...item, inScope: next } : item
              ),
            }
          : connection
      )
    );
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: [{ id: account.id, inScope: next }] }),
      });
      const data = await readJson<{ connection: BankConnection }>(
        response,
        "Tilin valinta epäonnistui"
      );
      setConnections((current) =>
        current.map((connection) =>
          connection.id === data.connection.id ? data.connection : connection
        )
      );
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setConnections((current) =>
        current.map((connection) =>
          connection.id === connectionId
            ? {
                ...connection,
                accounts: connection.accounts.map((item) =>
                  item.id === account.id ? { ...item, inScope: account.inScope } : item
                ),
              }
            : connection
        )
      );
      setMessageTone("err");
      setMessage(errorMessage(error, "Tilin valinta epäonnistui"));
    }
  }

  async function syncConnection(connectionId: string) {
    if (busyId) return;
    setBusyId(connectionId);
    setMessage("Haetaan tapahtumia pankista...");
    setMessageTone("ok");
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}/sync`, {
        method: "POST",
      });
      const data = await readJson<{
        imported: number;
        statementId: string | null;
        accounts?: AccountSyncRow[];
      }>(response, "Synkronointi epäonnistui");
      await loadConnections();
      const accounts = data.accounts || [];
      const outcome = syncOutcomeMessage(accounts, data.imported);
      setSyncAccounts(accounts);
      setStatementHref(data.statementId ? detailHref("statement", data.statementId) : null);
      setMessageTone(outcome.tone);
      setMessage(outcome.text);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setSyncAccounts(null);
      setStatementHref(null);
      setMessageTone("err");
      setMessage(errorMessage(error, "Synkronointi epäonnistui"));
      await loadConnections().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(connectionId: string) {
    setBusyId(connectionId);
    try {
      const response = await apiFetch(`/api/bank/connections/${connectionId}`, {
        method: "DELETE",
      });
      await readJson(response, "Yhteyden katkaisu epäonnistui");
      setConnections((current) => current.filter((connection) => connection.id !== connectionId));
      setShowPicker(true);
      setMessageTone("ok");
      setMessage("Pankkiyhteys katkaistu.");
      setDisconnectId(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(error, "Yhteyden katkaisu epäonnistui");
      setMessageTone("err");
      setMessage(message);
      throw new Error(message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      id="pankkiyhteys"
      className="rounded-card border border-line bg-surface p-4 space-y-6 scroll-mt-20"
    >
      <div>
        <h3 className="text-[15px] font-medium text-ink">Pankkiyhteys</h3>
        <p className="text-[13px] text-ink-2 mt-1 leading-relaxed">
          Yhdistä suomalainen pankkitili. Tapahtumat haetaan tiliotteisiin, ja
          yhteys päivittyy noin kuuden tunnin välein. Tiedoston lataus säilyy.
        </p>
      </div>

      {loading ? (
        <p className="text-[13px] text-ink-2">Ladataan pankkiyhteyttä...</p>
      ) : loadFailed ? (
        <p className="text-sm text-danger leading-relaxed" role="alert">
          {message}
        </p>
      ) : !enabled ? (
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Pankkiyhteys ei ole käytössä tällä palvelimella. Tiedostojen lataus
          toimii normaalisti.
        </p>
      ) : !ready ? (
        <p className="text-sm text-danger leading-relaxed" role="alert">
          {setupMessage || "Pankkiyhteyden asetukset ovat puutteelliset."}
        </p>
      ) : (
        <>
          {connections.map((connection) => {
            const reconnect = consentReconnectCopy(connection);
            const needsReconnect = reconnect !== null;
            const canSync = connection.status === "active";
            const hasScope = connection.accounts.some((account) => account.inScope);
            return (
              <div
                key={connection.id}
                className="rounded-card border border-line p-4 space-y-4"
              >
                <div className="flex items-start gap-3">
                  {connection.aspspLogo ? (
                    // Logos are hosted by Enable Banking, one URL per ASPSP.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={connection.aspspLogo}
                      alt=""
                      className="h-10 w-10 rounded-card object-contain bg-canvas"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium text-ink">{connection.aspspName}</p>
                    <p className="text-[13px] text-ink-2 mt-0.5">
                      {STATUS_LABEL[connection.status] || connection.status}
                      {" · "}
                      {connection.psuType === "business" ? "Yritystili" : "Henkilötili"}
                    </p>
                    <p className="text-[13px] text-ink-2 mt-1">
                      Viimeisin onnistunut haku {formatWhen(connection.lastSuccessAt)}
                    </p>
                  </div>
                </div>

                {reconnect && (
                    <div className="rounded-card bg-accent-soft px-3 py-3 space-y-1" role="status">
                      <p className="text-sm font-medium text-ink">Yhteys pitää yhdistää uudelleen</p>
                      <p className="text-sm text-ink leading-relaxed">Syy: {reconnect.reason}</p>
                      <p className="text-sm text-ink leading-relaxed">
                        Tilit: {reconnect.accounts.length > 0 ? reconnect.accounts.join(", ") : "ei tilejä"}
                      </p>
                      <p className="text-[13px] text-ink-2">
                        Viimeisin onnistunut haku:{" "}
                        {reconnect.lastSuccessAt
                          ? formatWhen(reconnect.lastSuccessAt)
                          : "ei vielä onnistunutta hakua"}
                      </p>
                      {reconnect.lastAttemptAt && (
                        <p className="text-[13px] text-ink-2">
                          Viimeisin yritys: {formatWhen(reconnect.lastAttemptAt)}
                        </p>
                      )}
                    </div>
                  )}

                {connection.lastError && connection.status === "active" && (
                  <p className="text-sm text-danger leading-relaxed" role="alert">
                    {connection.lastError}
                  </p>
                )}

                {connection.accounts.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[13px] text-ink-2 leading-relaxed">
                      Uudet tilit eivät ole mukana automaattisesti. Valitse oman
                      yrityksesi tili, sillä suostumus voi sisältää myös muita
                      IBAN-numeroita.
                    </p>
                    {connection.accounts.map((account) => (
                      <label
                        key={account.id}
                        className="flex items-start gap-3 rounded-card bg-canvas px-3 py-3"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-accent"
                          checked={account.inScope}
                          onChange={() => void toggleAccount(connection.id, account)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink break-all">
                            {account.iban}
                          </span>
                          <span className="block text-[13px] text-ink-2 mt-0.5">
                            {account.label || "Tili"}
                            {account.balance != null ? ` · ${formatEur(account.balance)}` : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-2">
                  {canSync && (
                    <button
                      type="button"
                      onClick={() => void syncConnection(connection.id)}
                      disabled={busyId !== null || !hasScope}
                      className="active-press flex-1 min-h-12 px-4 rounded-card bg-ink text-canvas text-[15px] font-semibold disabled:opacity-50"
                    >
                      {busyId === connection.id ? "Haetaan..." : "Synkronoi nyt"}
                    </button>
                  )}
                  {needsReconnect && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = connection.psuType === "personal" ? "personal" : "business";
                        setPsuType(next);
                        setShowPicker(true);
                        void loadBanks(next);
                      }}
                      className="active-press flex-1 min-h-12 px-4 rounded-card bg-ink text-canvas text-[15px] font-semibold"
                    >
                      Yhdistä uudelleen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDisconnectId(connection.id)}
                    disabled={busyId !== null}
                    className="active-press min-h-12 px-4 rounded-card border border-danger/30 text-[15px] font-semibold text-danger disabled:opacity-50"
                  >
                    Katkaise
                  </button>
                </div>
                {canSync && !hasScope && (
                  <p className="text-[13px] text-ink-2">Valitse ainakin yksi tili ennen hakua.</p>
                )}
              </div>
            );
          })}

          {connections.length > 0 && !showPicker ? (
            <button
              type="button"
              onClick={() => {
                setShowPicker(true);
                void loadBanks(psuType);
              }}
              className="active-press w-full min-h-12 rounded-card border border-line text-[15px] font-semibold text-ink"
            >
              Yhdistä toinen pankki
            </button>
          ) : (
            <div className="space-y-4">
              {connections.length > 0 && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowPicker(false)}
                    className="active-press text-[13px] font-medium text-accent"
                  >
                    Peruuta
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPsuType("business");
                      void loadBanks("business");
                    }}
                  aria-pressed={psuType === "business"}
                  className={`active-press min-h-11 rounded-card text-sm font-medium ${
                    psuType === "business"
                      ? "bg-ink text-canvas"
                      : "bg-surface text-ink border border-line"
                  }`}
                >
                  Yritystili
                </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPsuType("personal");
                      void loadBanks("personal");
                    }}
                  aria-pressed={psuType === "personal"}
                  className={`active-press min-h-11 rounded-card text-sm font-medium ${
                    psuType === "personal"
                      ? "bg-ink text-canvas"
                      : "bg-surface text-ink border border-line"
                  }`}
                >
                  Henkilötili
                </button>
              </div>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Hae pankkia"
                aria-label="Hae pankkia"
                className="w-full min-h-12 px-3 rounded-card border border-line bg-surface text-[16px] text-ink"
              />
              {banksLoading ? (
                <p className="text-[13px] text-ink-2">Ladataan pankkeja...</p>
              ) : visibleBanks.length === 0 ? (
                <p className="text-[13px] text-ink-2">Pankkeja ei löytynyt.</p>
              ) : (
                <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {visibleBanks.map((bank) => (
                    <li key={`${bank.country}-${bank.name}`}>
                      <button
                        type="button"
                        onClick={() => void connectBank(bank)}
                        disabled={busyId !== null}
                        className="active-press w-full flex items-center gap-3 rounded-card border border-line px-3 py-3 text-left disabled:opacity-50"
                      >
                        {bank.logo ? (
                          // Logos are hosted by Enable Banking, one URL per ASPSP.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={bank.logo}
                            alt=""
                            className="h-8 w-8 rounded-card object-contain bg-surface"
                          />
                        ) : (
                          <span className="h-8 w-8 rounded-card bg-accent-soft" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-ink truncate">
                            {bank.name}
                          </span>
                          {bank.beta && (
                            <span className="block text-[11px] text-ink-2">Beta</span>
                          )}
                        </span>
                        <span className="text-xs font-medium text-accent">Yhdistä</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {message && !loadFailed && (
        <div className="space-y-2" role={messageTone === "err" ? "alert" : "status"}>
          <p className={`text-sm leading-relaxed ${messageTone === "err" ? "text-danger" : "text-success"}`}>
            {message}
          </p>
          {syncAccounts && syncAccounts.length > 0 && (
            <ul className="space-y-1">
              {syncAccounts.map((account) => (
                <li key={account.accountId} className="text-sm text-ink leading-relaxed">
                  {account.name}:{" "}
                  {account.ok
                    ? account.imported > 0
                      ? `${account.imported} uutta tapahtumaa`
                      : "ei uusia tapahtumia"
                    : `epäonnistui - ${account.error || "Tapahtumien haku epäonnistui."}`}
                </li>
              ))}
            </ul>
          )}
          {statementHref && (
            <Link href={statementHref} className="inline-flex text-sm font-medium text-accent">
              Avaa tiliote
            </Link>
          )}
        </div>
      )}

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
