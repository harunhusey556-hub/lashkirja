"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BankConnectCard from "@/components/BankConnectCard";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatEur } from "@/lib/format";
import { bankHomeLead } from "@/lib/bank-home";
import { useProfile } from "../asetukset/useProfile";

interface LiveAccount {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  inScope: boolean;
  balance: number | null;
}

interface LiveConnection {
  id: string;
  aspspName: string;
  status: string;
  lastSuccessAt: string | null;
  accounts: LiveAccount[];
}

function formatWhen(value: string | null): string {
  if (!value) return "ei vielä";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ei vielä";
  return date.toLocaleString("fi-FI", { dateStyle: "short", timeStyle: "short" });
}

export default function PankkiPage() {
  const router = useRouter();
  const { profile, loadError, retry } = useProfile();
  const [connections, setConnections] = useState<LiveConnection[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<unknown>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState("");
  const [manage, setManage] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/bank/connections");
      const data = await readJson<{ connections?: LiveConnection[] }>(
        response,
        "Pankkiyhteyksien lataus epäonnistui"
      );
      setConnections(data.connections ?? []);
      setLoadFailed(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailed(error);
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncAll() {
    if (syncing || !connections) return;
    const targets = connections.filter(
      (connection) => connection.status === "active" && connection.accounts.some((account) => account.inScope)
    );
    if (targets.length === 0) {
      setNote("Valitse ensin tili, joka synkronoidaan.");
      setManage(true);
      return;
    }
    setSyncing(true);
    setNote("Haetaan tapahtumia pankista...");
    try {
      let imported = 0;
      let statementId: string | null = null;
      for (const connection of targets) {
        const response = await apiFetch(`/api/bank/connections/${connection.id}/sync`, { method: "POST" });
        const data = await readJson<{ imported: number; statementId: string | null }>(
          response,
          "Pankin haku epäonnistui"
        );
        imported += data.imported;
        if (data.statementId) statementId = data.statementId;
      }
      await load();
      if (statementId && imported > 0) {
        router.push(`/tiliotteet/${statementId}`);
        return;
      }
      setNote(imported > 0 ? `${imported} uutta tapahtumaa` : "Ei uusia tapahtumia");
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setNote(errorMessage(error, "Pankin haku epäonnistui"));
    } finally {
      setSyncing(false);
    }
  }

  const lead = bankHomeLead(connections?.length ?? 0);
  const inScope = (connections ?? []).flatMap((connection) =>
    connection.accounts
      .filter((account) => account.inScope)
      .map((account) => ({ ...account, bank: connection.aspspName, synced: connection.lastSuccessAt }))
  );

  return (
    <div className="space-y-6 pb-6">
      <header className="space-y-1">
        <p className="text-sm text-warm-gray leading-relaxed">
          {lead === "accounts"
            ? "Yhdistetyn pankin tilit ja tapahtumat."
            : "Yhdistä pankki, niin tapahtumat tulevat tänne."}
        </p>
      </header>

      {connections === null && <LoadingState label="Haetaan pankkiyhteyttä…" />}
      {loadFailed != null && connections?.length === 0 && (
        <ConnectionNotice
          error={loadFailed}
          fallback="Pankkiyhteyden haku epäonnistui"
          onRetry={() => void load()}
        />
      )}

      {lead === "accounts" && (
        <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
          {inScope.length === 0 ? (
            <p className="text-sm text-warm-gray">
              Pankki on yhdistetty. Valitse tilit, jotka haetaan mukaan.
            </p>
          ) : (
            <ul className="space-y-3">
              {inScope.map((account) => (
                <li key={account.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-charcoal">
                      {account.label || account.bank}
                    </span>
                    <span className="block text-xs text-warm-gray mt-0.5 break-all">{account.iban}</span>
                    <span className="block text-xs text-warm-gray mt-0.5">
                      Haettu {formatWhen(account.synced)}
                    </span>
                  </span>
                  <span className="text-sm font-medium text-charcoal shrink-0">
                    {account.balance == null ? "–" : formatEur(account.balance)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => void syncAll()}
            disabled={syncing}
            className="w-full min-h-12 rounded-2xl bg-charcoal text-sm font-medium text-white active-press disabled:opacity-50"
          >
            {syncing ? "Haetaan…" : "Hae tapahtumat"}
          </button>
          {note && (
            <p className="text-sm text-warm-gray" role="status">
              {note}
            </p>
          )}
          <button
            type="button"
            onClick={() =>
              setManage((current) => {
                if (current) void load();
                return !current;
              })
            }
            className="text-sm font-medium text-accent-dark min-h-11"
          >
            {manage ? "Sulje yhteyden hallinta" : "Hallitse yhteyttä"}
          </button>
        </section>
      )}

      {(lead === "connect" || manage) && loadFailed == null && (
        loadError ? (
          <ConnectionNotice error={new Error(loadError)} fallback={loadError} onRetry={retry} />
        ) : profile ? (
          <BankConnectCard entityType={profile.entityType} />
        ) : (
          <div className="bg-white rounded-2xl p-6 shadow-sm">
            <div className="h-24 rounded-xl bg-warm-gray-light/20 skeleton" />
          </div>
        )
      )}

      <nav className="flex flex-col gap-2" aria-label="Lisää pankista">
        <Link href="/pankkitilit" className="text-sm text-warm-gray underline-offset-2 hover:underline min-h-11 inline-flex items-center">
          Kirjanpidon tilit
        </Link>
        <Link href="/tiliotteet" className="text-sm text-warm-gray underline-offset-2 hover:underline min-h-11 inline-flex items-center">
          Tuo tiliote tiedostona
        </Link>
      </nav>
    </div>
  );
}
