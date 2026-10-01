"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoadingState } from "@/components/AsyncState";
import { PageHeader } from "@/components/PageHeader";
import { ConnectionNotice } from "@/components/ScreenState";
import { SectionTabs } from "@/components/SectionTabs";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatEur, formatMonth } from "@/lib/format";
import { bankHomeLead } from "@/lib/bank-home";
import { activeBankTab, bankTabs } from "@/lib/navigation";

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

interface RecentStatement {
  id: string;
  fileName: string;
  periodMonth: string | null;
}

function formatWhen(value: string | null): string {
  if (!value) return "ei vielä";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ei vielä";
  return date.toLocaleString("fi-FI", { dateStyle: "short", timeStyle: "short" });
}

export default function PankkiPage() {
  const router = useRouter();
  const [connections, setConnections] = useState<LiveConnection[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<unknown>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState("");
  const [unmatched, setUnmatched] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentStatement[]>([]);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/matching/unmatched")
      .then((response) =>
        readJson<{ unmatchedTx?: Array<{ matchStatus?: string }> }>(response, "")
      )
      .then((data) => {
        if (cancelled) return;
        const rows = data.unmatchedTx ?? [];
        setUnmatched(rows.filter((row) => row.matchStatus !== "suggested").length);
        setPending(rows.filter((row) => row.matchStatus === "suggested").length);
      })
      .catch(() => {
        if (!cancelled) {
          setUnmatched(null);
          setPending(null);
        }
      });
    apiFetch("/api/statements")
      .then((response) => readJson<{ statements?: RecentStatement[] }>(response, ""))
      .then((data) => {
        if (!cancelled) setRecent((data.statements ?? []).slice(0, 3));
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function syncAll() {
    if (syncing || !connections) return;
    const targets = connections.filter(
      (connection) => connection.status === "active" && connection.accounts.some((account) => account.inScope)
    );
    if (targets.length === 0) {
      setNote("Valitse synkronoitavat tilit pankkiyhteyden asetuksista.");
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
        router.push(`/pankki/tapahtumat/${statementId}`);
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
      .map((account) => ({ ...account, bank: connection.aspspName, synced: connection.lastSuccessAt, status: connection.status }))
  );
  const needsAttention = (connections ?? []).some((connection) => connection.status !== "active");

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        crumbs={[{ label: "Pankki" }]}
        description="Saldot, avoimet täsmäytykset ja viimeisimmät tapahtumat."
      />
      <SectionTabs items={bankTabs()} activeHref={activeBankTab("/pankki")} />

      {connections === null && <LoadingState label="Haetaan pankkiyhteyttä…" />}
      {loadFailed != null && connections?.length === 0 && (
        <ConnectionNotice
          error={loadFailed}
          fallback="Pankkiyhteyden haku epäonnistui"
          onRetry={() => void load()}
        />
      )}

      {connections !== null && loadFailed == null && lead === "connect" && (
        <section className="space-y-3 rounded-3xl border border-warm-gray-light/20 bg-white p-6 shadow-sm">
          <p className="text-base font-medium text-charcoal">Pankkia ei ole vielä yhdistetty</p>
          <p className="text-sm leading-relaxed text-warm-gray">
            Yhdistä pankki asetuksista. Tilit, tapahtumat ja täsmäytys tulevat sen jälkeen tähän.
          </p>
          <Link
            href="/asetukset/pankkiyhteys"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-charcoal px-4 text-sm font-medium text-white active-press"
          >
            Yhdistä pankki
          </Link>
        </section>
      )}

      {lead === "accounts" && (
        <section className="space-y-4 rounded-3xl border border-warm-gray-light/20 bg-white p-6 shadow-sm">
          {inScope.length === 0 ? (
            <p className="text-sm text-warm-gray">
              Pankki on yhdistetty. Valitse haettavat tilit asetuksista.
            </p>
          ) : (
            <ul className="space-y-3">
              {inScope.map((account) => (
                <li key={account.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-charcoal">
                      {account.label || account.bank}
                    </span>
                    <span className="mt-0.5 block break-all text-xs text-warm-gray">{account.iban}</span>
                    <span className="mt-0.5 block text-xs text-warm-gray">
                      Haettu {formatWhen(account.synced)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-charcoal">
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
            className="min-h-12 w-full rounded-2xl bg-charcoal text-sm font-medium text-white active-press disabled:opacity-50"
          >
            {syncing ? "Haetaan…" : "Hae tapahtumat"}
          </button>
          {note && (
            <p className="text-sm text-warm-gray" role="status">
              {note}
            </p>
          )}
          {(needsAttention || inScope.length === 0) && (
            <Link href="/asetukset/pankkiyhteys" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-dark">
              Yhteys vaatii huomiota
            </Link>
          )}
        </section>
      )}

      <section className="grid grid-cols-2 gap-3">
        <Link href="/pankki/taydennys" className="warm-row surface p-4 active-press">
          <p className="text-xs text-warm-gray">Täsmäyttämättä</p>
          <p className={`mt-1 text-xl font-semibold tabular-nums ${unmatched ? "text-warning" : "text-charcoal"}`}>
            {unmatched ?? "–"}
          </p>
        </Link>
        <Link href="/pankki/taydennys" className="warm-row surface p-4 active-press">
          <p className="text-xs text-warm-gray">Tarkistettavana</p>
          <p className={`mt-1 text-xl font-semibold tabular-nums ${pending ? "text-accent-dark" : "text-charcoal"}`}>
            {pending ?? "–"}
          </p>
        </Link>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-medium text-charcoal">Viimeisimmät</p>
        {recent.length === 0 ? (
          <p className="text-sm text-warm-gray">Ei vielä tapahtumia.</p>
        ) : (
          <ul className="space-y-2">
            {recent.map((statement) => (
              <li key={statement.id}>
                <Link
                  href={`/pankki/tapahtumat/${statement.id}`}
                  className="block rounded-2xl bg-white px-4 py-3 shadow-sm active-press"
                >
                  <span className="block text-sm font-medium text-charcoal">{statement.fileName}</span>
                  <span className="block text-xs text-warm-gray">
                    {statement.periodMonth ? formatMonth(statement.periodMonth) : "Tiliote"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
