"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/AsyncState";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

import { formatEur } from "@/lib/format";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
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
  isSingleVatProfile?: boolean;
  singleVatRate?: number;
  sectionErrors?: Partial<
    Record<"matching" | "vat" | "pending" | "threshold" | "position" | "receipts", string>
  >;
}

function getGreeting(firstName: string): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return `Hyvää huomenta, ${firstName}!`;
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
  const [refreshFailed, setRefreshFailed] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Poll for updates every 30 seconds to catch background cron job changes
  useEffect(() => {
    const interval = setInterval(() => {
      setLoadAttempt((a) => a + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/dashboard?month=${month}`, { credentials: "include" })
      .then((response) =>
        readJson<DashboardData>(response, "Etusivun tietojen lataus epäonnistui")
      )
      .then((data) => {
        if (cancelled) return;
        if (
          !Number.isFinite(data.income) ||
          !Number.isFinite(data.expenses) ||
          !data.vat
        ) {
          throw new Error("Palvelin palautti virheelliset etusivun tiedot");
        }
        setRefreshFailed(null);
        writePageCache(`dashboard:${month}`, data);
        setResult({ month, data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setRefreshFailed(error);
      });
    return () => {
      cancelled = true;
    };
  }, [month, loadAttempt]);

  // Cached copy (warmed post-login or left by an earlier visit) paints in the
  // first frame; the fetch above replaces it silently when it lands.
  const data =
    result?.month === month
      ? result.data
      : readPageCache<DashboardData>(`dashboard:${month}`);
  const displayName = data?.firstName || firstName;

  const monthIdx = parseInt(month.split("-")[1]) - 1;
  const monthName = MONTH_NAMES[monthIdx] || "";

  return (
    <>
      <div className="space-y-6 pb-20">
        
        {/* Dynamic Action Banner for Pending Receipts */}
        {data?.sectionErrors?.pending ? (
          <ErrorState
            compact
            message={data.sectionErrors.pending}
            onRetry={() => setLoadAttempt((a) => a + 1)}
          />
        ) : data && data.pendingReceiptsCount !== undefined && data.pendingReceiptsCount > 0 && (
          <Link href="/kuitit" className="block relative overflow-hidden group animate-in">
            <div className="absolute inset-0 bg-gradient-to-r from-warning/20 to-warning-dark/20 animate-pulse motion-reduce:animate-none rounded-2xl" />
            <div className="relative bg-white/80 backdrop-blur-md border border-warning/40 rounded-2xl p-4 shadow-[0_4px_20px_-4px_rgba(138,105,30,0.3)] flex items-center justify-between transition-all group-hover:shadow-[0_4px_25px_-4px_rgba(138,105,30,0.5)] group-hover:bg-white">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center text-warning-dark">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                    <path d="M5.85 3.5a.75.75 0 0 0-1.117-1 9.719 9.719 0 0 0-2.348 4.876.75.75 0 0 0 1.479.248A8.219 8.219 0 0 1 5.85 3.5ZM19.267 2.5a.75.75 0 1 0-1.118 1 8.22 8.22 0 0 1 1.987 4.124.75.75 0 0 0 1.48-.248A9.72 9.72 0 0 0 19.266 2.5Z" />
                    <path fillRule="evenodd" d="M12 2.25A6.75 6.75 0 0 0 5.25 9v.75a8.217 8.217 0 0 1-2.119 5.52.75.75 0 0 0 .298 1.206c1.544.57 3.16.99 4.831 1.243a3.75 3.75 0 1 0 7.48 0 24.583 24.583 0 0 0 4.83-1.244.75.75 0 0 0 .298-1.205 8.217 8.217 0 0 1-2.118-5.52V9A6.75 6.75 0 0 0 12 2.25ZM9.75 18c0-.034 0-.067.002-.1a25.05 25.05 0 0 0 4.496 0l.002.1a2.25 2.25 0 1 1-4.5 0Z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-charcoal">Tarkastusta odottavia kuitteja</h3>
                  <p className="text-xs text-charcoal/70">
                    {data.isSingleVatProfile 
                      ? `Kaikki myyntisi ovat ALV ${data.singleVatRate}% — tarkista ja hyväksy yhdellä napautuksella.`
                      : `Sinulla on ${data.pendingReceiptsCount} tarkastamatonta kuittia/luonnosta.`
                    }
                  </p>
                </div>
              </div>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-warning-dark transform group-hover:translate-x-1 transition-transform">
                <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
              </svg>
            </div>
          </Link>
        )}

        {/* Stacks on phones: the greeting and the month picker fought for room
            and wrapped to three lines at 320px. Side by side from sm up. */}
        <div className="flex flex-col gap-3 animate-in sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl sm:text-3xl font-light text-charcoal tracking-tight">
              {displayName ? getGreeting(displayName) : "\u00a0"}
            </h2>
            <p className="text-sm text-warm-gray mt-1">Tervetuloa Lashkirjaan</p>
          </div>

          <div className="flex items-center gap-1 self-start shrink-0 sm:self-auto bg-white p-1 rounded-xl shadow-sm border border-warm-gray-light/20">
            <button
              type="button"
              aria-label="Edellinen kuukausi"
              onClick={() => { setRefreshFailed(null); setMonth(shiftMonth(month, -1)); }}
              className="touch-target flex items-center justify-center rounded-lg text-charcoal hover:bg-blush/40 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
            </button>
            <p className="text-sm font-medium text-charcoal min-w-[100px] text-center capitalize whitespace-nowrap">
              {monthName} {month.split("-")[0]}
            </p>
            <button
              type="button"
              aria-label="Seuraava kuukausi"
              onClick={() => { setRefreshFailed(null); setMonth(shiftMonth(month, 1)); }}
              disabled={month >= currentMonth()}
              className="touch-target flex items-center justify-center rounded-lg text-charcoal hover:bg-blush/40 transition-colors disabled:opacity-30"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
            </button>
          </div>
        </div>

        {refreshFailed && data ? (
          <StaleBanner
            fetchedAt={pageCacheFetchedAt(`dashboard:${month}`)}
            onRetry={() => setLoadAttempt((a) => a + 1)}
          />
        ) : null}
        {refreshFailed && !data ? (
          <ConnectionNotice
            error={refreshFailed}
            fallback={errorMessage(refreshFailed, "Etusivun tietojen lataus epäonnistui")}
            onRetry={() => setLoadAttempt((a) => a + 1)}
          />
        ) : !data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="h-28 bg-warm-gray-light/20 rounded-3xl animate-pulse motion-reduce:animate-none" />
              <div className="h-28 bg-warm-gray-light/20 rounded-3xl animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="h-24 bg-warm-gray-light/20 rounded-3xl animate-pulse motion-reduce:animate-none" />
          </div>
        ) : (
          <>
            {/* Modern Metrics Grid */}
            <div className="grid grid-cols-2 gap-4 animate-in-delay-1">
              <div className="bg-gradient-to-br from-white to-slate-50 rounded-3xl p-5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-slate-100 relative overflow-hidden group hover-lift transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-success/5 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110" />
                <p className="text-xs text-warm-gray uppercase tracking-widest font-medium mb-1">Tulot</p>
                <p className="text-2xl font-semibold text-success tracking-tight">{formatEur(data.income)}</p>
              </div>

              <div className="bg-gradient-to-br from-white to-slate-50 rounded-3xl p-5 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-slate-100 relative overflow-hidden group hover-lift transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-accent/5 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-110" />
                <p className="text-xs text-warm-gray uppercase tracking-widest font-medium mb-1">Menot</p>
                <p className="text-2xl font-semibold text-accent tracking-tight">{formatEur(data.expenses)}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 animate-in-delay-1">
              <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100 flex items-center justify-between hover-lift">
                <div>
                  <p className="text-xs text-warm-gray uppercase tracking-widest font-medium mb-1">Kuitteja</p>
                  {data.sectionErrors?.receipts ? (
                    <button type="button" className="text-left text-xs text-danger underline" onClick={() => setLoadAttempt((a) => a + 1)}>
                      {data.sectionErrors.receipts} Yritä uudelleen
                    </button>
                  ) : (
                    <p className="text-xl font-semibold text-charcoal">{data.receiptCount}</p>
                  )}
                </div>
                <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center text-slate-400">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                </div>
              </div>

              <div className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100 flex items-center justify-between hover-lift">
                <div>
                  <p className="text-xs text-warm-gray uppercase tracking-widest font-medium mb-1">ALV-arvio</p>
                  {data.sectionErrors?.vat ? (
                    <button type="button" className="text-left text-xs text-danger underline" onClick={() => setLoadAttempt((a) => a + 1)}>
                      {data.sectionErrors.vat} Yritä uudelleen
                    </button>
                  ) : (
                    <p className={`text-xl font-semibold ${data.isRefund ? "text-success" : "text-accent"}`}>
                      {data.isRefund ? "−" : ""}{formatEur(Math.abs(data.estimatedVat))}
                    </p>
                  )}
                  <p className="text-[10px] text-warm-gray mt-0.5 uppercase tracking-wide">{data.isRefund ? "palautettava" : "maksettava"}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 mt-2 animate-in-delay-2">
              <span className="relative flex h-2 w-2">
                {data.hasImap && <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-success opacity-40"></span>}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${data.hasImap ? 'bg-success' : 'bg-warm-gray'}`}></span>
              </span>
              <p className="text-xs text-warm-gray text-center">
                {data.source === "tiliote"
                  ? `Tiliotteen perusteella (${data.txCount} tapahtumaa)`
                  : "Kuitteihin perustuva näkymä — lataa tiliote"}
                {data.hasImap && " · Automaattinen tuonti aktiivinen"}
              </p>
            </div>

            {data.sectionErrors?.matching ? (
              <ErrorState
                compact
                message={data.sectionErrors.matching}
                onRetry={() => setLoadAttempt((a) => a + 1)}
              />
            ) : data.matching && data.matching.matchable > 0 && (
              <Link href="/tiliotteet" className="block mt-2 animate-in-delay-2">
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center justify-between hover:border-charcoal/20 transition-colors group">
                  <div>
                    <p className="text-sm font-semibold text-charcoal">Kuittien linkitys</p>
                    <p className="text-xs text-warm-gray mt-1">
                      {data.matching.matched} / {data.matching.matchable} tapahtumaa linkitetty
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {data.matching.matchable > data.matching.matched + data.matching.suggested ? (
                      <span className="bg-accent/10 text-accent text-xs font-medium px-2.5 py-1 rounded-full">
                        {data.matching.matchable - data.matching.matched - data.matching.suggested} puuttuu
                      </span>
                    ) : (
                      <span className="bg-success/10 text-success text-xs font-medium px-2.5 py-1 rounded-full">
                        Kaikki ok
                      </span>
                    )}
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-warm-gray group-hover:text-charcoal transition-colors">
                      <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
              </Link>
            )}

            {data.sectionErrors?.position && (
              <ErrorState
                compact
                message={data.sectionErrors.position}
                onRetry={() => setLoadAttempt((a) => a + 1)}
              />
            )}

            {data.sectionErrors?.threshold ? (
              <ErrorState
                compact
                message={data.sectionErrors.threshold}
                onRetry={() => setLoadAttempt((a) => a + 1)}
              />
            ) : !data.vat.registered && data.vat.ytdRevenue >= data.vat.threshold * 0.75 && (
              <div className={`rounded-2xl p-4 text-sm ${data.vat.ytdRevenue >= data.vat.threshold ? "bg-danger/10 text-danger border border-danger/20" : "bg-warning/10 text-charcoal border border-warning/20"}`}>
                <p className="font-semibold">{data.vat.ytdRevenue >= data.vat.threshold ? "ALV-raja ylittynyt" : "ALV-raja lähestyy"}</p>
                <p className="mt-1 leading-relaxed">
                  Liikevaihtosi tänä vuonna on {formatEur(data.vat.ytdRevenue)}. Raja on {formatEur(data.vat.threshold)}.
                  {data.vat.ytdRevenue >= data.vat.threshold ? " Rekisteröidy OmaVerossa heti." : " Rekisteröidy hyvissä ajoin."}
                </p>
              </div>
            )}
          </>
        )}

        <div className="grid grid-cols-2 gap-3 mt-4 animate-in-delay-2">
          <Link
            href="/kuitit/uusi"
            className="flex flex-col items-center justify-center gap-2 bg-charcoal text-white rounded-3xl p-5 hover:bg-black transition-all hover:-translate-y-1 hover:shadow-lg active-press"
          >
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            </div>
            <span className="text-sm font-medium">Uusi kuitti</span>
          </Link>
          
          <Link
            href="/tiliotteet"
            className="flex flex-col items-center justify-center gap-2 bg-white border-2 border-charcoal/5 text-charcoal rounded-3xl p-5 hover:bg-slate-50 transition-all hover:-translate-y-1 hover:shadow-lg active-press"
          >
            <div className="w-10 h-10 rounded-full bg-charcoal/5 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            </div>
            <span className="text-sm font-medium">Tiliote</span>
          </Link>
        </div>
        
      </div>
    </>
  );
}
