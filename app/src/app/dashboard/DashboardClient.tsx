"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { ErrorState, LoadingState } from "@/components/AsyncState";
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
    <AppShell>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-light text-charcoal">
            {displayName ? getGreeting(displayName) : "\u00a0"}
          </h2>
          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={() => {
                setLoadError("");
                setMonth(shiftMonth(month, -1));
              }}
              className="w-11 h-11 flex items-center justify-center rounded-xl bg-white shadow-sm text-charcoal hover:bg-blush/40 transition-colors"
              aria-label="Edellinen kuukausi"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <p className="text-sm text-warm-gray capitalize min-w-[130px] text-center">
              {monthName} {month.split("-")[0]}
            </p>
            <button
              type="button"
              onClick={() => {
                setLoadError("");
                setMonth(shiftMonth(month, 1));
              }}
              disabled={month >= currentMonth()}
              className="w-11 h-11 flex items-center justify-center rounded-xl bg-white shadow-sm text-charcoal hover:bg-blush/40 transition-colors disabled:opacity-30"
              aria-label="Seuraava kuukausi"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>
        </div>

        {loadError ? (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError("");
              setLoadAttempt((attempt) => attempt + 1);
            }}
          />
        ) : !data ? (
          <LoadingState label="Ladataan etusivun tietoja..." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <p className="text-xs text-warm-gray uppercase tracking-wider mb-1">
                  Tulot
                </p>
                <p className="text-xl font-medium text-success">
                  {formatEur(data.income)}
                </p>
              </div>

              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <p className="text-xs text-warm-gray uppercase tracking-wider mb-1">
                  Menot
                </p>
                <p className="text-xl font-medium text-accent">
                  {formatEur(data.expenses)}
                </p>
              </div>

              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <p className="text-xs text-warm-gray uppercase tracking-wider mb-1">
                  Kuitteja
                </p>
                <p className="text-xl font-medium text-charcoal">
                  {data.receiptCount}
                </p>
              </div>

              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <p className="text-xs text-warm-gray uppercase tracking-wider mb-1">
                  Arvioitu ALV
                </p>
                <p
                  className={`text-xl font-medium ${data.isRefund ? "text-success" : "text-accent"}`}
                >
                  {data.isRefund ? "−" : ""}
                  {formatEur(Math.abs(data.estimatedVat))}
                </p>
                <p className="text-xs text-warm-gray mt-0.5">
                  {data.isRefund ? "palautettava" : "maksettava"}
                </p>
              </div>
            </div>

            <p className="text-xs text-warm-gray text-center">
              {data.source === "tiliote"
                ? `Tulot ja menot tiliotteelta (${data.txCount} tapahtumaa)`
                : "Tulot ja menot kuiteista — lataa tiliote tarkempaan seurantaan"}
            </p>

            {data.matching && data.matching.matchable > 0 && (
              <p className="text-xs text-warm-gray text-center">
                Kuitti linkitetty {data.matching.matched}/
                {data.matching.matchable} tapahtumaan
                {data.matching.suggested > 0 &&
                  ` · ${data.matching.suggested} ehdotusta odottaa hyväksyntää`}
              </p>
            )}

            {!data.vat.registered &&
              data.vat.ytdRevenue >= data.vat.threshold * 0.75 && (
                <div
                  className={`rounded-2xl p-4 text-sm ${
                    data.vat.ytdRevenue >= data.vat.threshold
                      ? "bg-danger/10 text-danger"
                      : "bg-warning/10 text-charcoal"
                  }`}
                >
                  <p className="font-medium">
                    {data.vat.ytdRevenue >= data.vat.threshold
                      ? "ALV-raja ylittynyt"
                      : "ALV-raja lähestyy"}
                  </p>
                  <p className="mt-1">
                    Liikevaihtosi tänä vuonna on{" "}
                    {formatEur(data.vat.ytdRevenue)}. ALV-velvollisuuden raja
                    on {formatEur(data.vat.threshold)} kalenterivuodessa —{" "}
                    {data.vat.ytdRevenue >= data.vat.threshold
                      ? "rekisteröidy ALV-rekisteriin OmaVerossa heti."
                      : "seuraa tilannetta ja rekisteröidy hyvissä ajoin."}
                  </p>
                </div>
              )}
          </>
        )}

        <div className="grid grid-cols-1 gap-3">
          <Link
            href="/kuitit/uusi"
            className="bg-accent text-white rounded-2xl p-4 text-sm text-center font-medium hover:bg-accent-dark transition-colors shadow-sm"
          >
            + Lisää kuitti tai lasku
          </Link>
          <Link
            href="/tiliotteet"
            className="bg-white text-charcoal rounded-2xl p-4 text-sm text-center font-medium hover:bg-blush/30 transition-colors shadow-sm border border-warm-gray-light/30"
          >
            Lataa tiliote
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
