"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

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
  const [disconnectId, setDisconnectId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/bank/connections");
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
      const response = await fetch(`/api/bank/aspsps?country=FI&psuType=${type}`);
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
    const controller = new AbortController();
    fetch("/api/bank/connections", { signal: controller.signal })
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
      const response = await fetch("/api/bank/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aspspName: bank.name,
          aspspCountry: bank.country,
          psuType,
        }),
      });
      const data = await readJson<{ url: string }>(response, "Yhdistäminen epäonnistui");
      window.location.assign(data.url);
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
      const response = await fetch(`/api/bank/connections/${connectionId}`, {
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
      const response = await fetch(`/api/bank/connections/${connectionId}/sync`, {
        method: "POST",
      });
      const data = await readJson<{ imported: number; statementId: string | null }>(
        response,
        "Synkronointi epäonnistui"
      );
      await loadConnections();
      setMessageTone("ok");
      setMessage(
        data.imported > 0
          ? `Haettiin ${data.imported} uutta tapahtumaa.`
          : "Ei uusia tapahtumia."
      );
      if (data.statementId && data.imported > 0) {
        window.location.assign(`/tiliotteet/${data.statementId}`);
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
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
      const response = await fetch(`/api/bank/connections/${connectionId}`, {
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
      className="bg-white rounded-2xl p-6 shadow-sm space-y-6 scroll-mt-20"
    >
      <div>
        <h3 className="text-lg font-medium text-charcoal">Pankkiyhteys</h3>
        <p className="text-sm text-warm-gray mt-1 leading-relaxed">
          Yhdistä suomalainen pankkitili. Tapahtumat haetaan tiliotteisiin, ja
          yhteys päivittyy noin kuuden tunnin välein. Tiedoston lataus säilyy.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-warm-gray">Ladataan pankkiyhteyttä...</p>
      ) : loadFailed ? (
        <p className="text-sm text-danger leading-relaxed" role="alert">
          {message}
        </p>
      ) : !enabled ? (
        <p className="text-sm text-warm-gray leading-relaxed">
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
            const needsReconnect =
              connection.status === "expired" ||
              connection.status === "error" ||
              connection.status === "revoked";
            const canSync = connection.status === "active";
            const hasScope = connection.accounts.some((account) => account.inScope);
            return (
              <div
                key={connection.id}
                className="rounded-xl border border-warm-gray-light p-4 space-y-4"
              >
                <div className="flex items-start gap-3">
                  {connection.aspspLogo ? (
                    // Logos are hosted by Enable Banking, one URL per ASPSP.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={connection.aspspLogo}
                      alt=""
                      className="h-10 w-10 rounded-lg object-contain bg-cream"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-charcoal">{connection.aspspName}</p>
                    <p className="text-xs text-warm-gray mt-0.5">
                      {STATUS_LABEL[connection.status] || connection.status}
                      {" · "}
                      {connection.psuType === "business" ? "Yritystili" : "Henkilötili"}
                    </p>
                    <p className="text-xs text-warm-gray mt-1">
                      Viimeksi haettu {formatWhen(connection.lastSuccessAt || connection.lastSyncAt)}
                    </p>
                  </div>
                </div>

                {connection.lastError && (
                  <p className="text-sm text-danger leading-relaxed" role="alert">
                    {connection.lastError}
                  </p>
                )}

                {connection.accounts.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-warm-gray leading-relaxed">
                      Uudet tilit eivät ole mukana automaattisesti. Valitse oman
                      yrityksesi tili — suostumus voi sisältää myös muita
                      IBAN-numeroita.
                    </p>
                    {connection.accounts.map((account) => (
                      <label
                        key={account.id}
                        className="flex items-start gap-3 rounded-xl bg-cream/60 px-3 py-3"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-accent"
                          checked={account.inScope}
                          onChange={() => void toggleAccount(connection.id, account)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-charcoal break-all">
                            {account.iban}
                          </span>
                          <span className="block text-xs text-warm-gray mt-0.5">
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
                      className="flex-1 px-4 py-2.5 rounded-xl bg-charcoal text-white text-sm font-medium hover:bg-black disabled:opacity-50"
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
                      className="flex-1 px-4 py-2.5 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark"
                    >
                      Yhdistä uudelleen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDisconnectId(connection.id)}
                    disabled={busyId !== null}
                    className="px-4 py-2.5 rounded-xl border border-warm-gray-light text-sm font-medium text-danger hover:bg-cream disabled:opacity-50"
                  >
                    Katkaise
                  </button>
                </div>
                {canSync && !hasScope && (
                  <p className="text-xs text-warm-gray">Valitse ainakin yksi tili ennen hakua.</p>
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
              className="w-full py-3 rounded-xl border border-dashed border-warm-gray-light text-sm font-medium text-charcoal hover:bg-cream"
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
                    className="text-xs font-medium text-warm-gray hover:text-charcoal"
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
                  className={`py-2.5 rounded-xl text-sm font-medium ${
                    psuType === "business"
                      ? "bg-accent text-white"
                      : "bg-cream text-charcoal border border-warm-gray-light"
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
                  className={`py-2.5 rounded-xl text-sm font-medium ${
                    psuType === "personal"
                      ? "bg-accent text-white"
                      : "bg-cream text-charcoal border border-warm-gray-light"
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
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
              />
              {banksLoading ? (
                <p className="text-sm text-warm-gray">Ladataan pankkeja...</p>
              ) : visibleBanks.length === 0 ? (
                <p className="text-sm text-warm-gray">Pankkeja ei löytynyt.</p>
              ) : (
                <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {visibleBanks.map((bank) => (
                    <li key={`${bank.country}-${bank.name}`}>
                      <button
                        type="button"
                        onClick={() => void connectBank(bank)}
                        disabled={busyId !== null}
                        className="w-full flex items-center gap-3 rounded-xl border border-warm-gray-light px-3 py-3 text-left hover:border-accent hover:bg-cream disabled:opacity-50"
                      >
                        {bank.logo ? (
                          // Logos are hosted by Enable Banking, one URL per ASPSP.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={bank.logo}
                            alt=""
                            className="h-8 w-8 rounded-md object-contain bg-white"
                          />
                        ) : (
                          <span className="h-8 w-8 rounded-md bg-blush" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-charcoal truncate">
                            {bank.name}
                          </span>
                          {bank.beta && (
                            <span className="block text-[11px] text-warm-gray">Beta</span>
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
        <p
          className={`text-sm leading-relaxed ${messageTone === "err" ? "text-danger" : "text-success"}`}
          role={messageTone === "err" ? "alert" : "status"}
        >
          {message}
        </p>
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
