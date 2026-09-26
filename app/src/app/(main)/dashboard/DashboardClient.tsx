"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

interface DashboardData {
  firstName: string;
  month: string;
  income: number;
  expenses: number;
  source: "tiliote" | "kuitit";
  txCount: number;
  receiptCount: number;
  estimatedVat: number;
  isRefund: boolean;
  matching: { matchable: number; matched: number; suggested: number };
  vat: {
    registered: boolean;
    entityType: string;
    ytdRevenue: number;
    threshold: number;
  };
  hasImap: boolean;
  pendingReceiptsCount?: number;
}

function getGreeting(firstName: string): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return `Huomenta, ${firstName}!`;
  if (hour >= 10 && hour < 17) return `Hyvää päivää, ${firstName}!`;
  if (hour >= 17 && hour < 23) return `Hyvää iltaa, ${firstName}!`;
  return `Hyvää yötä, ${firstName}!`;
}

const MONTH_NAMES = [
  "tammikuu",
  "helmikuu",
  "maaliskuu",
  "huhtikuu",
  "toukokuu",
  "kesäkuu",
  "heinäkuu",
  "elokuu",
  "syyskuu",
  "lokakuu",
  "marraskuu",
  "joulukuu",
];

function formatEur(n: number): string {
  return (
    n.toLocaleString("fi-FI", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " €"
  );
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function DashboardClient({
  firstName,
}: {
  firstName: string;
}) {
  const [result, setResult] = useState<{
    month: string;
    data: DashboardData;
  } | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Poll for updates every 30 seconds to catch background cron job changes
  useEffect(() => {
    const interval = setInterval(() => {
      setLoadAttempt((a) => a + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/dashboard?month=${month}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) =>
        readJson<DashboardData>(response, "Etusivun tietojen lataus epäonnistui")
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (
          !Number.isFinite(data.income) ||
          !Number.isFinite(data.expenses) ||
          !data.vat
        ) {
          throw new Error("Palvelin palautti virheelliset etusivun tiedot");
        }
        setLoadError("");
        setResult({ month, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(
          errorMessage(error, "Etusivun tietojen lataus epäonnistui")
        );
      });
    return () => controller.abort();
  }, [month, loadAttempt]);

  const data = result?.month === month ? result.data : null;
  const displayName = data?.firstName || firstName;

  const monthIdx = parseInt(month.split("-")[1]) - 1;
  const monthName = MONTH_NAMES[monthIdx] || "";

  return (
    <div className="space-y-5">
      {data && data.pendingReceiptsCount !== undefined && data.pendingReceiptsCount > 0 && (
        <Link
          href="/kuitit"
          className="pressable flex items-center justify-between gap-3 rounded-2xl border border-warning/30 bg-white px-4 py-3.5 shadow-sm animate-in"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-warning/15 text-warning">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden>
                <path d="M5.85 3.5a.75.75 0 0 0-1.117-1 9.719 9.719 0 0 0-2.348 4.876.75.75 0 0 0 1.479.248A8.219 8.219 0 0 1 5.85 3.5ZM19.267 2.5a.75.75 0 1 0-1.118 1 8.22 8.22 0 0 1 1.987 4.124.75.75 0 0 0 1.48-.248A9.72 9.72 0 0 0 19.266 2.5Z" />
                <path fillRule="evenodd" d="M12 2.25A6.75 6.75 0 0 0 5.25 9v.75a8.217 8.217 0 0 1-2.119 5.52.75.75 0 0 0 .298 1.206c1.544.57 3.16.99 4.831 1.243a3.75 3.75 0 1 0 7.48 0 24.583 24.583 0 0 0 4.83-1.244.75.75 0 0 0 .298-1.205 8.217 8.217 0 0 1-2.118-5.52V9A6.75 6.75 0 0 0 12 2.25ZM9.75 18c0-.034 0-.067.002-.1a25.05 25.05 0 0 0 4.496 0l.002.1a2.25 2.25 0 1 1-4.5 0Z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-charcoal">Tarkastusta odottavia kuitteja</h2>
              <p className="mt-0.5 text-xs leading-snug text-charcoal/70">
                Sinulla on {data.pendingReceiptsCount} uutta sähköpostikuittia.
              </p>
            </div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-warning" aria-hidden>
            <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
          </svg>
        </Link>
      )}

      <header className="space-y-4 animate-in">
        <div>
          <h2 className="text-3xl font-light tracking-tight text-charcoal">
            {displayName ? getGreeting(displayName) : "\u00a0"}
          </h2>
          <p className="mt-1 text-sm text-warm-gray">Tervetuloa Lashkirjaan</p>
        </div>

        <div
          className="flex items-center gap-1 rounded-2xl border border-warm-gray-light/40 bg-white p-1 shadow-sm"
          role="group"
          aria-label="Kuukausi"
        >
          <button
            type="button"
            onClick={() => { setLoadError(""); setMonth(shiftMonth(month, -1)); }}
            className="pressable flex h-12 w-12 items-center justify-center rounded-xl text-charcoal"
            aria-label="Edellinen kuukausi"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <p className="min-w-0 flex-1 text-center text-[15px] font-medium capitalize text-charcoal">
            {monthName} {month.split("-")[0]}
          </p>
          <button
            type="button"
            onClick={() => { setLoadError(""); setMonth(shiftMonth(month, 1)); }}
            disabled={month >= currentMonth()}
            className="pressable flex h-12 w-12 items-center justify-center rounded-xl text-charcoal disabled:opacity-30"
            aria-label="Seuraava kuukausi"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </header>

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((a) => a + 1); }} />
      ) : !data ? (
        <div className="space-y-3" aria-hidden>
          <div className="grid grid-cols-2 gap-3">
            <div className="h-28 animate-pulse rounded-3xl bg-warm-gray-light/30 motion-reduce:animate-none" />
            <div className="h-28 animate-pulse rounded-3xl bg-warm-gray-light/30 motion-reduce:animate-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="h-24 animate-pulse rounded-3xl bg-warm-gray-light/30 motion-reduce:animate-none" />
            <div className="h-24 animate-pulse rounded-3xl bg-warm-gray-light/30 motion-reduce:animate-none" />
          </div>
        </div>
      ) : (
        <div key={month} className="space-y-4 animate-in">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-3xl border border-warm-gray-light/30 bg-white p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-warm-gray">Tulot</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-success">{formatEur(data.income)}</p>
            </div>
            <div className="rounded-3xl border border-warm-gray-light/30 bg-white p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-warm-gray">Menot</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-accent">{formatEur(data.expenses)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between gap-2 rounded-3xl border border-warm-gray-light/30 bg-white p-5 shadow-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-warm-gray">Kuitteja</p>
                <p className="mt-2 text-xl font-semibold text-charcoal">{data.receiptCount}</p>
              </div>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blush text-accent">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              </div>
            </div>

            <div className="rounded-3xl border border-warm-gray-light/30 bg-white p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-warm-gray">ALV Arvio</p>
              <p className={`mt-2 text-xl font-semibold tracking-tight ${data.isRefund ? "text-success" : "text-accent"}`}>
                {data.isRefund ? "−" : ""}{formatEur(Math.abs(data.estimatedVat))}
              </p>
              <p className="mt-1 text-xs uppercase tracking-wide text-warm-gray">
                {data.isRefund ? "palautettava" : "maksettava"}
              </p>
            </div>
          </div>

          <div className="flex items-start justify-center gap-2 px-2">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${data.hasImap ? "bg-success" : "bg-warm-gray-light"}`} />
            <p className="text-center text-xs leading-relaxed text-warm-gray">
              {data.source === "tiliote"
                ? `Tiliotteen perusteella (${data.txCount} tapahtumaa)`
                : "Kuitteihin perustuva näkymä — lataa tiliote"}
              {data.hasImap && " · Automaattinen tuonti aktiivinen"}
            </p>
          </div>

          {data.matching && data.matching.matchable > 0 && (
            <p className="text-center text-xs leading-relaxed text-warm-gray">
              Kuitteja linkitetty {data.matching.matched}/{data.matching.matchable} pankkitapahtumaan.
            </p>
          )}

          {!data.vat.registered && data.vat.ytdRevenue >= data.vat.threshold * 0.75 && (
            <div className={`rounded-2xl p-4 text-sm ${data.vat.ytdRevenue >= data.vat.threshold ? "border border-danger/20 bg-danger/10 text-danger" : "border border-warning/20 bg-warning/10 text-charcoal"}`}>
              <p className="font-semibold">{data.vat.ytdRevenue >= data.vat.threshold ? "ALV-raja ylittynyt" : "ALV-raja lähestyy"}</p>
              <p className="mt-1 leading-relaxed">
                Liikevaihtosi tänä vuonna on {formatEur(data.vat.ytdRevenue)}. Raja on {formatEur(data.vat.threshold)}.
                {data.vat.ytdRevenue >= data.vat.threshold ? " Rekisteröidy OmaVerossa heti." : " Rekisteröidy hyvissä ajoin."}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 animate-in-delay-2">
        <Link
          href="/kuitit/uusi"
          className="pressable flex min-h-24 flex-col items-center justify-center gap-2 rounded-3xl bg-charcoal px-3 py-4 text-white"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </span>
          <span className="text-sm font-medium">Uusi kuitti</span>
        </Link>

        <Link
          href="/tiliotteet"
          className="pressable flex min-h-24 flex-col items-center justify-center gap-2 rounded-3xl border border-warm-gray-light/50 bg-white px-3 py-4 text-charcoal"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-blush text-accent">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          </span>
          <span className="text-sm font-medium">Tiliote</span>
        </Link>
      </div>
    </div>
  );
}
